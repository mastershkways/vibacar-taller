// rutas-planificador.js — API del Planificador (F4-02 + F4-03): calendario de bloques por técnico y día, bandeja de O.T. sin
// planificar y avisos de carga.
//
// Modelo (tabla `ot_bloques`, F4-01): una O.T. tiene 0..n bloques (técnico, día, hora de inicio, duración). Sin bloques futuros
// está en la bandeja. Los bloques pasados no se borran: son lo previsto, que se comparará con lo fichado (F4-06).
//
// Reglas que aplica el servidor:
//   - El calendario solo mueve la O.T. entre "pendiente de planificar" y "planificada": al tener su primer bloque futuro pasa a
//     planificada; si se queda sin bloques futuros vuelve a pendiente de planificar. En cualquier otro estado (p. ej. pausada,
//     que se puede preplanificar) el estado no se toca.
//   - `ot.tecnico_id` se deriva del próximo bloque (hoy o posterior). Cada cambio sube `ot.version` y deja línea en el historial.
//   - Avisos (no bloquean): más horas previstas que la jornada, dos o más zonas el mismo día, bloques solapados.
//   - Quien planifica ve la ocupación de todos los técnicos; solo puede tocar los bloques de las O.T. de su alcance.

const express = require('express');
const crypto = require('crypto');
const { db, ahora } = require('./db');
const { requierePermiso } = require('./permisos');
const { ErrorHttp, texto, entero, idRuta } = require('./validar');
const rutasOT = require('./rutas-ot');

const esHora = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const horaEnv = (valor, defecto) => (esHora((valor || '').trim()) ? valor.trim() : defecto);
// Jornada visible del calendario y horas de trabajo por día (para el aviso de exceso). Configurable en el .env.
const JORNADA = {
  inicio: horaEnv(process.env.PLANIFICADOR_HORA_INICIO, '07:00'),
  fin: horaEnv(process.env.PLANIFICADOR_HORA_FIN, '19:00'),
  horas_dia: Number(process.env.PLANIFICADOR_HORAS_DIA) > 0 ? Number(process.env.PLANIFICADOR_HORAS_DIA) : 8,
};
const DURACION_DEFECTO = 120;   // 2 h (decisión de Sendoa, 2026-11-02)
const DURACION_MIN = 15;
const DURACION_MAX = 720;
const RANGO_MAX_DIAS = 31;
const BANDEJA_MAX = 500;

// ---------------------------------------------------------------------------
// Utilidades de fecha y hora (todo en hora local, como el resto de la app)
// ---------------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, '0');
const fechaISO = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const hoy = () => fechaISO(new Date());
function esFecha(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split('-').map(Number);
  const f = new Date(a, m - 1, d);
  return f.getFullYear() === a && f.getMonth() === m - 1 && f.getDate() === d;
}
const diasEntre = (desde, hasta) => Math.round((new Date(`${hasta}T12:00:00`) - new Date(`${desde}T12:00:00`)) / 86400000);
const minutos = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const horaDe = (min) => `${dos(Math.floor(min / 60))}:${dos(min % 60)}`;
const textoDuracion = (min) => (min % 60 === 0 ? `${min / 60} h` : `${String(Math.round((min / 60) * 100) / 100).replace('.', ',')} h`);
const diaCorto = (iso) => { const [a, m, d] = iso.split('-').map(Number); return `${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][new Date(a, m - 1, d).getDay()]} ${dos(d)}/${dos(m)}`; };
const textoBloque = (b, tecnico) => `${diaCorto(b.dia)} ${b.hora_inicio} · ${textoDuracion(b.duracion_min)} · ${tecnico}`;

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
const CAMPOS_OT = `
  o.numero, o.estado, e.nombre AS estado_nombre, e.color AS estado_color, o.etiqueta, et.nombre AS etiqueta_nombre, et.color AS etiqueta_color,
  o.prioridad, o.tipo, o.sintoma, o.version, o.fecha_prevista, o.karve_estado, o.karve_operario,
  o.cliente_id, c.nombre AS cliente_nombre, c.zona AS cliente_zona,
  o.maquina_id, m.marca AS maquina_marca, m.modelo AS maquina_modelo, m.bastidor AS maquina_bastidor, m.num_flota AS maquina_flota`;
const JOINS_OT = `
  JOIN estados e ON e.codigo = o.estado
  JOIN fases fa ON fa.codigo = e.fase
  JOIN clientes c ON c.id = o.cliente_id
  LEFT JOIN etiquetas et ON et.codigo = o.etiqueta
  LEFT JOIN maquinas m ON m.id = o.maquina_id`;

