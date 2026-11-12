// karve-importar-ot.js — Importación de Órdenes de Trabajo desde Karve (SOLO LECTURA en Karve, upsert en la tabla
// local `ot`). F3.6-01: para que el Tablero y los listados tengan O.T. reales sin traer las ~96.000 históricas.
//
// Qué se trae (kv_vOrdenesTrabajo):
//   - las O.T. "vivas": sin fechaCierre (en Karve el cierre es esa fecha; fechaAcabada no se usa) y con fecha;
//   - una muestra de las cerradas más recientes (TOP n por fechaCierre, sin fechas futuras), para la columna de cerradas.
//   Solo ids numéricos (hay 27 históricos con sufijo, p. ej. 0058757MO).
//
// Mapeo del estado de Karve (nomEstado) a la vertical del Tablero v2 + etiqueta (F4-04). Todas las vivas de Karve llevan
// operario, así que el trabajo pendiente va a 'planificada'. Los estados sin nombre son históricos.
const ESTADO_LOCAL = {
  'planificada':            ['HACER', 'URGENTE', 'MTO', 'MTO URGENTE', 'INSPECCION', 'GARANTIA', 'FURGO', 'TRANSPORTE', 'IN DATE', 'ENTRYLIST', 'M. STOP', 'PERSONAL', 'FORMACION', 'COMERCIAL'],
  'pausada:repuesto':       ['RECAMBIOS', 'REC. URG.', 'ALMACEN', 'ALMACEN URG.', 'PROVEEDOR', 'RE. PEDIDO', 'RE.PE.URG', 'CONSULTADO REC.'],
  'pausada:presupuesto':    ['PPTO', 'PPTO URG.', 'PDTE. DICTAMEN'],                 // a la espera del cliente (presupuesto, dictamen)
  'pausada:ok_presupuesto': ['PDTE OK PPTO'],
  'en_curso:sat_externo':   ['S.A.T. EXTERNO'],                                      // en manos del SAT externo (sin técnico local → alcance operativo)
  'finalizada':             ['HECHO'],
  'finalizada:albaran':     ['PDTE ALBARAN'],
  'pausada:num_pedido':     ['PDTE Nº PEDIDO'],
  'finalizada:vb_factura':  ['Vº B FACT.', 'Vº B F. P.'],
};
// Cerrada en Karve → 'cerrada' (etiqueta anulada si lo está). Estado desconocido → 'pendiente_planificar' con aviso.
//
// Prioridad: solo existe en la app (gerencia 2026-11-06). Al crear la O.T. se propone alta si Karve la marca urgente (URG,
// M. STOP); en las importaciones siguientes la prioridad no se toca. Tipo preventivo si mantenimiento o el
// albarán es de mantenimiento preventivo (mp, mpa, mpr); síntoma = avisos (texto corto de Karve) o la descripción breve;
// descripción = observaciones (+ anomalías); notas internas = tipo de albarán, persona de contacto, ubicación, referencia,
// presupuesto, pedido, factura. Técnico local solo si hay un usuario con ese código de operario (usuarios.karve_id);
// si no, el nombre del operario queda en ot.karve_operario y se muestra como referencia.
//
// Repeticiones: una O.T. ya importada y no tocada en la app (origen 'karve' y version 1) se actualiza con lo que diga
// Karve; si alguien la ha modificado aquí (version > 1) o la creó la app, se conserva y se cuenta como "conservada".
// Todo en una transacción; `simular: true` la deshace al final.
//
// F4-13: bloques automáticos en el Planificador. Tras importar, cada O.T. planificada, no tocada en la app y con técnico local
// (usuario con ese código de operario) recibe un bloque de 2 h con `origen = 'karve'`, sin subir su versión:
//   - si su fecha prevista es de hoy en adelante, ese día, detrás de lo que ya tenga el técnico;
//   - si la fecha prevista ya pasó (en Karve es casi siempre la fecha de alta: no hay horas previstas ni fechas futuras), se
//     reparte por capacidad: primer día laborable desde mañana en el que al técnico le queden 2 h de jornada, por prioridad y
//     antigüedad, hasta 20 días laborables; lo que no quepa se queda en la bandeja. `repartir: false` deja las vencidas en la bandeja.
//     El reparto **agrupa por zona** (Sendoa, 2026-11-12): cada O.T. va al primer día con hueco en el que el técnico no tenga
//     clientes de otra zona (día vacío o solo de su zona); si en los 20 días no hay ninguno así, al primer día con hueco aunque
//     mezcle zonas (se cuenta en `zonas_mezcladas` y el Planificador lo avisa). Una O.T. sin zona cabe en cualquier día.
//     `recolocar: true` quita primero los bloques automáticos repartidos de las O.T. no tocadas y los vuelve a repartir.
// Mientras la O.T. siga sin tocar, la importación mantiene su bloque automático: lo quita si deja de estar planificada, cambia
// de operario o de fecha, o si el bloque ya ha pasado sin empezarse (y la vuelve a colocar). Un bloque movido a mano o una O.T.
// tocada en la app ya no se tocan. Las planificadas de operarios genéricos (TALLER, MANTENIMIENTOS…) no tienen técnico: bandeja.

