// fichajes.js — Jornadas, O.T. comodín (F4-07) e incidencias de fichaje (F4-08). Solo lógica y consultas; las rutas están en
// rutas-fichajes.js y el cronómetro por tramos, en tiempos.js.
//
// O.T. comodín (decisión de gerencia, 2026-11-02): una por técnico y mes. Recoge las horas que no van a la O.T. de un cliente
// (taller, formación, sin trabajo asignado...). Es una fila de `comodines` (se crea sola la primera vez que el técnico imputa
// algo ese mes) y sus tramos van a `ot_tiempos` con `comodin_id` + `concepto` y tipo 'comodin': mismo cronómetro, mismo
// resumen de horas y mismas correcciones que los tramos de una O.T.
//
// Jornada: por técnico y día se suma lo fichado (desplazamiento, espera de acceso, trabajo y comodín) y se compara con
// `PLANIFICADOR_HORAS_DIA` (8 h). Un tramo cuenta en el día en que empieza. Se avisa de los días laborables (lunes a viernes;
// no hay calendario de festivos ni de ausencias) ya pasados, del rol `tecnico` y posteriores a su primer fichaje, que no
// llegan: `bajo` (algo fichado) o `sin_fichar` (nada). El SAT externo ficha, pero no tiene jornada que justificar.
//
// Incidencias de fichaje: el técnico no edita lo fichado; pide una corrección (modificar un tramo, añadir uno que falta o quitar
// uno que sobra) con su motivo. La oficina con `fichajes.gestionar` la aprueba (se aplica y el tramo queda con origen 'manual')
// o la rechaza (con respuesta). Si la corrección la hace la propia oficina, es una incidencia que nace aprobada: el rastro es
// el mismo. `antes` y `propuesta` guardan cómo estaba el tramo y cómo se pidió dejarlo.

const { db, ahora } = require('./db');
const { ErrorHttp, texto, entero, enumerado } = require('./validar');
const tiempos = require('./tiempos');
const { JORNADA } = require('./rutas-planificador');

const ACCIONES = ['modificar', 'anadir', 'quitar'];
const NOMBRE_ACCION = { modificar: 'Corregir', anadir: 'Añadir', quitar: 'Quitar' };
const ESTADOS = ['pendiente', 'aprobada', 'rechazada', 'anulada'];
const DIAS_AVISO = 7;          // el técnico ve en "Mi día" los días laborables de la última semana que no llegan a la jornada
const RANGO_MAX = 62;          // días que admite una consulta de jornadas
const INCIDENCIAS_MAX = 200;
const SEG = tiempos.SEGUNDOS;

const dos = (n) => String(n).padStart(2, '0');
const fechaISO = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const aFecha = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d); };
function esFecha(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return fechaISO(aFecha(s)) === s;
}
const esMes = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const esHora = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const sumarDias = (iso, n) => { const f = aFecha(iso); f.setDate(f.getDate() + n); return fechaISO(f); };
const esLaborable = (iso) => { const d = aFecha(iso).getDay(); return d !== 0 && d !== 6; };
const finDeMes = (mes) => { const [a, m] = mes.split('-').map(Number); return fechaISO(new Date(a, m, 0)); };
const objetivoSeg = () => Math.round(JORNADA.horas_dia * 3600);
const horaDe = (fechaHora) => fechaHora.slice(11, 16);
const diaCorto = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

const TRAMO_CAMPOS = `
  t.id, t.ot_id, o.numero, c.nombre AS cliente_nombre, t.comodin_id, t.concepto, cc.nombre AS concepto_nombre, t.tecnico_id, t.tipo,
  t.inicio, t.fin, t.cierre, t.origen, t.revisar, t.nota, t.incidencia_id`;
const TRAMO_DESDE = `
  FROM ot_tiempos t
  LEFT JOIN ot o ON o.id = t.ot_id
  LEFT JOIN clientes c ON c.id = o.cliente_id
  LEFT JOIN comodin_conceptos cc ON cc.codigo = t.concepto`;
const INCIDENCIA_SELECT = `
  SELECT i.*, ut.nombre AS tecnico_nombre, us.nombre AS solicitante_nombre, ur.nombre AS resuelto_por_nombre, o.numero AS ot_numero
    FROM incidencias i
    JOIN usuarios ut ON ut.id = i.tecnico_id
    JOIN usuarios us ON us.id = i.solicitante_id
    LEFT JOIN usuarios ur ON ur.id = i.resuelto_por
    LEFT JOIN ot o ON o.id = i.ot_id`;

