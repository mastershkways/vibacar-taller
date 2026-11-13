// tiempos.js — Cronómetro del técnico (F4-06) y checklist de la O.T. (F4-05). Solo lógica y consultas, sin rutas: lo usan
// rutas-ot.js (detalle, requisitos para finalizar, cierre de tramos al cambiar de estado) y rutas-tecnico.js (la API del técnico).
//
// Cronómetro por tramos (tabla `ot_tiempos`): cada tramo es un intervalo de un tipo (desplazamiento → espera de acceso →
// trabajo). Cambiar de fase cierra el tramo abierto y abre el siguiente en el mismo instante. Un técnico solo puede tener un
// tramo abierto (índice único). La hora la pone siempre el servidor: la tablet solo pinta el transcurrido, así que recargar la
// página, apagar la pantalla o cambiar de dispositivo no pierde nada.
//
// Checklist: las plantillas (`checklist_plantillas` + `checklist_puntos`) van por tipo de O.T.; al abrir la O.T. se copian a
// `ot_checklist`, de modo que cambiar la plantilla no altera las O.T. ya hechas. Cada punto se responde: hecho, no aplica o
// incidencia (con nota).
//
// Comodín (F4-07): un tramo puede ir al comodín del mes en vez de a una O.T. (`ot_id` NULL, `comodin_id` y `concepto`, tipo
// 'comodin'). Comparte la regla de un solo tramo abierto por técnico. Su lógica (jornadas, incidencias) está en fichajes.js.
//
// Requisitos para finalizar (decisión de Sendoa, 2026-11-12): haber imputado tiempo de trabajo y tener el checklist respondido.
// El técnico y el SAT no pueden saltárselos; la oficina (quien puede cerrar) sí, con `forzar`, y queda anotado en el historial.

const { db, ahora } = require('./db');
const { ErrorHttp } = require('./validar');

const TIPOS = ['desplazamiento', 'espera', 'trabajo'];
const TIPO_COMODIN = 'comodin';
const NOMBRE_TIPO = { desplazamiento: 'Desplazamiento', espera: 'Espera de acceso', trabajo: 'Trabajo', comodin: 'Comodín' };
const RESULTADOS = ['hecho', 'no_aplica', 'incidencia'];
const HORAS_REVISAR = 12;                                    // un tramo más largo (o cerrado otro día) se marca para revisar (F4-08)
const ESTADOS_CON_CHECKLIST = ['pendiente_planificar', 'planificada', 'en_curso', 'pausada'];

// Segundos entre dos fechas locales 'AAAA-MM-DD HH:MM:SS' (SQLite las trata como UTC en los dos lados: la diferencia es la real).
const SEGUNDOS = (fin, inicio) => `CAST(strftime('%s', ${fin}) - strftime('%s', ${inicio}) AS INTEGER)`;

const stmt = {
  abiertoDe: db.prepare(`
    SELECT t.*, o.numero, cm.codigo AS comodin_codigo, cc.nombre AS concepto_nombre, ${SEGUNDOS('?', 't.inicio')} AS segundos
      FROM ot_tiempos t LEFT JOIN ot o ON o.id = t.ot_id LEFT JOIN comodines cm ON cm.id = t.comodin_id LEFT JOIN comodin_conceptos cc ON cc.codigo = t.concepto
     WHERE t.tecnico_id = ? AND t.fin IS NULL`),
  abiertosOT: db.prepare('SELECT * FROM ot_tiempos WHERE ot_id = ? AND fin IS NULL'),
  cerrar: db.prepare('UPDATE ot_tiempos SET fin = ?, cierre = ?, revisar = ? WHERE id = ? AND fin IS NULL'),
  abrir: db.prepare('INSERT INTO ot_tiempos (ot_id, comodin_id, tecnico_id, bloque_id, tipo, concepto, inicio, nota) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  bloqueDelDia: db.prepare('SELECT id FROM ot_bloques WHERE ot_id = ? AND tecnico_id = ? AND dia = ? ORDER BY hora_inicio, id LIMIT 1'),
  tramos: db.prepare(`
    SELECT t.id, t.ot_id, t.tecnico_id, u.nombre AS tecnico_nombre, t.bloque_id, t.tipo, t.inicio, t.fin, t.cierre, t.origen, t.revisar, t.nota, t.incidencia_id,
           ${SEGUNDOS('COALESCE(t.fin, ?)', 't.inicio')} AS segundos
      FROM ot_tiempos t JOIN usuarios u ON u.id = t.tecnico_id
     WHERE t.ot_id = ? ORDER BY t.inicio, t.id`),
  previsto: db.prepare('SELECT COALESCE(SUM(duracion_min), 0) AS min FROM ot_bloques WHERE ot_id = ?'),
  hayTrabajo: db.prepare("SELECT 1 FROM ot_tiempos WHERE ot_id = ? AND tipo = 'trabajo' LIMIT 1"),
  plantilla: db.prepare('SELECT id FROM checklist_plantillas WHERE activo = 1 AND tipo_ot = ? ORDER BY id LIMIT 1'),
  puntos: db.prepare('SELECT orden, texto FROM checklist_puntos WHERE plantilla_id = ? AND activo = 1 ORDER BY orden, id'),
  hayChecklist: db.prepare('SELECT 1 FROM ot_checklist WHERE ot_id = ? LIMIT 1'),
  copiarPunto: db.prepare('INSERT INTO ot_checklist (ot_id, plantilla_id, orden, texto) VALUES (?, ?, ?, ?)'),
  checklist: db.prepare(`
    SELECT k.id, k.orden, k.texto, k.resultado, k.nota, k.usuario_id, u.nombre AS usuario_nombre, k.fecha
      FROM ot_checklist k LEFT JOIN usuarios u ON u.id = k.usuario_id
     WHERE k.ot_id = ? ORDER BY k.orden, k.id`),
  punto: db.prepare('SELECT * FROM ot_checklist WHERE id = ? AND ot_id = ?'),
  responder: db.prepare('UPDATE ot_checklist SET resultado = ?, nota = ?, usuario_id = ?, fecha = ? WHERE id = ?'),
  progreso: db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(resultado IS NOT NULL), 0) AS respondidos FROM ot_checklist WHERE ot_id = ?'),
};