const { db, ahora } = require('./db');
const karve = require('./karve');
const plan = require('./rutas-planificador');

const LOCAL_POR_KARVE = new Map();
for (const [local, nombres] of Object.entries(ESTADO_LOCAL)) for (const n of nombres) LOCAL_POR_KARVE.set(n, local);
const ALBARANES_PREVENTIVO = new Set(['mp', 'mpa', 'mpr']);
const CERRADAS_DEFECTO = 150;
const CERRADAS_MAX = 2000;
const HORIZONTE_LABORABLES = 20;   // F4-13: hasta cuántos días laborables se reparten las O.T. con la fecha prevista vencida

const COLUMNAS = 'id, fecha, hora, fechaPrevista, horaPrevista, cliente, maquina, operarioAsignado, nomOperarioAsignado, fechaAsignacion, urgente, mantenimiento, tipoAlbaran, nomTipoAlbaran, nomEstado, avisos, descripcionBreve, observaciones, anomaliasDetectadas, persona, ubicacion, referencia, presupuesto, pedidoCliente, fechaCierre, factura, anulada';

const limpiar = (v) => { if (v === null || v === undefined) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; };
const limpiarParrafos = (v) => { if (v === null || v === undefined) return null; const s = String(v).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(); return s || null; };
const recortar = (s, max) => (s && s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);
const fechaLocal = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const fechaHora = (fecha, hora, defecto = '08:00') => {
  const f = fechaLocal(fecha);
  if (!f) return null;
  const h = limpiar(hora);
  return `${f} ${h && /^\d{2}:\d{2}/.test(h) ? h.slice(0, 5) : defecto}:00`;
};
const normalizarEstado = (v) => (limpiar(v) || '').toUpperCase();

let enCurso = false;
const estaEnCurso = () => enCurso;
class Simulacion extends Error {}

async function leerKarve(entorno, cerradas) {
  const c = await karve.conectar(entorno);
  try {
    const q = async (sql) => (await karve.consultar(sql, [], { conexion: c })).filas;
    const vivas = await q(`SELECT ${COLUMNAS} FROM CV.kv_vOrdenesTrabajo WHERE fechaCierre IS NULL AND fecha IS NOT NULL AND ISNUMERIC(id) = 1 ORDER BY fecha, id`);
    const recientes = cerradas > 0
      ? await q(`SELECT TOP ${cerradas} ${COLUMNAS} FROM CV.kv_vOrdenesTrabajo WHERE fechaCierre IS NOT NULL AND fechaCierre <= CURRENT DATE AND ISNUMERIC(id) = 1 ORDER BY fechaCierre DESC, id DESC`)
      : [];
    return { vivas, cerradas: recientes };
  } finally {
    await c.close();
  }
}