const stmt = {
  // Comodín
  comodin: db.prepare('SELECT * FROM comodines WHERE tecnico_id = ? AND mes = ?'),
  crearComodin: db.prepare('INSERT INTO comodines (tecnico_id, mes, codigo) VALUES (?, ?, ?)'),
  conceptos: db.prepare('SELECT codigo, nombre, pide_nota, ausencia FROM comodin_conceptos WHERE activo = 1 ORDER BY orden, nombre'),
  concepto: db.prepare('SELECT codigo, nombre, pide_nota, ausencia FROM comodin_conceptos WHERE codigo = ? AND activo = 1'),
  comodinSeg: db.prepare(`
    SELECT COALESCE(SUM(${SEG('COALESCE(fin, @ahora)', 'inicio')}), 0) AS mes,
           COALESCE(SUM(CASE WHEN substr(inicio, 1, 10) = @dia THEN ${SEG('COALESCE(fin, @ahora)', 'inicio')} ELSE 0 END), 0) AS dia
      FROM ot_tiempos WHERE comodin_id = @comodin`),
  // Jornadas
  tecnico: db.prepare("SELECT id, nombre, rol, activo FROM usuarios WHERE id = ? AND rol IN ('tecnico', 'sat')"),
  tecnicos: db.prepare(`
    SELECT u.id, u.nombre, u.rol, u.activo FROM usuarios u
     WHERE u.rol IN ('tecnico', 'sat') AND (u.activo = 1 OR EXISTS (SELECT 1 FROM ot_tiempos x WHERE x.tecnico_id = u.id AND x.inicio >= ? AND x.inicio < ?))
     ORDER BY (u.rol = 'sat'), u.nombre COLLATE NOCASE`),
  primerFichaje: db.prepare('SELECT tecnico_id, MIN(substr(inicio, 1, 10)) AS dia FROM ot_tiempos GROUP BY tecnico_id'),
  porDia: db.prepare(`
    SELECT tecnico_id, substr(inicio, 1, 10) AS dia, tipo, COALESCE(SUM(${SEG('COALESCE(fin, @ahora)', 'inicio')}), 0) AS s,
           COUNT(*) AS n, COALESCE(SUM(revisar), 0) AS revisar, COALESCE(SUM(fin IS NULL), 0) AS abiertos, COALESCE(SUM(origen = 'manual'), 0) AS manuales
      FROM ot_tiempos
     WHERE inicio >= @desde AND inicio < @hasta AND (@tecnico IS NULL OR tecnico_id = @tecnico)
     GROUP BY tecnico_id, dia, tipo`),
  pendientesPorDia: db.prepare("SELECT tecnico_id, dia, COUNT(*) AS n FROM incidencias WHERE estado = 'pendiente' AND dia >= ? AND dia <= ? GROUP BY tecnico_id, dia"),
  tramosDia: db.prepare(`
    SELECT ${TRAMO_CAMPOS}, ${SEG('COALESCE(t.fin, @ahora)', 't.inicio')} AS segundos,
           (SELECT i.id FROM incidencias i WHERE i.tramo_id = t.id AND i.estado = 'pendiente' LIMIT 1) AS incidencia_pendiente
      ${TRAMO_DESDE}
     WHERE t.tecnico_id = @tecnico AND t.inicio >= @desde AND t.inicio < @hasta
     ORDER BY t.inicio, t.id`),
  otsImputables: db.prepare(`
    SELECT o.id, o.numero, o.estado, c.nombre AS cliente_nombre,
           EXISTS (SELECT 1 FROM ot_bloques b WHERE b.ot_id = o.id AND b.tecnico_id = @t AND b.dia = @d) AS con_bloque
      FROM ot o JOIN clientes c ON c.id = o.cliente_id
     WHERE o.id IN (SELECT ot_id FROM ot_bloques WHERE tecnico_id = @t AND dia = @d)
        OR o.id IN (SELECT ot_id FROM ot_tiempos WHERE tecnico_id = @t AND ot_id IS NOT NULL AND inicio >= @antes AND inicio < @despues)
        OR (o.tecnico_id = @t AND o.estado = 'en_curso')
     ORDER BY con_bloque DESC, o.numero DESC LIMIT 40`),
  puedeImputar: db.prepare(`
    SELECT 1 FROM ot o WHERE o.id = @ot AND (o.tecnico_id = @t
       OR EXISTS (SELECT 1 FROM ot_bloques b WHERE b.ot_id = o.id AND b.tecnico_id = @t)
       OR EXISTS (SELECT 1 FROM ot_tiempos x WHERE x.ot_id = o.id AND x.tecnico_id = @t))`),
  ot: db.prepare('SELECT id, numero, estado FROM ot WHERE id = ?'),
  otPorNumero: db.prepare('SELECT id, numero, estado FROM ot WHERE numero = ?'),
  bloqueDelDia: db.prepare('SELECT id FROM ot_bloques WHERE ot_id = ? AND tecnico_id = ? AND dia = ? ORDER BY hora_inicio, id LIMIT 1'),
  // Tramos e incidencias
  tramo: db.prepare(`SELECT ${TRAMO_CAMPOS} ${TRAMO_DESDE} WHERE t.id = ?`),
  solape: db.prepare(`
    SELECT ${TRAMO_CAMPOS} ${TRAMO_DESDE}
     WHERE t.tecnico_id = @tecnico AND t.id <> @excepto
       AND substr(t.inicio, 1, 16) < @fin AND substr(COALESCE(t.fin, @ahora), 1, 16) > @inicio
     ORDER BY t.inicio LIMIT 1`),
  pendienteDeTramo: db.prepare("SELECT id FROM incidencias WHERE tramo_id = ? AND estado = 'pendiente' LIMIT 1"),
  crearIncidencia: db.prepare(`
    INSERT INTO incidencias (tecnico_id, solicitante_id, accion, tramo_id, ot_id, dia, motivo, antes, propuesta, creado)
    VALUES (@tecnico_id, @solicitante_id, @accion, @tramo_id, @ot_id, @dia, @motivo, @antes, @propuesta, @creado)`),
  incidencia: db.prepare(`${INCIDENCIA_SELECT} WHERE i.id = ?`),
  resolver: db.prepare("UPDATE incidencias SET estado = ?, resuelto_por = ?, resuelto = ?, respuesta = ?, tramo_id = ? WHERE id = ? AND estado = 'pendiente'"),
  insertarTramo: db.prepare(`
    INSERT INTO ot_tiempos (ot_id, comodin_id, tecnico_id, bloque_id, tipo, concepto, inicio, fin, cierre, origen, revisar, incidencia_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', 0, ?)`),
  corregirTramo: db.prepare("UPDATE ot_tiempos SET tipo = ?, concepto = ?, inicio = ?, fin = ?, origen = 'manual', revisar = 0, incidencia_id = ? WHERE id = ?"),
  quitarTramo: db.prepare('DELETE FROM ot_tiempos WHERE id = ?'),
  historial: db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)'),
  nPendientes: db.prepare("SELECT COUNT(*) AS n FROM incidencias WHERE estado = 'pendiente'"),
  nPendientesDe: db.prepare("SELECT COUNT(*) AS n FROM incidencias WHERE estado = 'pendiente' AND tecnico_id = ?"),
  firma: db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(estado = 'pendiente'), 0) AS p, COALESCE(MAX(resuelto), '') AS m FROM incidencias"),
};