const stmt = {
  tecnicos: db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE activo = 1 AND rol IN ('tecnico', 'sat') ORDER BY (rol = 'sat'), nombre COLLATE NOCASE`),
  tecnico: db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE id = ? AND activo = 1 AND rol IN ('tecnico', 'sat')`),
  usuario: db.prepare('SELECT id, nombre, rol FROM usuarios WHERE id = ?'),
  bloque: db.prepare('SELECT * FROM ot_bloques WHERE id = ? AND ot_id = ?'),
  proximo: db.prepare(`SELECT b.*, u.nombre AS tecnico_nombre FROM ot_bloques b JOIN usuarios u ON u.id = b.tecnico_id WHERE b.ot_id = ? AND b.dia >= ? ORDER BY b.dia, b.hora_inicio, b.id LIMIT 1`),
  otCorta: db.prepare('SELECT o.id, o.estado, o.tecnico_id, o.version, e.es_final FROM ot o JOIN estados e ON e.codigo = o.estado WHERE o.id = ?'),
  tocarOT: db.prepare('UPDATE ot SET tecnico_id = ?, propuesta = ?, propuesta_fecha = ?, version = version + 1, actualizado = ? WHERE id = ?'),
  historial: db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)'),
  insertar: db.prepare(`INSERT INTO ot_bloques (ot_id, tecnico_id, dia, hora_inicio, duracion_min, orden, nota, creado_por, creado)
                        VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(orden), 0) + 1 FROM ot_bloques WHERE tecnico_id = ? AND dia = ?), ?, ?, ?)`),
  bloquesDia: db.prepare(`
    SELECT b.id, b.ot_id, b.hora_inicio, b.duracion_min, c.zona AS cliente_zona, o.numero
      FROM ot_bloques b JOIN ot o ON o.id = b.ot_id JOIN clientes c ON c.id = o.cliente_id
     WHERE b.tecnico_id = ? AND b.dia = ? ORDER BY b.hora_inicio, b.id`),
};

// ---------------------------------------------------------------------------
// Avisos de un técnico en un día (F4-03): exceso de horas, varias zonas, solapes. No bloquean nada.
// ---------------------------------------------------------------------------
function avisosDe(tecnicoId, dia, bloques, nombreTecnico = '') {
  const avisos = [];
  if (!bloques.length) return avisos;
  const base = { tecnico_id: tecnicoId, dia };
  const total = bloques.reduce((n, b) => n + b.duracion_min, 0);
  if (total > JORNADA.horas_dia * 60) {
    avisos.push({ ...base, tipo: 'horas', texto: `${nombreTecnico ? nombreTecnico + ': ' : ''}${textoDuracion(total)} previstas (jornada de ${JORNADA.horas_dia} h)`, bloques: bloques.map((b) => b.id) });
  }
  const zonas = [...new Set(bloques.map((b) => b.cliente_zona).filter(Boolean))];
  if (zonas.length > 1) {
    avisos.push({ ...base, tipo: 'zonas', texto: `${nombreTecnico ? nombreTecnico + ': ' : ''}${zonas.length} zonas el mismo día (${zonas.join(', ')})`, bloques: bloques.filter((b) => b.cliente_zona).map((b) => b.id) });
  }
  const orden = [...bloques].sort((x, y) => minutos(x.hora_inicio) - minutos(y.hora_inicio) || x.id - y.id);
  const solapados = new Set();
  let finMax = -1; let idFinMax = null;
  for (const b of orden) {
    const ini = minutos(b.hora_inicio);
    if (ini < finMax) { solapados.add(b.id); solapados.add(idFinMax); }
    if (ini + b.duracion_min > finMax) { finMax = ini + b.duracion_min; idFinMax = b.id; }
  }
  if (solapados.size) avisos.push({ ...base, tipo: 'solape', texto: `${nombreTecnico ? nombreTecnico + ': ' : ''}${solapados.size} bloques se solapan`, bloques: [...solapados] });
  return avisos;
}