const hoy = () => ahora().slice(0, 10);
const segundosEntre = (inicio, fin) => Math.round((new Date(fin.replace(' ', 'T')) - new Date(inicio.replace(' ', 'T'))) / 1000);

// "1 h 20 min", "45 min", "0 min".
function textoDuracion(segundos) {
  const min = Math.round(Math.max(0, segundos) / 60);
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
}

// ---------------------------------------------------------------------------
// Cronómetro
// ---------------------------------------------------------------------------

// Tramo en marcha de un técnico (como mucho uno), con el nº de la O.T. y los segundos que lleva. null si no tiene.
function abiertoDe(tecnicoId) {
  const t = stmt.abiertoDe.get(ahora(), tecnicoId);
  return t ? { ...t, otro_dia: t.inicio.slice(0, 10) !== hoy() ? 1 : 0 } : null;
}

// Cierra un tramo. `motivo`: cambio | parar | pausa | fin | estado | otra_ot. Marca `revisar` si se cierra otro día o dura demasiado.
function cerrarTramo(tramo, motivo, cuando = ahora()) {
  const revisar = tramo.inicio.slice(0, 10) !== cuando.slice(0, 10) || segundosEntre(tramo.inicio, cuando) > HORAS_REVISAR * 3600 ? 1 : 0;
  stmt.cerrar.run(cuando, motivo, revisar, tramo.id);
  return { ...tramo, fin: cuando, cierre: motivo, revisar, segundos: segundosEntre(tramo.inicio, cuando) };
}

// Abre un tramo para el técnico en la O.T. (el llamante ya ha cerrado el anterior). Lo enlaza con su bloque de hoy, si lo tiene.
// Con `comodinId` + `concepto` (y sin `otId`) el tramo va al comodín del mes.
function abrirTramo({ otId = null, comodinId = null, concepto = null, tecnicoId, tipo, nota = null, cuando = ahora() }) {
  if (comodinId) return stmt.abrir.run(null, comodinId, tecnicoId, null, TIPO_COMODIN, concepto, cuando, nota).lastInsertRowid;
  if (!TIPOS.includes(tipo)) throw new ErrorHttp(400, `El tipo de tiempo debe ser uno de: ${TIPOS.join(', ')}`);
  const bloque = stmt.bloqueDelDia.get(otId, tecnicoId, cuando.slice(0, 10));
  return stmt.abrir.run(otId, null, tecnicoId, bloque ? bloque.id : null, tipo, null, cuando, nota).lastInsertRowid;
}

// El cronómetro en marcha tal como lo recibe la tablet. En el comodín no hay O.T.: `comodin` = 1 y `nombre` es el concepto.
function cronoPublico(t) {
  if (!t) return null;
  const comodin = t.comodin_id ? 1 : 0;
  return {
    id: t.id, ot_id: t.ot_id, numero: t.numero || null, comodin, concepto: t.concepto || null, tipo: t.tipo,
    nombre: comodin ? (t.concepto_nombre || t.concepto || NOMBRE_TIPO.comodin) : NOMBRE_TIPO[t.tipo],
    inicio: t.inicio, segundos: t.segundos, otro_dia: t.otro_dia,
  };
}