// ---------------------------------------------------------------------------
// Comodín
// ---------------------------------------------------------------------------
const codigoComodin = (tecnicoId, mes) => `CM-${mes.replace('-', '')}-${String(tecnicoId).padStart(3, '0')}`;

// El comodín del técnico para ese mes; lo crea si aún no existe (la primera vez que imputa algo).
function asegurarComodin(tecnicoId, mes) {
  if (!esMes(mes)) throw new ErrorHttp(400, 'El mes debe ser AAAA-MM');
  const c = stmt.comodin.get(tecnicoId, mes);
  if (c) return c;
  stmt.crearComodin.run(tecnicoId, mes, codigoComodin(tecnicoId, mes));
  return stmt.comodin.get(tecnicoId, mes);
}

// Todos los conceptos activos. Los de ausencia (vacaciones, baja, festivo) no se fichan con el cronómetro: se imputan al día
// con una corrección ("añadir tiempo"), del técnico o de la oficina, y pueden ser de hoy entero o de un día que aún no ha llegado.
const conceptos = () => stmt.conceptos.all();
const conceptosCrono = () => conceptos().filter((c) => !c.ausencia);

function conceptoValido(codigo) {
  const c = codigo ? stmt.concepto.get(String(codigo)) : null;
  if (!c) throw new ErrorHttp(400, `"concepto" debe ser uno de: ${conceptos().map((x) => x.codigo).join(', ')}`);
  return c;
}

