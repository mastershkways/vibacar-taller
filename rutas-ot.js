// rutas-ot.js — API de Órdenes de Trabajo: listado con alcance, alta, edición con bloqueo
// optimista, cambio de estado (flujo libre con confirmación), etiquetas, historial, asignaciones y Tablero.
//
// Reglas que se aplican SIEMPRE en el servidor:
//   - alcance del rol (permisos.js): técnico/SAT solo ven sus O.T.; comercial, las de los clientes de su cartera
//     (clientes.comercial_id); operativo, las que abrió él, las de SAT externos y las que aún no tienen técnico.
//   - F4-04 (2026-11-10): cualquier estado → cualquier estado (la confirmación la pone la interfaz). Límites: técnico y SAT solo
//     a en curso / pausada / finalizada; entrar o salir de un estado final (cerrada) exige `ot.cerrar`. La etiqueta pertenece
//     a un estado: al cambiar de estado se pone la que venga (validada) o ninguna. Todo cambio escribe en `ot_historial`.
//   - cualquier UPDATE sobre `ot` incrementa `version`; el PUT exige la version que vio el cliente (409 si no coincide).
//   - F4-02: "pendiente de planificar" significa sin plan. Si alguien manda ahí una O.T. que tiene bloques de hoy en adelante
//     (p. ej. una pausada preplanificada a la que le llega el repuesto), queda en "planificada". Al salir de Pausada hacia
//     pendiente de planificar se anota la propuesta para la bandeja del Planificador (`ot.propuesta`).

const express = require('express');
const crypto = require('crypto');
const { db, ahora } = require('./db');
const { siguienteNumeroOT, leerMaximoKarve } = require('./numeracion');
const { requierePermiso, puede, alcanceDe, DESTINOS_ASIGNADAS } = require('./permisos');
const { ErrorHttp, texto, entero, enumerado, idRuta } = require('./validar');

const TIPOS = ['correctivo', 'preventivo'];
const ORIGENES = ['manual', 'whatsapp', 'correo', 'auto', 'karve'];   // karve = importada de Karve (F3.6-01)
const LIMITE_DEFECTO = 200;
const LIMITE_MAX = 1000;
const DIAS_CERRADAS_DEFECTO = 0;   // F4-04: las cerradas desaparecen del Tablero (gerencia 2026-11-06); ?cerradas=N las enseña N días
const DIAS_CERRADAS_MAX = 90;

// ---------------------------------------------------------------------------
// Consultas base
// ---------------------------------------------------------------------------
const SELECT_OT = `
  SELECT o.*,
         c.nombre AS cliente_nombre, c.exige_pedido, c.zona AS cliente_zona,
         m.marca AS maquina_marca, m.modelo AS maquina_modelo, m.bastidor AS maquina_bastidor, m.num_flota AS maquina_flota,
         e.nombre AS estado_nombre, e.fase, e.color AS estado_color, e.es_final,
         f.nombre AS fase_nombre, f.orden AS fase_orden, f.abierta AS fase_abierta,
         et.nombre AS etiqueta_nombre, et.color AS etiqueta_color,
         t.nombre AS tecnico_nombre,
         u.nombre AS creado_por_nombre
    FROM ot o
    JOIN clientes c ON c.id = o.cliente_id
    LEFT JOIN maquinas m ON m.id = o.maquina_id
    JOIN estados e ON e.codigo = o.estado
    JOIN fases f ON f.codigo = e.fase
    LEFT JOIN etiquetas et ON et.codigo = o.etiqueta
    LEFT JOIN usuarios t ON t.id = o.tecnico_id
    LEFT JOIN usuarios u ON u.id = o.creado_por`;