// ---------------------------------------------------------------------------
// Lectura y validación de un bloque (alta: todo con valores por defecto; edición: solo lo que venga)
// ---------------------------------------------------------------------------
function leerBloque(body, { parcial = false, actual = null } = {}) {
  const campos = {};
  if (!parcial || body.tecnico_id !== undefined) {
    const tecnicoId = entero(body.tecnico_id, { nombre: 'tecnico_id', obligatorio: true, min: 1 });
    const t = stmt.tecnico.get(tecnicoId);
    if (!t) throw new ErrorHttp(400, 'El técnico no existe, no está activo o no tiene rol técnico/SAT');
    campos.tecnico_id = t.id;
  }
  if (!parcial || body.dia !== undefined) {
    if (!esFecha(body.dia)) throw new ErrorHttp(400, 'dia debe ser una fecha AAAA-MM-DD válida');
    campos.dia = body.dia;
  }
  if (body.hora_inicio !== undefined && body.hora_inicio !== null && body.hora_inicio !== '') {
    if (!esHora(body.hora_inicio)) throw new ErrorHttp(400, 'hora_inicio debe ser HH:MM');
    campos.hora_inicio = body.hora_inicio;
  } else if (!parcial) campos.hora_inicio = '08:00';
  if (body.duracion_min !== undefined && body.duracion_min !== null && body.duracion_min !== '') {
    const d = entero(body.duracion_min, { nombre: 'duracion_min', min: DURACION_MIN, max: DURACION_MAX });
    if (d % 15 !== 0) throw new ErrorHttp(400, 'duracion_min debe ir en tramos de 15 minutos');
    campos.duracion_min = d;
  } else if (!parcial) campos.duracion_min = DURACION_DEFECTO;
  if (body.nota !== undefined) campos.nota = texto(body.nota, { nombre: 'nota', max: 500 });
  const hora = campos.hora_inicio ?? (actual && actual.hora_inicio);
  const duracion = campos.duracion_min ?? (actual && actual.duracion_min);
  if (hora && duracion && minutos(hora) + duracion > 24 * 60) throw new ErrorHttp(400, 'El bloque no puede pasar de medianoche: pártelo en dos días');
  return campos;
}

// ---------------------------------------------------------------------------
// Tras crear, mover o quitar un bloque: técnico derivado, estado pendiente ↔ planificada, versión e historial.
// Debe ejecutarse dentro de una transacción.
// ---------------------------------------------------------------------------
function trasCambio(otId, usuario, nota) {
  const ot = stmt.otCorta.get(otId);
  const proximo = stmt.proximo.get(otId, hoy());
  if (proximo) {
    stmt.tocarOT.run(proximo.tecnico_id, null, null, ahora(), otId);              // con plan: la propuesta de la bandeja ya no aplica
    if (ot.estado === 'pendiente_planificar') rutasOT.aplicarCambioEstado({ otId, destino: 'planificada', usuario, nota });
    else stmt.historial.run(otId, ot.estado, ot.estado, usuario.id, ahora(), nota);
  } else if (ot.estado === 'planificada') {
    db.prepare('UPDATE ot SET tecnico_id = NULL WHERE id = ?').run(otId);
    rutasOT.aplicarCambioEstado({ otId, destino: 'pendiente_planificar', usuario, nota: `${nota} · sin bloques futuros: vuelve a la bandeja` });
  } else {
    db.prepare('UPDATE ot SET version = version + 1, actualizado = ? WHERE id = ?').run(ahora(), otId);
    stmt.historial.run(otId, ot.estado, ot.estado, usuario.id, ahora(), nota);
  }
}

// Alta y baja de un bloque con todos sus efectos. Las usan las rutas y scripts/planificaciones-prueba.js. `campos` ya validados.
function crearBloque(otId, campos, usuario) {
  const tecnico = stmt.usuario.get(campos.tecnico_id);
  return db.transaction(() => {
    const info = stmt.insertar.run(otId, campos.tecnico_id, campos.dia, campos.hora_inicio, campos.duracion_min, campos.tecnico_id, campos.dia, campos.nota ?? null, usuario.id, ahora());
    trasCambio(otId, usuario, `Planificada: ${textoBloque(campos, tecnico.nombre)}`);
    return info.lastInsertRowid;
  }).immediate();
}

function quitarBloque(otId, bloque, usuario) {
  const tecnico = stmt.usuario.get(bloque.tecnico_id);
  db.transaction(() => {
    db.prepare('DELETE FROM ot_bloques WHERE id = ?').run(bloque.id);
    trasCambio(otId, usuario, `Bloque quitado: ${textoBloque(bloque, tecnico ? tecnico.nombre : '')}`);
  }).immediate();
}