// Lo que la tablet necesita del comodín: su código, lo imputado en el mes y en el día, y los conceptos para elegir.
function comodinPublico(tecnicoId, mes, dia) {
  const c = stmt.comodin.get(tecnicoId, mes);
  const s = c ? stmt.comodinSeg.get({ ahora: ahora(), dia, comodin: c.id }) : { mes: 0, dia: 0 };
  return { mes, codigo: codigoComodin(tecnicoId, mes), creado: c ? 1 : 0, mes_seg: s.mes, dia_seg: s.dia, conceptos: conceptosCrono() };
}

// ---------------------------------------------------------------------------
// Jornadas
// ---------------------------------------------------------------------------

// Estado de un día para un técnico: futuro | hoy | ok | bajo | sin_fichar | libre (no se le exige jornada ese día).
function estadoDia({ dia, hoy, total, exigible }) {
  if (dia > hoy) return 'futuro';
  if (dia === hoy) return 'hoy';
  if (!exigible) return total > 0 ? 'ok' : 'libre';
  if (total >= objetivoSeg()) return 'ok';
  return total > 0 ? 'bajo' : 'sin_fichar';
}

// Horas fichadas por técnico y día entre dos fechas (incluidas), con el estado de cada día frente a la jornada.
function jornadas({ desde, hasta, tecnicoId = null }) {
  if (!esFecha(desde) || !esFecha(hasta) || desde > hasta) throw new ErrorHttp(400, 'desde y hasta deben ser fechas AAAA-MM-DD válidas, con desde ≤ hasta');
  const dias = [];
  for (let d = desde; d <= hasta; d = sumarDias(d, 1)) { dias.push(d); if (dias.length > RANGO_MAX) throw new ErrorHttp(400, `El rango no puede pasar de ${RANGO_MAX} días`); }
  const cuando = ahora();
  const hoy = cuando.slice(0, 10);
  const limite = sumarDias(hasta, 1);
  const tecnicos = tecnicoId ? [stmt.tecnico.get(tecnicoId)].filter(Boolean) : stmt.tecnicos.all(desde, limite);
  const primero = new Map(stmt.primerFichaje.all().map((f) => [f.tecnico_id, f.dia]));
  const celdas = new Map();   // "tecnico|dia" → acumulado
  for (const f of stmt.porDia.all({ ahora: cuando, desde, hasta: limite, tecnico: tecnicoId })) {
    const k = `${f.tecnico_id}|${f.dia}`;
    const c = celdas.get(k) || { desplazamiento: 0, espera: 0, trabajo: 0, comodin: 0, total: 0, tramos: 0, revisar: 0, abierto: 0, manuales: 0 };
    if (c[f.tipo] !== undefined) c[f.tipo] += f.s;
    c.total += f.s; c.tramos += f.n; c.revisar += f.revisar; c.abierto += f.abiertos; c.manuales += f.manuales;
    celdas.set(k, c);
  }
  const pendientes = new Map(stmt.pendientesPorDia.all(desde, hasta).map((f) => [`${f.tecnico_id}|${f.dia}`, f.n]));
  const objetivo = objetivoSeg();

  return {
    desde, hasta, hoy, horas_dia: JORNADA.horas_dia,
    dias: dias.map((dia) => ({ dia, laborable: esLaborable(dia) ? 1 : 0 })),
    tecnicos: tecnicos.map((t) => {
      const desdeFichaje = primero.get(t.id) || null;
      const totales = { desplazamiento: 0, espera: 0, trabajo: 0, comodin: 0, total: 0, falta: 0, dias_bajos: 0, revisar: 0, pendientes: 0 };
      const lista = dias.map((dia) => {
        const c = celdas.get(`${t.id}|${dia}`) || { desplazamiento: 0, espera: 0, trabajo: 0, comodin: 0, total: 0, tramos: 0, revisar: 0, abierto: 0, manuales: 0 };
        const exigible = t.rol === 'tecnico' && esLaborable(dia) && !!desdeFichaje && dia >= desdeFichaje;
        const estado = estadoDia({ dia, hoy, total: c.total, exigible });
        const falta = estado === 'bajo' || estado === 'sin_fichar' ? objetivo - c.total : 0;
        const pend = pendientes.get(`${t.id}|${dia}`) || 0;
        for (const k of ['desplazamiento', 'espera', 'trabajo', 'comodin', 'total', 'revisar']) totales[k] += c[k];
        totales.falta += falta; totales.pendientes += pend;
        if (falta) totales.dias_bajos += 1;
        return { dia, ...c, estado, falta, pendientes: pend };
      });
      return { id: t.id, nombre: t.nombre, rol: t.rol, activo: t.activo, primer_fichaje: desdeFichaje, dias: lista, totales };
    }),
  };
}