const stmt = {
  estado: db.prepare('SELECT e.*, f.abierta AS fase_abierta FROM estados e JOIN fases f ON f.codigo = e.fase WHERE e.codigo = ? AND e.activo = 1'),
  estadoInicial: db.prepare('SELECT e.* FROM estados e JOIN fases f ON f.codigo = e.fase WHERE e.es_inicial = 1 AND e.activo = 1 ORDER BY f.orden, e.orden LIMIT 1'),
  estadosActivos: db.prepare('SELECT e.codigo, e.nombre, e.fase, e.color, e.es_final FROM estados e JOIN fases f ON f.codigo = e.fase WHERE e.activo = 1 ORDER BY f.orden, e.orden'),
  etiqueta: db.prepare('SELECT codigo, nombre, estado FROM etiquetas WHERE codigo = ? AND activo = 1'),
  otBloqueo: db.prepare('SELECT o.id, o.estado, o.etiqueta, o.version, o.tecnico_id, e.es_final FROM ot o JOIN estados e ON e.codigo = o.estado WHERE o.id = ?'),
  cambiarEstado: db.prepare('UPDATE ot SET estado = ?, etiqueta = ?, version = version + 1, actualizado = ? WHERE id = ? AND version = ?'),
  historial: db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)'),
  leerHistorial: db.prepare(`
    SELECT h.id, h.estado_anterior, ea.nombre AS estado_anterior_nombre, h.estado_nuevo, en.nombre AS estado_nuevo_nombre,
           h.usuario_id, u.nombre AS usuario_nombre, h.fecha, h.nota
      FROM ot_historial h
      LEFT JOIN usuarios u ON u.id = h.usuario_id
      LEFT JOIN estados ea ON ea.codigo = h.estado_anterior
      LEFT JOIN estados en ON en.codigo = h.estado_nuevo
     WHERE h.ot_id = ? ORDER BY h.id`),
  leerAsignaciones: db.prepare(`
    SELECT a.*, t.nombre AS tecnico_nombre, t.rol AS tecnico_rol, p.nombre AS propuesto_por_nombre, r.nombre AS resuelto_por_nombre
      FROM ot_asignaciones a
      JOIN usuarios t ON t.id = a.tecnico_id
      LEFT JOIN usuarios p ON p.id = a.propuesto_por
      LEFT JOIN usuarios r ON r.id = a.resuelto_por
     WHERE a.ot_id = ? ORDER BY a.id DESC`),
  leerBloques: db.prepare(`
    SELECT b.*, t.nombre AS tecnico_nombre
      FROM ot_bloques b JOIN usuarios t ON t.id = b.tecnico_id
     WHERE b.ot_id = ? ORDER BY b.dia, b.hora_inicio, b.orden`),
  asignacionPendiente: db.prepare(`SELECT id FROM ot_asignaciones WHERE ot_id = ? AND estado = 'propuesta' LIMIT 1`),
  asignacion: db.prepare('SELECT * FROM ot_asignaciones WHERE id = ? AND ot_id = ?'),
  tecnico: db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE id = ? AND activo = 1 AND rol IN ('tecnico', 'sat')`),
  bloquesFuturos: db.prepare(`SELECT COUNT(*) AS n FROM ot_bloques WHERE ot_id = ? AND dia >= date('now', 'localtime')`),
  cliente: db.prepare('SELECT id, activo FROM clientes WHERE id = ?'),
  maquina: db.prepare('SELECT id, cliente_id, activo FROM maquinas WHERE id = ?'),
};

// ---------------------------------------------------------------------------
// Alcance por rol (permisos.js). Devuelve SQL adicional para el WHERE sobre el alias `o`.
// ---------------------------------------------------------------------------
function filtroAlcance(req) {
  switch (alcanceDe(req.usuario.rol)) {
    case 'asignadas':
      return { sql: ' AND o.tecnico_id = ?', params: [req.usuario.id] };
    case 'clientes_propios':
      // F2-05: el comercial solo ve las O.T. de los clientes de su cartera (clientes.comercial_id = él).
      return { sql: ' AND o.cliente_id IN (SELECT id FROM clientes WHERE comercial_id = ?)', params: [req.usuario.id] };
    case 'operativo':
      // F4-12: el operativo administrativo ve las O.T. que abrió él, las de SAT externos y las que aún no tienen técnico.
      return { sql: " AND (o.creado_por = ? OR o.tecnico_id IS NULL OR o.tecnico_id IN (SELECT id FROM usuarios WHERE rol = 'sat'))", params: [req.usuario.id] };
    default:
      return { sql: '', params: [] };
  }
}

// Carga una O.T. completa respetando el alcance. 404 si no existe o queda fuera del alcance.
function cargarOT(req, id) {
  const f = filtroAlcance(req);
  const ot = db.prepare(`${SELECT_OT} WHERE o.id = ?${f.sql}`).get(id, ...f.params);
  if (!ot) throw new ErrorHttp(404, 'O.T. no encontrada');
  return ot;
}

// F4-04: estados a los que este usuario puede llevar la O.T. (flujo libre con los dos límites de arriba).
function destinosPara(usuario, ot) {
  if (!puede(usuario.rol, 'ot.cambiar_estado')) return [];
  const asignadas = alcanceDe(usuario.rol) === 'asignadas';
  const puedeCerrar = puede(usuario.rol, 'ot.cerrar');
  if (ot.es_final && !puedeCerrar) return [];
  return stmt.estadosActivos.all().filter((e) => e.codigo !== ot.estado && (!asignadas || DESTINOS_ASIGNADAS.includes(e.codigo)) && (!e.es_final || puedeCerrar));
}

function detalleOT(req, id) {
  const ot = cargarOT(req, id);
  return {
    ...ot,
    historial: stmt.leerHistorial.all(id),
    asignaciones: stmt.leerAsignaciones.all(id),
    bloques: stmt.leerBloques.all(id),
    destinos: destinosPara(req.usuario, ot),
  };
}

// Comprueba que una etiqueta existe y pertenece al estado dado. Devuelve el registro (o null si viene vacía).
function comprobarEtiqueta(codigo, estado) {
  if (codigo === null || codigo === undefined || codigo === '') return null;
  const et = stmt.etiqueta.get(String(codigo));
  if (!et) throw new ErrorHttp(400, `La etiqueta "${codigo}" no existe`);
  if (et.estado !== estado) throw new ErrorHttp(400, `La etiqueta "${et.nombre}" no es de la vertical "${estado}"`, { etiqueta: et.codigo, estado: et.estado });
  return et;
}

// ---------------------------------------------------------------------------
// Cambio de estado (se usa desde /estado y desde la aprobación de asignación).
// Debe ejecutarse dentro de una transacción. Valida permisos del flujo libre y versión, escribe historial.
// ---------------------------------------------------------------------------
function aplicarCambioEstado({ otId, destino, etiqueta = null, tecnicoId = undefined, usuario, nota = null, versionEsperada = null }) {
  const actual = stmt.otBloqueo.get(otId);
  if (!actual) throw new ErrorHttp(404, 'O.T. no encontrada');
  if (versionEsperada !== null && actual.version !== versionEsperada) {
    throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.', { version: actual.version });
  }
  // F4-02: con bloques de hoy en adelante no puede quedar "pendiente de planificar": conserva su plan y queda planificada.
  let conservaPlan = false;
  if (destino === 'pendiente_planificar' && actual.estado !== 'planificada' && stmt.bloquesFuturos.get(otId).n > 0) { destino = 'planificada'; conservaPlan = true; }
  if (actual.estado === destino) throw new ErrorHttp(400, 'La O.T. ya está en ese estado');
  const nuevo = stmt.estado.get(destino);
  if (!nuevo) throw new ErrorHttp(400, `El estado "${destino}" no existe`);
  const puedeCerrar = puede(usuario.rol, 'ot.cerrar');
  if (actual.es_final && !puedeCerrar) throw new ErrorHttp(403, 'La O.T. está cerrada: solo quien puede cerrar puede reabrirla', { desde: actual.estado, hasta: destino });
  if (nuevo.es_final && !puedeCerrar) throw new ErrorHttp(403, 'Tu rol no puede cerrar una O.T.', { desde: actual.estado, hasta: destino });
  if (alcanceDe(usuario.rol) === 'asignadas' && !DESTINOS_ASIGNADAS.includes(destino)) {
    throw new ErrorHttp(403, `Tu rol solo puede pasar la O.T. a: ${DESTINOS_ASIGNADAS.join(', ')}`, { desde: actual.estado, hasta: destino });
  }
  const et = comprobarEtiqueta(etiqueta, destino);
  let tecnico = null;
  if (tecnicoId !== undefined && tecnicoId !== null) {
    tecnico = stmt.tecnico.get(tecnicoId);
    if (!tecnico) throw new ErrorHttp(400, 'El técnico no existe, no está activo o no tiene rol técnico/SAT');
  }
  const r = stmt.cambiarEstado.run(destino, et ? et.codigo : null, ahora(), otId, actual.version);
  if (r.changes === 0) throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.');
  if (tecnico) db.prepare('UPDATE ot SET tecnico_id = ? WHERE id = ?').run(tecnico.id, otId);
  // F3.6-02: fecha de cierre al entrar en un estado final; se limpia al reabrir.
  if (nuevo.es_final) db.prepare('UPDATE ot SET fecha_cierre = ? WHERE id = ?').run(ahora(), otId);
  else if (actual.es_final) db.prepare('UPDATE ot SET fecha_cierre = NULL WHERE id = ?').run(otId);
  // F4-02: propuesta para la bandeja del Planificador (sale de Pausada y queda sin plan); en cualquier otro cambio se limpia.
  const propuesta = actual.estado === 'pausada' && destino === 'pendiente_planificar' ? (actual.etiqueta || 'lista') : null;
  db.prepare('UPDATE ot SET propuesta = ?, propuesta_fecha = ? WHERE id = ?').run(propuesta, propuesta ? ahora() : null, otId);
  const partes = [et ? `[${et.nombre}]` : null, tecnico ? `Técnico: ${tecnico.nombre}` : null, nota, conservaPlan ? 'conserva su planificación' : null].filter(Boolean);
  stmt.historial.run(otId, actual.estado, destino, usuario.id, ahora(), partes.join(' · ') || null);
  return { anterior: actual.estado, nuevo: destino, etiqueta: et ? et.codigo : null };
}

// ---------------------------------------------------------------------------
// Lectura de campos de la O.T. (alta y edición)
// ---------------------------------------------------------------------------
function leerCamposOT(body, parcial) {
  const campos = {};
  const clienteId = entero(body.cliente_id, { nombre: 'cliente_id', obligatorio: !parcial, min: 1 });
  if (clienteId !== null) {
    const c = stmt.cliente.get(clienteId);
    if (!c) throw new ErrorHttp(400, 'El cliente no existe');
    if (!c.activo) throw new ErrorHttp(400, 'El cliente está desactivado');
    campos.cliente_id = clienteId;
  }
  if (body.maquina_id !== undefined) {
    const maquinaId = entero(body.maquina_id, { nombre: 'maquina_id', min: 1 });
    if (maquinaId === null) campos.maquina_id = null;
    else {
      const m = stmt.maquina.get(maquinaId);
      if (!m) throw new ErrorHttp(400, 'La máquina no existe');
      campos.maquina_id = maquinaId;
      campos._maquina_cliente_id = m.cliente_id;
    }
  }
  // En el PUT parcial solo se tocan tipo/origen si vienen en el body; en el alta tienen valor por defecto.
  if (!parcial || body.tipo !== undefined) campos.tipo = enumerado(body.tipo, { nombre: 'tipo', valores: TIPOS, defecto: 'correctivo' });
  if (!parcial || body.origen !== undefined) campos.origen = enumerado(body.origen, { nombre: 'origen', valores: ORIGENES, defecto: 'manual' });
  if (body.sintoma !== undefined) campos.sintoma = texto(body.sintoma, { nombre: 'sintoma', max: 200 });
  if (body.descripcion !== undefined) campos.descripcion = texto(body.descripcion, { nombre: 'descripcion', max: 4000 });
  if (body.notas_internas !== undefined) campos.notas_internas = texto(body.notas_internas, { nombre: 'notas_internas', max: 4000 });
  if (body.fecha_prevista !== undefined) {
    const fp = texto(body.fecha_prevista, { nombre: 'fecha_prevista', max: 10 });
    if (fp !== null && !/^\d{4}-\d{2}-\d{2}$/.test(fp)) throw new ErrorHttp(400, 'fecha_prevista debe ser AAAA-MM-DD');
    campos.fecha_prevista = fp;
  }
  const prioridad = entero(body.prioridad, { nombre: 'prioridad', min: 1, max: 3 });
  if (prioridad !== null) campos.prioridad = prioridad;
  return campos;
}

function comprobarMaquinaDeCliente(maquinaClienteId, clienteId) {
  if (maquinaClienteId !== undefined && maquinaClienteId !== null && maquinaClienteId !== clienteId) {
    throw new ErrorHttp(400, 'La máquina no pertenece a ese cliente');
  }
}

// ---------------------------------------------------------------------------
// Asignaciones
// ---------------------------------------------------------------------------
const resolverAsignacion = db.transaction(({ ot, asignacion, usuario, aprobar, nota }) => {
  db.prepare(`UPDATE ot_asignaciones SET estado = ?, resuelto_por = ?, resuelto_en = ?, nota = COALESCE(?, nota) WHERE id = ?`)
    .run(aprobar ? 'aprobada' : 'rechazada', usuario.id, ahora(), nota, asignacion.id);
  if (!aprobar) return;
  const tecnico = stmt.tecnico.get(asignacion.tecnico_id);
  if (!tecnico) throw new ErrorHttp(400, 'El técnico ya no está activo');
  const r = db.prepare('UPDATE ot SET tecnico_id = ?, version = version + 1, actualizado = ? WHERE id = ? AND version = ?')
    .run(tecnico.id, ahora(), ot.id, ot.version);
  if (r.changes === 0) throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.');
  const notaHist = `Técnico asignado: ${tecnico.nombre}`;
  // F4-04: asignar técnico a una O.T. pendiente de planificar la pasa a planificada; en otro estado solo se anota.
  if (ot.estado === 'pendiente_planificar' && puede(usuario.rol, 'ot.cambiar_estado')) {
    aplicarCambioEstado({ otId: ot.id, destino: 'planificada', usuario, nota: notaHist });
  } else {
    stmt.historial.run(ot.id, ot.estado, ot.estado, usuario.id, ahora(), `${notaHist} (sin cambio de estado)`);
  }
});

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
module.exports = function montarRutasOT(app) {
  const r = express.Router();

  // Listado con filtros y alcance.
  r.get('/ot', requierePermiso('ot.ver'), (req, res) => {
    const f = filtroAlcance(req);
    const where = ['1 = 1'];
    const p = [];
    const fase = texto(req.query.fase, { nombre: 'fase', max: 50 });
    const estado = texto(req.query.estado, { nombre: 'estado', max: 50 });
    const etiqueta = texto(req.query.etiqueta, { nombre: 'etiqueta', max: 50 });
    const zona = texto(req.query.zona, { nombre: 'zona', max: 50 });
    const tecnicoId = entero(req.query.tecnico_id, { nombre: 'tecnico_id', min: 1 });
    const clienteId = entero(req.query.cliente_id, { nombre: 'cliente_id', min: 1 });
    const prioridad = entero(req.query.prioridad, { nombre: 'prioridad', min: 1, max: 3 });
    const q = texto(req.query.q, { nombre: 'q', max: 100 });
    const abiertas = req.query.abiertas === undefined ? '1' : String(req.query.abiertas);
    const limite = Math.min(entero(req.query.limite, { nombre: 'limite', min: 1 }) ?? LIMITE_DEFECTO, LIMITE_MAX);
    const pagina = entero(req.query.pagina, { nombre: 'pagina', min: 1 }) ?? 1;

    if (abiertas === '1') where.push('f.abierta = 1');
    if (fase) { where.push('e.fase = ?'); p.push(fase); }
    if (estado) { where.push('o.estado = ?'); p.push(estado); }
    if (etiqueta) { where.push(etiqueta === '-' ? 'o.etiqueta IS NULL' : 'o.etiqueta = ?'); if (etiqueta !== '-') p.push(etiqueta); }
    if (zona) { where.push('c.zona = ?'); p.push(zona); }
    if (tecnicoId) { where.push('o.tecnico_id = ?'); p.push(tecnicoId); }
    if (clienteId) { where.push('o.cliente_id = ?'); p.push(clienteId); }
    if (prioridad) { where.push('o.prioridad = ?'); p.push(prioridad); }
    if (q) { where.push('(o.numero LIKE ? OR o.sintoma LIKE ? OR c.nombre LIKE ? OR m.bastidor LIKE ? OR m.num_flota LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }

    const sqlWhere = ` WHERE ${where.join(' AND ')}${f.sql}`;
    const params = [...p, ...f.params];
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ot o JOIN clientes c ON c.id = o.cliente_id LEFT JOIN maquinas m ON m.id = o.maquina_id JOIN estados e ON e.codigo = o.estado JOIN fases f ON f.codigo = e.fase${sqlWhere}`).get(...params).n;
    const ots = db.prepare(`${SELECT_OT}${sqlWhere} ORDER BY o.prioridad, o.creado DESC, o.id DESC LIMIT ? OFFSET ?`).all(...params, limite, (pagina - 1) * limite);
    res.json({ total, pagina, limite, ots });
  });

  // Tablero: O.T. vivas agrupadas por vertical (fase). Pensado para polling: ETag y 304 si nada cambió.
  // F4-04: las cerradas no se muestran (0 días por defecto); con ?cerradas=N (máx. 90) aparece la columna con las cerradas
  // en esos días. Urgentes arriba (prioridad) y, dentro, las de fecha prevista más próxima. El histórico completo está en
  // GET /ot?abiertas=0, paginado. Los filtros (operario, zona, etiqueta, texto) los aplica la interfaz sobre estos datos.
  r.get('/kanban', requierePermiso('kanban.ver'), (req, res) => {
    const f = filtroAlcance(req);
    const dias = Math.min(entero(req.query.cerradas, { nombre: 'cerradas', min: 0 }) ?? DIAS_CERRADAS_DEFECTO, DIAS_CERRADAS_MAX);
    const vivasOCerradasRecientes = dias > 0 ? `(fa.abierta = 1 OR COALESCE(o.fecha_cierre, o.actualizado, o.creado) >= date('now', 'localtime', ?))` : 'fa.abierta = 1';
    const pCerradas = dias > 0 ? [`-${dias} days`] : [];
    const base = `FROM ot o JOIN estados e ON e.codigo = o.estado JOIN fases fa ON fa.codigo = e.fase WHERE ${vivasOCerradasRecientes} AND e.activo = 1${f.sql}`;
    const firma = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.version), 0) AS v, COALESCE(MAX(COALESCE(o.actualizado, o.creado)), '') AS m ${base}`).get(...pCerradas, ...f.params);
    const etag = `"${crypto.createHash('sha1').update(`v2|${firma.n}|${firma.v}|${firma.m}|${req.usuario.rol}|${req.usuario.id}|${dias}`).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const fases = db.prepare('SELECT codigo, nombre, orden, abierta FROM fases WHERE abierta = 1 OR ? > 0 ORDER BY orden').all(dias);
    const filas = db.prepare(`
      SELECT o.id, o.numero, o.estado, e.nombre AS estado_nombre, e.color AS estado_color, e.fase,
             o.etiqueta, et.nombre AS etiqueta_nombre, et.color AS etiqueta_color,
             o.prioridad, o.tipo, o.origen, o.sintoma, o.version, o.creado, o.actualizado, o.fecha_prevista,
             o.cliente_id, c.nombre AS cliente_nombre, c.zona AS cliente_zona,
             o.maquina_id, m.marca AS maquina_marca, m.modelo AS maquina_modelo, m.num_flota AS maquina_flota,
             o.tecnico_id, t.nombre AS tecnico_nombre,
             o.karve_estado, o.karve_operario, o.fecha_cierre,
             (SELECT b.dia || ' ' || b.hora_inicio FROM ot_bloques b WHERE b.ot_id = o.id AND b.dia >= date('now', 'localtime') ORDER BY b.dia, b.hora_inicio, b.id LIMIT 1) AS proximo_bloque,
             (SELECT u2.nombre FROM ot_bloques b JOIN usuarios u2 ON u2.id = b.tecnico_id WHERE b.ot_id = o.id AND b.dia >= date('now', 'localtime') ORDER BY b.dia, b.hora_inicio, b.id LIMIT 1) AS proximo_tecnico,
             (SELECT COUNT(*) FROM ot_bloques b WHERE b.ot_id = o.id AND b.dia >= date('now', 'localtime')) AS bloques_futuros
        FROM ot o
        JOIN estados e ON e.codigo = o.estado
        JOIN fases fa ON fa.codigo = e.fase
        JOIN clientes c ON c.id = o.cliente_id
        LEFT JOIN etiquetas et ON et.codigo = o.etiqueta
        LEFT JOIN maquinas m ON m.id = o.maquina_id
        LEFT JOIN usuarios t ON t.id = o.tecnico_id
       WHERE ${vivasOCerradasRecientes} AND e.activo = 1${f.sql}
       ORDER BY o.prioridad, COALESCE(o.fecha_prevista, '9999') , COALESCE(o.actualizado, o.creado) DESC, o.id DESC`).all(...pCerradas, ...f.params);
    const porFase = Object.fromEntries(fases.map((fa) => [fa.codigo, []]));
    for (const fila of filas) (porFase[fila.fase] || (porFase[fila.fase] = [])).push(fila);
    res.set('ETag', etag);
    res.json({
      generado: ahora(),
      total: filas.length,
      dias_cerradas: dias,
      fases: fases.map((fa) => ({ ...fa, ots: porFase[fa.codigo] })),
    });
  });

  // Alta. El número sigue la secuencia de Karve: se lee su máximo justo antes (F3.5-05) y nunca se asigna uno menor.
  r.post('/ot', requierePermiso('ot.crear'), async (req, res, next) => {
    let maximoKarve = 0;
    try { maximoKarve = (await leerMaximoKarve()) || 0; }
    catch (e) { console.warn(`${ahora()} numeración: no se ha podido leer el máximo de Karve (${e.message}); se usa el contador local`); }
    try {
      const id = altaOT(req, maximoKarve);
      res.status(201).json(detalleOT(req, id));
    } catch (e) { next(e); }
  });

  function altaOT(req, maximoKarve) {
    const b = req.body || {};
    const campos = leerCamposOT(b, false);
    comprobarMaquinaDeCliente(campos._maquina_cliente_id, campos.cliente_id);
    let estado;
    const codigoEstado = texto(b.estado, { nombre: 'estado', max: 50 });
    if (codigoEstado) {
      estado = stmt.estado.get(codigoEstado);
      if (!estado || !estado.es_inicial) throw new ErrorHttp(400, 'El estado indicado no es un estado inicial válido');
    } else {
      estado = stmt.estadoInicial.get();
      if (!estado) throw new ErrorHttp(500, 'No hay ningún estado inicial configurado');
    }
    const prioridad = campos.prioridad ?? estado.prioridad_defecto;

    const crear = db.transaction(() => {
      const num = siguienteNumeroOT({ minimo: maximoKarve });
      const info = db.prepare(`
        INSERT INTO ot (numero, anio, secuencia, cliente_id, maquina_id, estado, prioridad, tipo, origen, sintoma, descripcion, notas_internas, fecha_prevista, creado_por, creado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(num.numero, num.anio, num.secuencia, campos.cliente_id, campos.maquina_id ?? null, estado.codigo, prioridad,
          campos.tipo, campos.origen, campos.sintoma ?? null, campos.descripcion ?? null, campos.notas_internas ?? null, campos.fecha_prevista ?? null, req.usuario.id, ahora());
      stmt.historial.run(info.lastInsertRowid, null, estado.codigo, req.usuario.id, ahora(), 'Apertura de la O.T.');
      return info.lastInsertRowid;
    });
    return crear.immediate();
  }

  // Detalle: O.T. + historial + asignaciones + bloques + destinos posibles para el rol.
  r.get('/ot/:id', requierePermiso('ot.ver'), (req, res) => {
    res.json(detalleOT(req, idRuta(req.params.id)));
  });

  r.get('/ot/:id/historial', requierePermiso('ot.ver'), (req, res) => {
    const id = idRuta(req.params.id);
    cargarOT(req, id);
    res.json(stmt.leerHistorial.all(id));
  });

  // Edición con bloqueo optimista: `version` obligatoria; 409 si otro usuario la cambió.
  // `etiqueta` (F4-01) se puede cambiar aquí dentro de la misma vertical (null = quitarla); el cambio queda en el historial.
  r.put('/ot/:id', requierePermiso('ot.editar', 'ot.cambiar_estado'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const version = entero(b.version, { nombre: 'version', obligatorio: true, min: 1 });
    const ot = cargarOT(req, id);
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está en un estado final y no admite cambios');
    const soloEtiqueta = !puede(req.usuario.rol, 'ot.editar');
    const campos = soloEtiqueta ? {} : leerCamposOT(b, true);
    if (soloEtiqueta && Object.keys(b).some((k) => !['version', 'etiqueta'].includes(k))) throw new ErrorHttp(403, 'Tu rol solo puede cambiar la etiqueta de la O.T.');
    let nuevaEtiqueta;
    if (b.etiqueta !== undefined) {
      const et = comprobarEtiqueta(b.etiqueta, ot.estado);
      nuevaEtiqueta = et ? et.codigo : null;
      if (nuevaEtiqueta !== (ot.etiqueta ?? null)) campos.etiqueta = nuevaEtiqueta;
    }
    const clienteFinal = campos.cliente_id ?? ot.cliente_id;
    const maquinaFinal = campos.maquina_id === undefined ? ot.maquina_id : campos.maquina_id;
    if (maquinaFinal) {
      const m = stmt.maquina.get(maquinaFinal);
      comprobarMaquinaDeCliente(m ? m.cliente_id : null, clienteFinal);
    }
    delete campos._maquina_cliente_id;
    const columnas = Object.keys(campos);
    if (!columnas.length) throw new ErrorHttp(400, 'No hay ningún campo que actualizar');
    const set = columnas.map((c) => `${c} = ?`).join(', ');
    const actualizar = db.transaction(() => {
      const r2 = db.prepare(`UPDATE ot SET ${set}, version = version + 1, actualizado = ? WHERE id = ? AND version = ?`)
        .run(...columnas.map((c) => campos[c]), ahora(), id, version);
      if (r2.changes === 0) {
        const actual = stmt.otBloqueo.get(id);
        throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.', { version: actual ? actual.version : null });
      }
      if (campos.etiqueta !== undefined) {
        const nombre = campos.etiqueta ? stmt.etiqueta.get(campos.etiqueta).nombre : 'sin etiqueta';
        stmt.historial.run(id, ot.estado, ot.estado, req.usuario.id, ahora(), `Etiqueta: ${nombre}`);
      }
    });
    actualizar.immediate();
    res.json(detalleOT(req, id));
  });

  // Cambio de estado (flujo libre). Body: { estado, etiqueta?, tecnico_id?, nota?, version? }.
  r.post('/ot/:id/estado', requierePermiso('ot.cambiar_estado'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const destino = texto(b.estado, { nombre: 'estado', obligatorio: true, max: 50 });
    const etiqueta = texto(b.etiqueta, { nombre: 'etiqueta', max: 50 });
    const nota = texto(b.nota, { nombre: 'nota', max: 1000 });
    const version = entero(b.version, { nombre: 'version', min: 1 });
    const tecnicoId = b.tecnico_id === undefined || b.tecnico_id === null || b.tecnico_id === '' ? undefined : entero(b.tecnico_id, { nombre: 'tecnico_id', min: 1 });
    cargarOT(req, id); // alcance
    const cambio = db.transaction(() => aplicarCambioEstado({ otId: id, destino, etiqueta, tecnicoId, usuario: req.usuario, nota, versionEsperada: version })).immediate();
    res.json({ cambio, ot: detalleOT(req, id) });
  });

  // Proponer técnico. Si quien propone también puede aprobar y manda aprobar=true, se aprueba en el acto.
  r.post('/ot/:id/asignar', requierePermiso('ot.asignar'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const tecnicoId = entero(b.tecnico_id, { nombre: 'tecnico_id', obligatorio: true, min: 1 });
    const nota = texto(b.nota, { nombre: 'nota', max: 1000 });
    const ot = cargarOT(req, id);
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está en un estado final y no admite cambios');
    const tecnico = stmt.tecnico.get(tecnicoId);
    if (!tecnico) throw new ErrorHttp(400, 'El técnico no existe, no está activo o no tiene rol técnico/SAT');
    if (stmt.asignacionPendiente.get(id)) throw new ErrorHttp(409, 'Ya hay una propuesta de asignación pendiente para esta O.T.');
    const info = db.prepare(`INSERT INTO ot_asignaciones (ot_id, tecnico_id, origen, propuesto_por, estado, fecha, nota) VALUES (?, ?, 'manual', ?, 'propuesta', ?, ?)`)
      .run(id, tecnico.id, req.usuario.id, ahora(), nota);
    const asignacion = db.prepare('SELECT * FROM ot_asignaciones WHERE id = ?').get(info.lastInsertRowid);
    if (b.aprobar === true && puede(req.usuario.rol, 'ot.aprobar_asignacion')) {
      resolverAsignacion.immediate({ ot, asignacion, usuario: req.usuario, aprobar: true, nota: null });
    }
    res.status(201).json({ asignacion: db.prepare('SELECT * FROM ot_asignaciones WHERE id = ?').get(asignacion.id), ot: detalleOT(req, id) });
  });

  // Aprobar o rechazar una propuesta. Body: { aprobar: true|false, nota }.
  r.post('/ot/:id/asignacion/:aid/aprobar', requierePermiso('ot.aprobar_asignacion'), (req, res) => {
    const id = idRuta(req.params.id);
    const aid = idRuta(req.params.aid);
    const b = req.body || {};
    const aprobar = b.aprobar === undefined ? true : b.aprobar === true;
    const nota = texto(b.nota, { nombre: 'nota', max: 1000 });
    const ot = cargarOT(req, id);
    const asignacion = stmt.asignacion.get(aid, id);
    if (!asignacion) throw new ErrorHttp(404, 'Propuesta de asignación no encontrada');
    if (asignacion.estado !== 'propuesta') throw new ErrorHttp(409, `La propuesta ya está ${asignacion.estado}`);
    if (aprobar && ot.es_final) throw new ErrorHttp(400, 'La O.T. está en un estado final y no admite cambios');
    resolverAsignacion.immediate({ ot, asignacion, usuario: req.usuario, aprobar, nota });
    res.json({ asignacion: db.prepare('SELECT * FROM ot_asignaciones WHERE id = ?').get(aid), ot: detalleOT(req, id) });
  });

  app.use('/api', r);
};
// Para rutas-planificador.js (mismo alcance, mismo cambio de estado y mismo detalle que aquí).
Object.assign(module.exports, { filtroAlcance, cargarOT, detalleOT, aplicarCambioEstado });