// Traduce una fila de Karve a los campos de la tabla `ot`. Devuelve null (con el motivo) si no se puede importar.
function traducir(fila, mapas, resumen, grupo) {
  const r = resumen[grupo];
  const id = limpiar(fila.id);
  if (!id || !/^\d{1,10}$/.test(id)) { r.omitidas_numero++; return null; }
  const numero = id.padStart(10, '0');
  const clienteId = mapas.clientes.get(limpiar(fila.cliente));
  if (!clienteId) { r.sin_cliente++; return null; }
  const codigoMaquina = limpiar(fila.maquina);
  const maquinaId = codigoMaquina ? mapas.maquinas.get(codigoMaquina) ?? null : null;
  if (codigoMaquina && !maquinaId) r.sin_maquina++;
  const creado = fechaHora(fila.fecha, fila.hora);
  if (!creado) { r.omitidas_numero++; return null; }

  const nomEstado = normalizarEstado(fila.nomEstado);
  const fechaCierre = fechaLocal(fila.fechaCierre);
  let estado, etiqueta = null;
  if (fechaCierre || Number(fila.anulada)) { estado = 'cerrada'; etiqueta = Number(fila.anulada) ? 'anulada' : null; }
  else {
    const clave = LOCAL_POR_KARVE.get(nomEstado);
    if (clave) [estado, etiqueta = null] = clave.split(':');
    else { estado = 'pendiente_planificar'; resumen.estados_desconocidos.add(nomEstado || '(sin estado)'); }
  }
  if (!mapas.estados.has(estado)) throw new Error(`El estado local "${estado}" no existe en la tabla estados`);
  if (etiqueta && !mapas.etiquetas.has(etiqueta)) throw new Error(`La etiqueta "${etiqueta}" no existe en la tabla etiquetas`);

  const urgente = Number(fila.urgente) === 1 || /URG|STOP/.test(nomEstado);
  const albaran = (limpiar(fila.tipoAlbaran) || '').toLowerCase();
  const tipo = Number(fila.mantenimiento) === 1 || ALBARANES_PREVENTIVO.has(albaran) ? 'preventivo' : 'correctivo';
  const observaciones = limpiarParrafos(fila.observaciones);
  const anomalias = limpiarParrafos(fila.anomaliasDetectadas);
  const sintoma = recortar(limpiar(fila.avisos) || limpiar(fila.descripcionBreve) || limpiar(observaciones), 200);
  const descripcion = recortar([observaciones, anomalias ? `Anomalías detectadas: ${anomalias}` : null].filter(Boolean).join('\n\n') || null, 4000);
  const notas = recortar([
    limpiar(fila.nomTipoAlbaran) ? `Tipo en Karve: ${limpiar(fila.nomTipoAlbaran)}` : null,
    limpiar(fila.persona) ? `Persona de contacto: ${limpiar(fila.persona)}` : null,
    limpiar(fila.ubicacion) ? `Ubicación: ${limpiar(fila.ubicacion)}` : null,
    limpiar(fila.referencia) ? `Referencia: ${limpiar(fila.referencia)}` : null,
    limpiar(fila.presupuesto) ? `Presupuesto: ${limpiar(fila.presupuesto)}` : null,
    limpiar(fila.pedidoCliente) ? `Pedido del cliente: ${limpiar(fila.pedidoCliente)}` : null,
    limpiar(fila.factura) ? `Factura: ${limpiar(fila.factura)}` : null,
  ].filter(Boolean).join('\n') || null, 4000);
  const operario = limpiar(fila.operarioAsignado);
  const fechaAsignacion = fechaLocal(fila.fechaAsignacion);
  return {
    numero, anio: Number(creado.slice(0, 4)), secuencia: Number(numero),
    cliente_id: clienteId, maquina_id: maquinaId, estado, etiqueta,
    prioridad: urgente ? 1 : 2, tipo, origen: 'karve',
    sintoma, descripcion, notas_internas: notas,
    tecnico_id: operario ? mapas.tecnicos.get(operario) ?? null : null,
    creado,
    actualizado: fechaCierre ? `${fechaCierre} 00:00:00` : fechaAsignacion ? `${fechaAsignacion} 00:00:00` : null,
    karve_estado: nomEstado || null,
    karve_operario: limpiar(fila.nomOperarioAsignado) || operario,
    fecha_prevista: fechaLocal(fila.fechaPrevista),
    fecha_cierre: fechaCierre,
  };
}

// La prioridad solo entra al crear (después es de la app); el resto se actualiza mientras la O.T. no se haya tocado aquí.
const CAMPOS_UPDATE = ['cliente_id', 'maquina_id', 'estado', 'etiqueta', 'tipo', 'sintoma', 'descripcion', 'notas_internas', 'tecnico_id', 'creado', 'actualizado', 'karve_estado', 'karve_operario', 'fecha_prevista', 'fecha_cierre'];
const CAMPOS_UPSERT = [...CAMPOS_UPDATE, 'prioridad'];