// Días laborables de la última semana (sin contar hoy) en los que el técnico no llega a la jornada.
function jornadasBajas(tecnico, hoy = ahora().slice(0, 10)) {
  if (tecnico.rol !== 'tecnico') return [];
  const j = jornadas({ desde: sumarDias(hoy, -DIAS_AVISO), hasta: sumarDias(hoy, -1), tecnicoId: tecnico.id });
  if (!j.tecnicos.length) return [];
  return j.tecnicos[0].dias.filter((d) => d.falta > 0).map((d) => ({ dia: d.dia, estado: d.estado, total: d.total, falta: d.falta }));
}

// El detalle de un día: sus tramos (con la O.T. o el concepto del comodín) y las O.T. a las que el técnico podría imputar.
function detalleDia(tecnico, dia) {
  if (!esFecha(dia)) throw new ErrorHttp(400, 'dia debe ser una fecha AAAA-MM-DD válida');
  const j = jornadas({ desde: dia, hasta: dia, tecnicoId: tecnico.id });
  const resumen = j.tecnicos.length ? j.tecnicos[0].dias[0] : null;
  return {
    hoy: j.hoy, dia, horas_dia: j.horas_dia, tecnico: { id: tecnico.id, nombre: tecnico.nombre, rol: tecnico.rol },
    resumen,
    tramos: stmt.tramosDia.all({ ahora: ahora(), tecnico: tecnico.id, desde: dia, hasta: sumarDias(dia, 1) }),
    ots: stmt.otsImputables.all({ t: tecnico.id, d: dia, antes: sumarDias(dia, -7), despues: sumarDias(dia, 8) }),
    conceptos: conceptos(),
    incidencias: listarIncidencias({ tecnicoId: tecnico.id, desde: dia, hasta: dia, estado: 'todas' }),
  };
}

// ---------------------------------------------------------------------------
// Incidencias de fichaje
// ---------------------------------------------------------------------------

// Foto de un tramo para el rastro (antes) y para comparar con la propuesta.
const foto = (t) => ({
  ot_id: t.ot_id, numero: t.numero || null, comodin: t.comodin_id ? 1 : 0, tipo: t.tipo,
  concepto: t.concepto || null, concepto_nombre: t.concepto_nombre || null, inicio: t.inicio, fin: t.fin,
});

// "trabajo 12/11 09:00–11:30" o "comodín (Formación) 12/11 09:00–11:30".
function textoTramo(f) {
  const que = f.comodin ? `comodín (${f.concepto_nombre || f.concepto})` : tiempos.NOMBRE_TIPO[f.tipo].toLowerCase();
  return `${que} ${diaCorto(f.inicio.slice(0, 10))} ${horaDe(f.inicio)}–${horaDe(f.fin)}`;
}

const parseJSON = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };

function incidenciaPublica(i) {
  if (!i) return null;
  const antes = parseJSON(i.antes), propuesta = parseJSON(i.propuesta);
  return {
    id: i.id, tipo: i.tipo, estado: i.estado, accion: i.accion, accion_nombre: NOMBRE_ACCION[i.accion] || i.accion,
    tecnico_id: i.tecnico_id, tecnico_nombre: i.tecnico_nombre, solicitante_id: i.solicitante_id, solicitante_nombre: i.solicitante_nombre,
    directa: i.solicitante_id !== i.tecnico_id ? 1 : 0,
    tramo_id: i.tramo_id, ot_id: i.ot_id, ot_numero: i.ot_numero || (propuesta && propuesta.numero) || (antes && antes.numero) || null,
    dia: i.dia, motivo: i.motivo, antes, propuesta,
    antes_texto: antes ? textoTramo(antes) : null, propuesta_texto: propuesta ? textoTramo(propuesta) : null,
    resuelto_por: i.resuelto_por, resuelto_por_nombre: i.resuelto_por_nombre, resuelto: i.resuelto, respuesta: i.respuesta, creado: i.creado,
  };
}