// "la O.T. 0000107951 (trabajo)" o "el comodín (Formación)": dónde tiene el técnico el cronómetro en marcha.
const dondeEsta = (t) => (t.comodin_id ? `el comodín (${t.concepto_nombre || t.concepto})` : `la O.T. ${t.numero} (${NOMBRE_TIPO[t.tipo].toLowerCase()})`);

// Cierra todos los tramos abiertos de una O.T. (de cualquier técnico): la O.T. deja de estar en curso. Devuelve cuántos.
function cerrarTramosOT(otId, motivo, cuando = ahora()) {
  const abiertos = stmt.abiertosOT.all(otId);
  for (const t of abiertos) cerrarTramo(t, motivo, cuando);
  return abiertos.length;
}

function totales(tramos) {
  const t = { desplazamiento: 0, espera: 0, trabajo: 0, total: 0 };
  for (const x of tramos) { const s = Math.max(0, x.segundos || 0); if (t[x.tipo] !== undefined) t[x.tipo] += s; t.total += s; }
  return t;
}

// Tramos de la O.T. (los abiertos, contados hasta ahora) y sus totales en segundos, con lo previsto en el Planificador.
function tiemposOT(otId) {
  const tramos = stmt.tramos.all(ahora(), otId);
  return { tramos, tiempo: { ...totales(tramos), previsto_min: stmt.previsto.get(otId).min, en_marcha: tramos.some((t) => !t.fin) ? 1 : 0 } };
}

// ---------------------------------------------------------------------------
// Checklist
// ---------------------------------------------------------------------------

// Copia a la O.T. los puntos de la plantilla de su tipo, si la hay y aún no los tiene. Solo en O.T. que siguen en trabajo
// (no se añaden checklists a las ya finalizadas o cerradas). Devuelve true si los ha creado.
function asegurarChecklist(ot) {
  if (!ESTADOS_CON_CHECKLIST.includes(ot.estado) || stmt.hayChecklist.get(ot.id)) return false;
  const plantilla = stmt.plantilla.get(ot.tipo);
  if (!plantilla) return false;
  const puntos = stmt.puntos.all(plantilla.id);
  for (const p of puntos) stmt.copiarPunto.run(ot.id, plantilla.id, p.orden, p.texto);
  return puntos.length > 0;
}

const checklistOT = (otId) => stmt.checklist.all(otId);

// Responde (o deja sin responder, con resultado null) un punto del checklist de la O.T.
function responderPunto({ otId, puntoId, resultado, nota, usuario }) {
  const punto = stmt.punto.get(puntoId, otId);
  if (!punto) throw new ErrorHttp(404, 'Punto del checklist no encontrado');
  if (resultado !== null && !RESULTADOS.includes(resultado)) throw new ErrorHttp(400, `"resultado" debe ser uno de: ${RESULTADOS.join(', ')} (o null para dejarlo sin responder)`);
  if (resultado === 'incidencia' && !nota) throw new ErrorHttp(400, 'Una incidencia necesita una nota que diga qué pasa');
  stmt.responder.run(resultado, resultado === null ? null : nota, resultado === null ? null : usuario.id, resultado === null ? null : ahora(), puntoId);
  return stmt.punto.get(puntoId, otId);
}

// ---------------------------------------------------------------------------
// Requisitos para finalizar: tiempo de trabajo imputado y checklist respondido (crea el checklist si le toca y no lo tenía).
// ---------------------------------------------------------------------------
function requisitosFinalizar(ot) {
  asegurarChecklist(ot);
  const trabajo = !!stmt.hayTrabajo.get(ot.id);
  const p = stmt.progreso.get(ot.id);
  const faltan = [];
  if (!trabajo) faltan.push({ codigo: 'trabajo', texto: 'no hay tiempo de trabajo imputado' });
  if (p.respondidos < p.total) faltan.push({ codigo: 'checklist', texto: `checklist sin terminar (${p.respondidos} de ${p.total})` });
  return { trabajo, checklist: { total: p.total, respondidos: p.respondidos, completo: p.respondidos >= p.total ? 1 : 0 }, faltan, completo: faltan.length ? 0 : 1 };
}

module.exports = {
  TIPOS, TIPO_COMODIN, NOMBRE_TIPO, RESULTADOS, HORAS_REVISAR, SEGUNDOS, textoDuracion, segundosEntre,
  abiertoDe, cerrarTramo, abrirTramo, cronoPublico, dondeEsta, cerrarTramosOT, totales, tiemposOT,
  asegurarChecklist, checklistOT, responderPunto, requisitosFinalizar,
};