function respuesta(req, otId, bloqueId, tecnicoId, dia) {
  const tecnico = stmt.usuario.get(tecnicoId);
  return {
    bloque: bloqueId ? db.prepare('SELECT b.*, u.nombre AS tecnico_nombre FROM ot_bloques b JOIN usuarios u ON u.id = b.tecnico_id WHERE b.id = ?').get(bloqueId) : null,
    ot: rutasOT.detalleOT(req, otId),
    avisos: avisosDe(tecnicoId, dia, stmt.bloquesDia.all(tecnicoId, dia), tecnico ? tecnico.nombre : ''),
  };
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
module.exports = function montarRutasPlanificador(app) {
  const r = express.Router();

  // Calendario de un rango (un día o una semana): técnicos, bloques, bandeja y avisos. ETag / 304 para el polling.
  //   ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD (por defecto hoy; máximo 31 días) &pausadas=1 (la bandeja incluye las pausadas, para preplanificar)
  r.get('/planificador', requierePermiso('planificador.ver'), (req, res) => {
    const desde = req.query.desde === undefined ? hoy() : String(req.query.desde);
    const hasta = req.query.hasta === undefined ? desde : String(req.query.hasta);
    if (!esFecha(desde) || !esFecha(hasta)) throw new ErrorHttp(400, 'desde y hasta deben ser fechas AAAA-MM-DD válidas');
    const dias = diasEntre(desde, hasta);
    if (dias < 0) throw new ErrorHttp(400, 'hasta no puede ser anterior a desde');
    if (dias >= RANGO_MAX_DIAS) throw new ErrorHttp(400, `El rango máximo es de ${RANGO_MAX_DIAS} días`);
    const conPausadas = String(req.query.pausadas || '') === '1';
    const f = rutasOT.filtroAlcance(req);
    const hoyIso = hoy();

    const firmaB = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS s, COALESCE(MAX(COALESCE(actualizado, creado)), '') AS m FROM ot_bloques`).get();
    const firmaO = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.version), 0) AS v FROM ot o JOIN estados e ON e.codigo = o.estado JOIN fases fa ON fa.codigo = e.fase WHERE fa.abierta = 1`).get();
    const firmaT = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(id), 0) AS s FROM usuarios WHERE activo = 1 AND rol IN ('tecnico', 'sat')`).get();
    const etag = `"${crypto.createHash('sha1').update(`plan|${firmaB.n}|${firmaB.s}|${firmaB.m}|${firmaO.n}|${firmaO.v}|${firmaT.n}|${firmaT.s}|${desde}|${hasta}|${conPausadas}|${hoyIso}|${req.usuario.rol}|${req.usuario.id}`).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    // Bloques del rango, con los datos de su O.T. `fuera_alcance` = 1 si la O.T. no es de quien mira (ve la ocupación, no puede tocarla).
    const bloques = db.prepare(`
      SELECT b.id, b.ot_id, b.tecnico_id, u.nombre AS tecnico_nombre, b.dia, b.hora_inicio, b.duracion_min, b.orden, b.nota,
             CASE WHEN 1 = 1${f.sql} THEN 0 ELSE 1 END AS fuera_alcance,${CAMPOS_OT}
        FROM ot_bloques b
        JOIN ot o ON o.id = b.ot_id
        JOIN usuarios u ON u.id = b.tecnico_id${JOINS_OT}
       WHERE b.dia BETWEEN ? AND ?
       ORDER BY b.dia, b.hora_inicio, b.id`).all(...f.params, desde, hasta);

    // Técnicos activos (internos primero, luego SAT) + los que ya no lo están pero tienen bloques en el rango.
    const tecnicos = stmt.tecnicos.all();
    const ids = new Set(tecnicos.map((t) => t.id));
    for (const b of bloques) if (!ids.has(b.tecnico_id)) { ids.add(b.tecnico_id); tecnicos.push({ ...stmt.usuario.get(b.tecnico_id), inactivo: 1 }); }

    // Bandeja: O.T. abiertas del alcance sin ningún bloque de hoy en adelante. Entran las pendientes de planificar, las planificadas
    // sin bloque (p. ej. importadas de Karve), las en curso cuyo último bloque ya pasó y, si se pide, las pausadas.
    const sinFuturo = 'NOT EXISTS (SELECT 1 FROM ot_bloques b WHERE b.ot_id = o.id AND b.dia >= ?)';
    const conPasado = 'EXISTS (SELECT 1 FROM ot_bloques b WHERE b.ot_id = o.id AND b.dia < ?)';
    const estados = `(o.estado IN ('pendiente_planificar', 'planificada') OR (o.estado = 'en_curso' AND ${conPasado})${conPausadas ? " OR o.estado = 'pausada'" : ''})`;
    const whereBandeja = `WHERE fa.abierta = 1 AND ${sinFuturo} AND ${estados}${f.sql}`;
    const pBandeja = [hoyIso, hoyIso, ...f.params];
    const bandejaTotal = db.prepare(`SELECT COUNT(*) AS n FROM ot o JOIN estados e ON e.codigo = o.estado JOIN fases fa ON fa.codigo = e.fase ${whereBandeja}`).get(...pBandeja).n;
    const bandeja = db.prepare(`
      SELECT o.id, o.propuesta, o.propuesta_fecha, o.creado, ${conPasado} AS bloque_vencido,${CAMPOS_OT}
        FROM ot o${JOINS_OT}
        ${whereBandeja}
       ORDER BY (o.propuesta IS NULL), o.prioridad, COALESCE(o.fecha_prevista, '9999'), o.creado, o.id
       LIMIT ${BANDEJA_MAX}`).all(hoyIso, ...pBandeja);

    // Avisos por técnico y día.
    const grupos = new Map();
    for (const b of bloques) { const k = `${b.tecnico_id}|${b.dia}`; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(b); }
    const avisos = [];
    for (const lista of grupos.values()) avisos.push(...avisosDe(lista[0].tecnico_id, lista[0].dia, lista, lista[0].tecnico_nombre));

    res.set('ETag', etag);
    res.json({ generado: ahora(), hoy: hoyIso, desde, hasta, jornada: JORNADA, duracion_defecto: DURACION_DEFECTO, tecnicos, bloques, bandeja, bandeja_total: bandejaTotal, avisos });
  });

  // Crear un bloque (soltar una O.T. de la bandeja en el calendario, "+ Otro bloque", o desde el detalle).
  r.post('/ot/:id/bloques', requierePermiso('planificador.editar'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const ot = rutasOT.cargarOT(req, id); // alcance
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está cerrada: no se puede planificar');
    const version = entero(b.version, { nombre: 'version', min: 1 });
    if (version !== null && version !== ot.version) throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.', { version: ot.version });
    const campos = leerBloque(b);
    const bloqueId = crearBloque(id, campos, req.usuario);
    res.status(201).json(respuesta(req, id, bloqueId, campos.tecnico_id, campos.dia));
  });

  // Mover (otro día, otra hora, otro técnico) o alargar/acortar un bloque. Solo se toca lo que venga.
  r.put('/ot/:id/bloques/:bid', requierePermiso('planificador.editar'), (req, res) => {
    const id = idRuta(req.params.id);
    const bid = idRuta(req.params.bid);
    const ot = rutasOT.cargarOT(req, id);
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está cerrada: no se puede planificar');
    const actual = stmt.bloque.get(bid, id);
    if (!actual) throw new ErrorHttp(404, 'Bloque no encontrado');
    const campos = leerBloque(req.body || {}, { parcial: true, actual });
    const columnas = Object.keys(campos).filter((c) => (campos[c] ?? null) !== (actual[c] ?? null));
    if (!columnas.length) throw new ErrorHttp(400, 'No hay ningún cambio en el bloque');
    const nuevo = { ...actual, ...campos };
    const tecnico = stmt.usuario.get(nuevo.tecnico_id);
    db.transaction(() => {
      db.prepare(`UPDATE ot_bloques SET ${columnas.map((c) => `${c} = ?`).join(', ')}, actualizado = ? WHERE id = ?`).run(...columnas.map((c) => campos[c]), ahora(), bid);
      const soloNota = columnas.length === 1 && columnas[0] === 'nota';
      trasCambio(id, req.usuario, soloNota ? `Nota del bloque del ${diaCorto(nuevo.dia)}: ${nuevo.nota || '(sin nota)'}` : `Bloque movido: ${textoBloque(nuevo, tecnico.nombre)} (antes ${diaCorto(actual.dia)} ${actual.hora_inicio} · ${textoDuracion(actual.duracion_min)})`);
    }).immediate();
    res.json(respuesta(req, id, bid, nuevo.tecnico_id, nuevo.dia));
  });

  // Quitar un bloque. Si era el último futuro de una O.T. planificada, vuelve a la bandeja.
  r.delete('/ot/:id/bloques/:bid', requierePermiso('planificador.editar'), (req, res) => {
    const id = idRuta(req.params.id);
    const bid = idRuta(req.params.bid);
    const ot = rutasOT.cargarOT(req, id);
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está cerrada: no se puede cambiar su planificación');
    const actual = stmt.bloque.get(bid, id);
    if (!actual) throw new ErrorHttp(404, 'Bloque no encontrado');
    quitarBloque(id, actual, req.usuario);
    res.json(respuesta(req, id, null, actual.tecnico_id, actual.dia));
  });

  app.use('/api', r);
};
Object.assign(module.exports, { JORNADA, avisosDe, leerBloque, crearBloque, quitarBloque });