function listarIncidencias({ tecnicoId = null, estado = 'pendiente', desde = null, hasta = null, limite = INCIDENCIAS_MAX } = {}) {
  const donde = ["i.tipo = 'fichaje'"], params = [];
  if (tecnicoId) { donde.push('i.tecnico_id = ?'); params.push(tecnicoId); }
  if (estado === 'pendiente') donde.push("i.estado = 'pendiente'");
  else if (estado === 'resueltas') donde.push("i.estado <> 'pendiente'");
  else if (estado !== 'todas') throw new ErrorHttp(400, '"estado" debe ser uno de: pendiente, resueltas, todas');
  if (desde) { donde.push('i.dia >= ?'); params.push(desde); }
  if (hasta) { donde.push('i.dia <= ?'); params.push(hasta); }
  const orden = estado === 'pendiente' ? 'i.creado, i.id' : "(i.estado = 'pendiente') DESC, COALESCE(i.resuelto, i.creado) DESC, i.id DESC";
  return db.prepare(`${INCIDENCIA_SELECT} WHERE ${donde.join(' AND ')} ORDER BY ${orden} LIMIT ?`).all(...params, Math.min(limite, INCIDENCIAS_MAX)).map(incidenciaPublica);
}

// Compone y valida el intervalo de la propuesta. Si la hora no cambia respecto a la del tramo, conserva sus segundos.
// `futuro`: las ausencias se pueden imputar aunque el tiempo aún no haya pasado.
function intervalo({ dia, inicio, fin, tramo = null, futuro = false }) {
  if (!esHora(inicio) || !esHora(fin)) throw new ErrorHttp(400, '"inicio" y "fin" deben ser horas HH:MM');
  const conSegundos = (hora, original) => (original && original.slice(0, 16) === `${dia} ${hora}` ? original : `${dia} ${hora}:00`);
  const r = { inicio: conSegundos(inicio, tramo && tramo.inicio), fin: conSegundos(fin, tramo && tramo.fin) };
  if (r.fin <= r.inicio) throw new ErrorHttp(400, 'La hora de fin debe ser posterior a la de inicio (un fichaje no puede pasar de medianoche)');
  if (!futuro && r.fin > ahora()) throw new ErrorHttp(400, 'No se puede fichar tiempo que aún no ha pasado');
  return r;
}

function comprobarSolape({ tecnicoId, inicio, fin, excepto = 0 }) {
  const otro = stmt.solape.get({ tecnico: tecnicoId, excepto, inicio: inicio.slice(0, 16), fin: fin.slice(0, 16), ahora: ahora() });
  if (otro) {
    const donde = otro.comodin_id ? `comodín (${otro.concepto_nombre || otro.concepto})` : `O.T. ${otro.numero}`;
    throw new ErrorHttp(409, `Se solapa con otro fichaje: ${horaDe(otro.inicio)}–${otro.fin ? horaDe(otro.fin) : 'en marcha'}, ${donde}`, { solape: otro.id });
  }
}

// Aplica una incidencia aprobada al fichaje. Devuelve el id del tramo afectado (o creado). Dentro de una transacción.
function aplicar(inc, usuario, cuando) {
  const p = parseJSON(inc.propuesta);
  let tramoId = inc.tramo_id, otId = inc.ot_id, nota;
  if (inc.accion === 'anadir') {
    comprobarSolape({ tecnicoId: inc.tecnico_id, inicio: p.inicio, fin: p.fin });
    const comodin = p.comodin ? asegurarComodin(inc.tecnico_id, inc.dia.slice(0, 7)) : null;
    if (!comodin && !stmt.ot.get(p.ot_id)) throw new ErrorHttp(409, 'La O.T. de la incidencia ya no existe');
    const bloque = comodin ? null : stmt.bloqueDelDia.get(p.ot_id, inc.tecnico_id, inc.dia);
    tramoId = stmt.insertarTramo.run(comodin ? null : p.ot_id, comodin ? comodin.id : null, inc.tecnico_id, bloque ? bloque.id : null, p.tipo, p.concepto, p.inicio, p.fin, inc.id).lastInsertRowid;
    nota = `Fichaje añadido por corrección (incidencia nº ${inc.id}): ${textoTramo(p)}`;
  } else {
    const tramo = stmt.tramo.get(inc.tramo_id);
    if (!tramo) throw new ErrorHttp(409, 'El fichaje de esta incidencia ya no existe');
    if (!tramo.fin) throw new ErrorHttp(409, 'El cronómetro de ese fichaje está en marcha: hay que pararlo antes');
    otId = tramo.ot_id;
    if (inc.accion === 'modificar') {
      comprobarSolape({ tecnicoId: inc.tecnico_id, inicio: p.inicio, fin: p.fin, excepto: tramo.id });
      stmt.corregirTramo.run(p.tipo, p.concepto, p.inicio, p.fin, inc.id, tramo.id);
      nota = `Fichaje corregido (incidencia nº ${inc.id}): ${textoTramo(foto(tramo))} → ${textoTramo(p)}`;
    } else {
      stmt.quitarTramo.run(tramo.id);
      nota = `Fichaje quitado (incidencia nº ${inc.id}): ${textoTramo(foto(tramo))}`;
    }
  }
  if (otId) {
    const ot = stmt.ot.get(otId);
    if (ot) stmt.historial.run(otId, ot.estado, ot.estado, usuario.id, cuando, `${nota} · ${inc.motivo}`);
  }
  return tramoId;
}

