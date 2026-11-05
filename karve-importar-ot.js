// karve-importar-ot.js — Importación de Órdenes de Trabajo desde Karve (SOLO LECTURA en Karve, upsert en la tabla
// local `ot`). F3.6-01: para que el Tablero y los listados tengan O.T. reales sin traer las ~96.000 históricas.
//
// Qué se trae (kv_vOrdenesTrabajo):
//   - las O.T. "vivas": sin fechaCierre (en Karve el cierre es esa fecha; fechaAcabada no se usa) y con fecha;
//   - una muestra de las cerradas más recientes (TOP n por fechaCierre, sin fechas futuras), para la columna de cerradas.
//   Solo ids numéricos (hay 27 históricos con sufijo, p. ej. 0058757MO).
//
// Mapeo del estado de Karve (nomEstado) al estado local / fase del Kanban. Todas las vivas de Karve llevan operario,
// así que el trabajo pendiente va a 'asignada' (no a 'pendiente_asignacion'). Los estados sin nombre son históricos.
const ESTADO_LOCAL = {
  asignada:           ['HACER', 'URGENTE', 'MTO', 'MTO URGENTE', 'INSPECCION', 'GARANTIA', 'FURGO', 'TRANSPORTE', 'IN DATE', 'ENTRYLIST', 'M. STOP', 'PERSONAL', 'FORMACION', 'COMERCIAL'],
  pendiente_repuesto: ['RECAMBIOS', 'REC. URG.', 'ALMACEN', 'ALMACEN URG.', 'PROVEEDOR', 'RE. PEDIDO', 'RE.PE.URG', 'CONSULTADO REC.'],
  pausada:            ['PPTO', 'PPTO URG.', 'PDTE OK PPTO', 'PDTE. DICTAMEN'],      // a la espera del cliente (presupuesto, dictamen)
  en_curso:           ['S.A.T. EXTERNO'],                                            // en manos del SAT externo (sin técnico local → alcance gestor_sat)
  finalizada:         ['HECHO', 'PDTE ALBARAN'],
  pendiente_pedido:   ['PDTE Nº PEDIDO'],
  vb_factura:         ['Vº B FACT.', 'Vº B F. P.'],
};
// Cerrada en Karve (fechaCierre o anulada) → 'cerrada'. Estado desconocido → 'abierta' con aviso.
//
// Otros campos: prioridad alta si urgente o el estado es urgente (URG, M. STOP); tipo preventivo si mantenimiento o el
// albarán es de mantenimiento preventivo (mp, mpa, mpr); síntoma = avisos (texto corto de Karve) o la descripción breve;
// descripción = observaciones (+ anomalías); notas internas = tipo de albarán, persona de contacto, ubicación, referencia,
// presupuesto, pedido, factura. Técnico local solo si hay un usuario con ese código de operario (usuarios.karve_id);
// si no, el nombre del operario queda en ot.karve_operario y se muestra como referencia.
//
// Repeticiones: una O.T. ya importada y no tocada en la app (origen 'karve' y version 1) se actualiza con lo que diga
// Karve; si alguien la ha modificado aquí (version > 1) o la creó la app, se conserva y se cuenta como "conservada".
// Todo en una transacción; `simular: true` la deshace al final.

const { db, ahora } = require('./db');
const karve = require('./karve');

const LOCAL_POR_KARVE = new Map();
for (const [local, nombres] of Object.entries(ESTADO_LOCAL)) for (const n of nombres) LOCAL_POR_KARVE.set(n, local);
const ALBARANES_PREVENTIVO = new Set(['mp', 'mpa', 'mpr']);
const CERRADAS_DEFECTO = 150;
const CERRADAS_MAX = 2000;

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
  let estado;
  if (fechaCierre || Number(fila.anulada)) estado = 'cerrada';
  else {
    estado = LOCAL_POR_KARVE.get(nomEstado);
    if (!estado) { estado = 'abierta'; resumen.estados_desconocidos.add(nomEstado || '(sin estado)'); }
  }
  if (!mapas.estados.has(estado)) throw new Error(`El estado local "${estado}" no existe en la tabla estados`);

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
    cliente_id: clienteId, maquina_id: maquinaId, estado,
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