function aplicar(datos, resumen, avisar) {
  const mapas = {
    clientes: new Map(db.prepare('SELECT karve_id, id FROM clientes WHERE karve_id IS NOT NULL').all().map((c) => [limpiar(c.karve_id), c.id])),
    maquinas: new Map(db.prepare('SELECT karve_id, id FROM maquinas WHERE karve_id IS NOT NULL').all().map((m) => [limpiar(m.karve_id), m.id])),
    tecnicos: new Map(db.prepare("SELECT karve_id, id FROM usuarios WHERE karve_id IS NOT NULL AND activo = 1 AND rol IN ('tecnico', 'sat')").all().map((u) => [limpiar(u.karve_id), u.id])),
    estados: new Set(db.prepare('SELECT codigo FROM estados WHERE activo = 1').all().map((e) => e.codigo)),
    etiquetas: new Set(db.prepare('SELECT codigo FROM etiquetas WHERE activo = 1').all().map((e) => e.codigo)),
  };
  const selPorNumero = db.prepare(`SELECT id, origen, version, ${CAMPOS_UPSERT.join(', ')} FROM ot WHERE numero = ?`);
  const insOT = db.prepare(`INSERT INTO ot (numero, anio, secuencia, ${CAMPOS_UPSERT.join(', ')}, origen, creado_por, version)
                            VALUES (?, ?, ?, ${CAMPOS_UPSERT.map(() => '?').join(', ')}, 'karve', NULL, 1)`);
  const updOT = db.prepare(`UPDATE ot SET ${CAMPOS_UPDATE.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
  const insHist = db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, NULL, ?, ?)');
  const vistos = new Set();

  const procesar = (filas, grupo) => {
    const r = resumen[grupo];
    for (const fila of filas) {
      r.leidas++;
      const t = traducir(fila, mapas, resumen, grupo);
      if (!t) continue;
      if (vistos.has(t.numero)) continue;
      vistos.add(t.numero);
      const valores = CAMPOS_UPSERT.map((c) => t[c]);
      const existente = selPorNumero.get(t.numero);
      const etiqueta = `${t.karve_estado || 'sin estado'}${t.karve_operario ? ' · ' + t.karve_operario : ''}`;
      if (!existente) {
        const info = insOT.run(t.numero, t.anio, t.secuencia, ...valores);
        insHist.run(info.lastInsertRowid, null, t.estado, t.creado, `Importada de Karve (${etiqueta})`);
        r.nuevas++;
        const claveEstado = t.etiqueta ? `${t.estado}:${t.etiqueta}` : t.estado;
        resumen.por_estado[claveEstado] = (resumen.por_estado[claveEstado] || 0) + 1;
        continue;
      }
      if (existente.origen !== 'karve' || existente.version !== 1) { r.conservadas++; continue; }
      const cambia = CAMPOS_UPDATE.some((c) => (existente[c] ?? null) !== (t[c] ?? null));
      if (!cambia) { r.sin_cambios++; continue; }
      updOT.run(...CAMPOS_UPDATE.map((c) => t[c]), existente.id);
      if (existente.estado !== t.estado) insHist.run(existente.id, existente.estado, t.estado, ahora(), `Actualizada desde Karve (${etiqueta})`);
      r.actualizadas++;
    }
  };
  procesar(datos.vivas, 'vivas');
  procesar(datos.cerradas, 'cerradas');

  for (const g of ['vivas', 'cerradas']) {
    const r = resumen[g];
    if (r.sin_cliente) avisar(`${r.sin_cliente} O.T. ${g} sin cliente en la base local (¿falta sincronizar clientes?): omitidas`);
    if (r.sin_maquina) avisar(`${r.sin_maquina} O.T. ${g} con una máquina que no está en la base local: importadas sin máquina`);
    if (r.omitidas_numero) avisar(`${r.omitidas_numero} O.T. ${g} con número o fecha no válidos: omitidas`);
    if (r.conservadas) avisar(`${r.conservadas} O.T. ${g} ya modificadas en la aplicación: se conservan tal cual`);
  }
  if (resumen.estados_desconocidos.size) avisar(`Estados de Karve sin mapeo (van a "Pendiente de planificar"): ${[...resumen.estados_desconocidos].join(', ')}`);
}

// ---------------------------------------------------------------------------
// F4-13: bloques automáticos para las O.T. planificadas, no tocadas y con técnico. Dentro de la transacción de la importación.
// ---------------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, '0');
const fechaISO = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
function laborablesDesde(iso, n) {          // los n días laborables siguientes a `iso` (sin contarlo)
  const [a, m, d] = iso.split('-').map(Number);
  const f = new Date(a, m - 1, d);
  const dias = [];
  while (dias.length < n) { f.setDate(f.getDate() + 1); if (f.getDay() !== 0 && f.getDay() !== 6) dias.push(fechaISO(f)); }
  return dias;
}

function planificarAutomaticas(r, { repartir = true, recolocar = false, hoy = fechaISO(new Date()) } = {}) {
  const duracion = plan.DURACION_DEFECTO;
  const capacidad = plan.JORNADA.horas_dia * 60;

  // 1) Bloques automáticos de O.T. no tocadas que ya no valen: se quitan (si la O.T. sigue siendo candidata, se recoloca abajo).
  const autos = db.prepare(`
    SELECT b.id, b.tecnico_id, b.dia, o.estado, o.tecnico_id AS ot_tecnico, o.fecha_prevista, u.activo
      FROM ot_bloques b JOIN ot o ON o.id = b.ot_id JOIN usuarios u ON u.id = b.tecnico_id
     WHERE b.origen = 'karve' AND o.origen = 'karve' AND o.version = 1`).all();
  const borrar = db.prepare('DELETE FROM ot_bloques WHERE id = ?');
  for (const a of autos) {
    const enSuFecha = !(a.fecha_prevista && a.fecha_prevista >= hoy && a.dia !== a.fecha_prevista);
    const vencida = !(a.fecha_prevista && a.fecha_prevista >= hoy);
    const vale = a.estado === 'planificada' && a.ot_tecnico === a.tecnico_id && a.activo === 1 && a.dia >= hoy && enSuFecha && !(recolocar && vencida);
    if (!vale) { borrar.run(a.id); r.quitados++; }
  }

  // 2) Candidatas: planificadas de Karve, no tocadas, con técnico activo y sin ningún bloque.
  const candidatas = db.prepare(`
    SELECT o.id, o.estado, o.tecnico_id, o.fecha_prevista, c.zona
      FROM ot o JOIN usuarios u ON u.id = o.tecnico_id AND u.activo = 1 AND u.rol IN ('tecnico', 'sat')
      JOIN clientes c ON c.id = o.cliente_id
     WHERE o.origen = 'karve' AND o.version = 1 AND o.estado = 'planificada'
       AND NOT EXISTS (SELECT 1 FROM ot_bloques b WHERE b.ot_id = o.id)
     ORDER BY o.prioridad, COALESCE(o.fecha_prevista, '9999'), o.id`).all();
  const dias = laborablesDesde(hoy, HORIZONTE_LABORABLES);
  const puntero = new Map();               // por técnico: primer día del reparto en el que aún puede caber algo
  const lleno = (h) => h.ocupado_min + duracion > capacidad;
  // Primero las que tienen fecha: ocupan su día. Después el reparto de las vencidas rellena lo que quede libre.
  const conFecha = candidatas.filter((ot) => ot.fecha_prevista && ot.fecha_prevista >= hoy);
  for (const ot of conFecha) {
    const h = plan.huecoPara(ot.tecnico_id, ot.fecha_prevista, duracion);
    plan.crearBloqueAutomatico(ot, { tecnico_id: ot.tecnico_id, dia: ot.fecha_prevista, hora_inicio: h.hora_inicio, duracion_min: duracion });
    r.en_fecha++;
  }
  for (const ot of candidatas) {
    if (ot.fecha_prevista && ot.fecha_prevista >= hoy) continue;
    if (!repartir) { r.sin_repartir++; continue; }
    let i = puntero.get(ot.tecnico_id) || 0;
    while (i < dias.length && lleno(plan.huecoPara(ot.tecnico_id, dias[i], duracion))) i++;
    puntero.set(ot.tecnico_id, i);
    // Agrupar por zona: primer día con hueco en el que el técnico no tenga clientes de otra zona; si no hay, el primero con hueco.
    let compatible = null;
    let primero = null;
    for (let k = i; k < dias.length && !compatible; k++) {
      const h = plan.huecoPara(ot.tecnico_id, dias[k], duracion);
      if (lleno(h)) continue;
      if (!primero) primero = { dia: dias[k], h };
      if (!ot.zona || h.zonas.every((z) => z === ot.zona)) compatible = { dia: dias[k], h };
    }
    const destino = compatible || primero;
    if (!destino) { r.sin_hueco++; continue; }
    if (!compatible) r.zonas_mezcladas++;
    plan.crearBloqueAutomatico(ot, { tecnico_id: ot.tecnico_id, dia: destino.dia, hora_inicio: destino.h.hora_inicio, duracion_min: duracion });
    r.repartidas++;
  }
  r.sin_tecnico = db.prepare("SELECT COUNT(*) AS n FROM ot WHERE origen = 'karve' AND version = 1 AND estado = 'planificada' AND tecnico_id IS NULL").get().n;
  return r;
}

async function importar({ entorno = 'copia', cerradas = CERRADAS_DEFECTO, origen = 'manual', usuarioId = null, simular = false, bloques = true, repartir = true, recolocar = false } = {}) {
  if (enCurso) { const e = new Error('Ya hay una importación de O.T. en curso'); e.codigo = 'EN_CURSO'; throw e; }
  cerradas = Math.max(0, Math.min(CERRADAS_MAX, Number.parseInt(cerradas, 10) || 0));
  enCurso = true;
  const inicio = ahora();
  const t0 = Date.now();
  const contador = () => ({ leidas: 0, nuevas: 0, actualizadas: 0, sin_cambios: 0, conservadas: 0, sin_cliente: 0, sin_maquina: 0, omitidas_numero: 0 });
  const resumen = { entorno, origen, simulado: simular, cerradas_pedidas: cerradas, inicio, fin: null, duracion_ms: 0, vivas: contador(), cerradas: contador(), por_estado: {}, estados_desconocidos: new Set(), avisos: [],
    bloques: { activo: bloques, repartir, recolocar, en_fecha: 0, repartidas: 0, quitados: 0, sin_hueco: 0, sin_repartir: 0, sin_tecnico: 0, zonas_mezcladas: 0 } };
  const avisar = (t) => resumen.avisos.push(t);
  try {
    const datos = await leerKarve(entorno, cerradas);
    const tx = db.transaction(() => {
      aplicar(datos, resumen, avisar);
      if (bloques) {
        planificarAutomaticas(resumen.bloques, { repartir, recolocar });
        if (resumen.bloques.sin_hueco) avisar(`${resumen.bloques.sin_hueco} O.T. planificadas no caben en los próximos ${HORIZONTE_LABORABLES} días laborables de su técnico: se quedan en la bandeja del Planificador`);
      }
      if (simular) throw new Simulacion('simulación');
    });
    try { tx(); } catch (e) { if (!(e instanceof Simulacion)) throw e; }
    resumen.estados_desconocidos = [...resumen.estados_desconocidos];
    resumen.fin = ahora();
    resumen.duracion_ms = Date.now() - t0;
    if (!simular) db.prepare('INSERT INTO sincronizaciones (inicio, fin, origen, usuario_id, estado, resumen) VALUES (?, ?, ?, ?, ?, ?)').run(inicio, resumen.fin, `ot-${origen}`, usuarioId, 'ok', JSON.stringify(resumen));
    return resumen;
  } catch (e) {
    resumen.estados_desconocidos = [...resumen.estados_desconocidos];
    const mensaje = karve.describirError(e);
    if (!simular) db.prepare('INSERT INTO sincronizaciones (inicio, fin, origen, usuario_id, estado, resumen, mensaje) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inicio, ahora(), `ot-${origen}`, usuarioId, 'error', JSON.stringify(resumen), mensaje);
    const err = new Error(mensaje);
    err.codigo = e.codigo || 'KARVE';
    throw err;
  } finally {
    enCurso = false;
  }
}

module.exports = { importar, estaEnCurso, planificarAutomaticas, laborablesDesde, ESTADO_LOCAL, CERRADAS_DEFECTO, HORIZONTE_LABORABLES };