// Abre una incidencia de fichaje. `tecnico` = de quién es el fichaje; `usuario` = quién la abre. Con `directa` (la oficina
// corrige ella misma) se aplica en el momento y nace aprobada.
function crearIncidencia({ usuario, tecnico, cuerpo, directa = false }) {
  const b = cuerpo || {};
  const accion = enumerado(b.accion, { nombre: 'accion', valores: ACCIONES });
  if (!accion) throw new ErrorHttp(400, 'Falta el campo "accion"');
  const motivo = texto(b.motivo, { nombre: 'motivo', obligatorio: true, max: 500 });

  return db.transaction(() => {
    const cuando = ahora();
    let tramo = null, antes = null, propuesta = null, dia, otId = null;
    if (accion !== 'anadir') {
      tramo = stmt.tramo.get(entero(b.tramo_id, { nombre: 'tramo_id', obligatorio: true, min: 1 }));
      if (!tramo || tramo.tecnico_id !== tecnico.id) throw new ErrorHttp(404, 'Fichaje no encontrado');
      if (!tramo.fin) throw new ErrorHttp(400, 'El cronómetro de ese fichaje sigue en marcha: páralo antes de pedir la corrección');
      if (stmt.pendienteDeTramo.get(tramo.id)) throw new ErrorHttp(409, 'Ese fichaje ya tiene una incidencia pendiente de resolver');
      antes = foto(tramo); dia = tramo.inicio.slice(0, 10); otId = tramo.ot_id;
    }
    if (accion === 'modificar') {
      const tipo = tramo.comodin_id ? tiempos.TIPO_COMODIN : enumerado(b.tipo, { nombre: 'tipo', valores: tiempos.TIPOS, defecto: tramo.tipo });
      const concepto = tramo.comodin_id ? conceptoValido(b.concepto || tramo.concepto) : null;
      const r = intervalo({ dia, inicio: b.inicio === undefined ? horaDe(tramo.inicio) : b.inicio, fin: b.fin === undefined ? horaDe(tramo.fin) : b.fin, tramo, futuro: !!(concepto && concepto.ausencia) });
      propuesta = { ...antes, tipo, concepto: concepto ? concepto.codigo : null, concepto_nombre: concepto ? concepto.nombre : null, ...r };
      if (propuesta.tipo === antes.tipo && propuesta.concepto === antes.concepto && propuesta.inicio === antes.inicio && propuesta.fin === antes.fin) {
        throw new ErrorHttp(400, 'La corrección no cambia nada del fichaje');
      }
      comprobarSolape({ tecnicoId: tecnico.id, ...r, excepto: tramo.id });
    } else if (accion === 'anadir') {
      dia = String(b.dia || '');
      if (!esFecha(dia)) throw new ErrorHttp(400, '"dia" debe ser una fecha AAAA-MM-DD válida');
      const alComodin = b.comodin === true || b.comodin === 1;
      const concepto = alComodin ? conceptoValido(b.concepto) : null;
      const r = intervalo({ dia, inicio: b.inicio, fin: b.fin, futuro: !!(concepto && concepto.ausencia) });
      if (alComodin) {
        propuesta = { ot_id: null, numero: null, comodin: 1, tipo: tiempos.TIPO_COMODIN, concepto: concepto.codigo, concepto_nombre: concepto.nombre, ...r };
      } else {
        const ot = b.ot_numero ? stmt.otPorNumero.get(String(b.ot_numero).trim()) : stmt.ot.get(entero(b.ot_id, { nombre: 'ot_id', obligatorio: true, min: 1 }));
        if (!ot || (!directa && !stmt.puedeImputar.get({ ot: ot.id, t: tecnico.id }))) throw new ErrorHttp(404, 'O.T. no encontrada (o no es una de las tuyas)');
        const tipo = enumerado(b.tipo, { nombre: 'tipo', valores: tiempos.TIPOS });
        if (!tipo) throw new ErrorHttp(400, 'Falta el campo "tipo" (desplazamiento, espera o trabajo)');
        otId = ot.id;
        propuesta = { ot_id: ot.id, numero: ot.numero, comodin: 0, tipo, concepto: null, concepto_nombre: null, ...r };
      }
      comprobarSolape({ tecnicoId: tecnico.id, ...r });
    }
    const id = stmt.crearIncidencia.run({
      tecnico_id: tecnico.id, solicitante_id: usuario.id, accion, tramo_id: tramo ? tramo.id : null, ot_id: otId, dia, motivo,
      antes: antes ? JSON.stringify(antes) : null, propuesta: propuesta ? JSON.stringify(propuesta) : null, creado: cuando,
    }).lastInsertRowid;
    if (directa) {
      const tramoId = aplicar(stmt.incidencia.get(id), usuario, cuando);
      stmt.resolver.run('aprobada', usuario.id, cuando, null, tramoId, id);
    }
    return incidenciaPublica(stmt.incidencia.get(id));
  }).immediate();
}