const CAMPOS_UPSERT = ['cliente_id', 'maquina_id', 'estado', 'prioridad', 'tipo', 'sintoma', 'descripcion', 'notas_internas', 'tecnico_id', 'creado', 'actualizado', 'karve_estado', 'karve_operario', 'fecha_prevista', 'fecha_cierre'];

function aplicar(datos, resumen, avisar) {
  const mapas = {
    clientes: new Map(db.prepare('SELECT karve_id, id FROM clientes WHERE karve_id IS NOT NULL').all().map((c) => [limpiar(c.karve_id), c.id])),
    maquinas: new Map(db.prepare('SELECT karve_id, id FROM maquinas WHERE karve_id IS NOT NULL').all().map((m) => [limpiar(m.karve_id), m.id])),
    tecnicos: new Map(db.prepare("SELECT karve_id, id FROM usuarios WHERE karve_id IS NOT NULL AND activo = 1 AND rol IN ('tecnico', 'sat')").all().map((u) => [limpiar(u.karve_id), u.id])),
    estados: new Set(db.prepare('SELECT codigo FROM estados WHERE activo = 1').all().map((e) => e.codigo)),
  };
  const selPorNumero = db.prepare(`SELECT id, origen, version, ${CAMPOS_UPSERT.join(', ')} FROM ot WHERE numero = ?`);
  const insOT = db.prepare(`INSERT INTO ot (numero, anio, secuencia, ${CAMPOS_UPSERT.join(', ')}, origen, creado_por, version)
                            VALUES (?, ?, ?, ${CAMPOS_UPSERT.map(() => '?').join(', ')}, 'karve', NULL, 1)`);
  const updOT = db.prepare(`UPDATE ot SET ${CAMPOS_UPSERT.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
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
        resumen.por_estado[t.estado] = (resumen.por_estado[t.estado] || 0) + 1;
        continue;
      }
      if (existente.origen !== 'karve' || existente.version !== 1) { r.conservadas++; continue; }
      const cambia = CAMPOS_UPSERT.some((c) => (existente[c] ?? null) !== (t[c] ?? null));
      if (!cambia) { r.sin_cambios++; continue; }
      updOT.run(...valores, existente.id);
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
  if (resumen.estados_desconocidos.size) avisar(`Estados de Karve sin mapeo (van a "Abierta"): ${[...resumen.estados_desconocidos].join(', ')}`);
}

async function importar({ entorno = 'copia', cerradas = CERRADAS_DEFECTO, origen = 'manual', usuarioId = null, simular = false } = {}) {
  if (enCurso) { const e = new Error('Ya hay una importación de O.T. en curso'); e.codigo = 'EN_CURSO'; throw e; }
  cerradas = Math.max(0, Math.min(CERRADAS_MAX, Number.parseInt(cerradas, 10) || 0));
  enCurso = true;
  const inicio = ahora();
  const t0 = Date.now();
  const contador = () => ({ leidas: 0, nuevas: 0, actualizadas: 0, sin_cambios: 0, conservadas: 0, sin_cliente: 0, sin_maquina: 0, omitidas_numero: 0 });
  const resumen = { entorno, origen, simulado: simular, cerradas_pedidas: cerradas, inicio, fin: null, duracion_ms: 0, vivas: contador(), cerradas: contador(), por_estado: {}, estados_desconocidos: new Set(), avisos: [] };
  const avisar = (t) => resumen.avisos.push(t);
  try {
    const datos = await leerKarve(entorno, cerradas);
    const tx = db.transaction(() => { aplicar(datos, resumen, avisar); if (simular) throw new Simulacion('simulación'); });
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

module.exports = { importar, estaEnCurso, ESTADO_LOCAL, CERRADAS_DEFECTO };