// Aprueba (se aplica al fichaje) o rechaza (con respuesta) una incidencia pendiente.
function resolverIncidencia({ id, usuario, aprobar, respuesta = null }) {
  return db.transaction(() => {
    const inc = stmt.incidencia.get(id);
    if (!inc || inc.tipo !== 'fichaje') throw new ErrorHttp(404, 'Incidencia no encontrada');
    if (inc.estado !== 'pendiente') throw new ErrorHttp(409, `La incidencia ya está ${inc.estado}`, { estado: inc.estado });
    if (!aprobar && !respuesta) throw new ErrorHttp(400, 'Para rechazar hay que explicar el motivo en "respuesta"');
    const cuando = ahora();
    const tramoId = aprobar ? aplicar(inc, usuario, cuando) : inc.tramo_id;
    stmt.resolver.run(aprobar ? 'aprobada' : 'rechazada', usuario.id, cuando, respuesta, tramoId, id);
    return incidenciaPublica(stmt.incidencia.get(id));
  }).immediate();
}

// Quien la pidió retira una incidencia que aún no se ha resuelto.
function anularIncidencia({ id, usuario }) {
  return db.transaction(() => {
    const inc = stmt.incidencia.get(id);
    if (!inc || inc.tipo !== 'fichaje' || inc.solicitante_id !== usuario.id) throw new ErrorHttp(404, 'Incidencia no encontrada');
    if (inc.estado !== 'pendiente') throw new ErrorHttp(409, `La incidencia ya está ${inc.estado}`, { estado: inc.estado });
    stmt.resolver.run('anulada', usuario.id, ahora(), null, inc.tramo_id, id);
    return incidenciaPublica(stmt.incidencia.get(id));
  }).immediate();
}

const incidencia = (id) => incidenciaPublica(stmt.incidencia.get(id));
const pendientes = () => stmt.nPendientes.get().n;
const pendientesDe = (tecnicoId) => stmt.nPendientesDe.get(tecnicoId).n;
const firma = () => { const f = stmt.firma.get(); return `${f.n}|${f.p}|${f.m}`; };
const tecnicoPorId = (id) => stmt.tecnico.get(id) || null;

module.exports = {
  ACCIONES, ESTADOS, DIAS_AVISO, RANGO_MAX, esFecha, esMes, finDeMes, sumarDias, esLaborable,
  asegurarComodin, codigoComodin, conceptos, conceptosCrono, conceptoValido, comodinPublico,
  jornadas, jornadasBajas, detalleDia, tecnicoPorId,
  crearIncidencia, resolverIncidencia, anularIncidencia, listarIncidencias, incidencia, pendientes, pendientesDe, firma,
};
