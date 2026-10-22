// rutas-ot.js — API de Órdenes de Trabajo: listado con alcance, alta, edición con bloqueo
// optimista, cambio de estado validado por transiciones, historial, asignaciones y Kanban.
//
// Reglas que se aplican SIEMPRE en el servidor:
//   - alcance del rol (permisos.js): técnico/SAT solo ven sus O.T.; comercial, sus clientes (pendiente de Karve).
//   - cada cambio de estado pasa por la tabla `transiciones` (origen, destino, rol) y escribe en `ot_historial`.
//   - cualquier UPDATE sobre `ot` incrementa `version`; el PUT exige la version que vio el cliente (409 si no coincide).

const express = require('express');
const crypto = require('crypto');
const { db, ahora } = require('./db');
const { siguienteNumeroOT } = require('./numeracion');
const { requierePermiso, puede, alcanceDe } = require('./permisos');
const { ErrorHttp, texto, entero, enumerado, idRuta } = require('./validar');

const TIPOS = ['correctivo', 'preventivo'];
const ORIGENES = ['manual', 'whatsapp', 'correo', 'auto'];
const LIMITE_DEFECTO = 200;
const LIMITE_MAX = 1000;

// ---------------------------------------------------------------------------
// Consultas base
// ---------------------------------------------------------------------------
const SELECT_OT = `
  SELECT o.*,
         c.nombre AS cliente_nombre, c.exige_pedido,
         m.marca AS maquina_marca, m.modelo AS maquina_modelo, m.bastidor AS maquina_bastidor, m.num_flota AS maquina_flota,
         e.nombre AS estado_nombre, e.fase, e.color AS estado_color, e.es_final,
         f.nombre AS fase_nombre, f.orden AS fase_orden, f.abierta AS fase_abierta,
         t.nombre AS tecnico_nombre,
         u.nombre AS creado_por_nombre
    FROM ot o
    JOIN clientes c ON c.id = o.cliente_id
    LEFT JOIN maquinas m ON m.id = o.maquina_id
    JOIN estados e ON e.codigo = o.estado
    JOIN fases f ON f.codigo = e.fase
    LEFT JOIN usuarios t ON t.id = o.tecnico_id
    LEFT JOIN usuarios u ON u.id = o.creado_por`;

const stmt = {
  estado: db.prepare('SELECT e.*, f.abierta AS fase_abierta FROM estados e JOIN fases f ON f.codigo = e.fase WHERE e.codigo = ? AND e.activo = 1'),
  estadoInicial: db.prepare('SELECT e.* FROM estados e JOIN fases f ON f.codigo = e.fase WHERE e.es_inicial = 1 AND e.activo = 1 ORDER BY f.orden, e.orden LIMIT 1'),
  transicion: db.prepare(`SELECT 1 FROM transiciones WHERE origen = ? AND destino = ? AND rol IN (?, '*') LIMIT 1`),
  destinos: db.prepare(`
    SELECT DISTINCT t.destino AS codigo, e.nombre, e.fase, e.color
      FROM transiciones t JOIN estados e ON e.codigo = t.destino JOIN fases f ON f.codigo = e.fase
     WHERE t.origen = ? AND t.rol IN (?, '*') AND e.activo = 1
     ORDER BY f.orden, e.orden`),
  otBloqueo: db.prepare('SELECT o.id, o.estado, o.version, o.tecnico_id, e.es_final FROM ot o JOIN estados e ON e.codigo = o.estado WHERE o.id = ?'),
  cambiarEstado: db.prepare('UPDATE ot SET estado = ?, version = version + 1, actualizado = ? WHERE id = ? AND version = ?'),
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
  asignacionPendiente: db.prepare(`SELECT id FROM ot_asignaciones WHERE ot_id = ? AND estado = 'propuesta' LIMIT 1`),
  asignacion: db.prepare('SELECT * FROM ot_asignaciones WHERE id = ? AND ot_id = ?'),
  tecnico: db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE id = ? AND activo = 1 AND rol IN ('tecnico', 'sat')`),
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
      // Pendiente (Fase 2/5): relación vendedor ↔ cliente desde Karve. En el prototipo, comercial ve todas.
      return { sql: '', params: [] };
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

function detalleOT(req, id) {
  const ot = cargarOT(req, id);
  return {
    ...ot,
    historial: stmt.leerHistorial.all(id),
    asignaciones: stmt.leerAsignaciones.all(id),
    transiciones: puede(req.usuario.rol, 'ot.cambiar_estado') ? stmt.destinos.all(ot.estado, req.usuario.rol) : [],
  };
}

// ---------------------------------------------------------------------------
// Cambio de estado (se usa desde /estado y desde la aprobación de asignación).
// Debe ejecutarse dentro de una transacción. Valida transición y versión, escribe historial.
// ---------------------------------------------------------------------------
function aplicarCambioEstado({ otId, destino, usuario, nota = null, versionEsperada = null }) {
  const actual = stmt.otBloqueo.get(otId);
  if (!actual) throw new ErrorHttp(404, 'O.T. no encontrada');
  if (versionEsperada !== null && actual.version !== versionEsperada) {
    throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.', { version: actual.version });
  }
  if (actual.es_final) throw new ErrorHttp(400, 'La O.T. está en un estado final y no admite cambios');
  if (actual.estado === destino) throw new ErrorHttp(400, 'La O.T. ya está en ese estado');
  const nuevo = stmt.estado.get(destino);
  if (!nuevo) throw new ErrorHttp(400, `El estado "${destino}" no existe`);
  if (!stmt.transicion.get(actual.estado, destino, usuario.rol)) {
    throw new ErrorHttp(403, `Tu rol no puede pasar la O.T. de "${actual.estado}" a "${destino}"`, { desde: actual.estado, hasta: destino });
  }
  const r = stmt.cambiarEstado.run(destino, ahora(), otId, actual.version);
  if (r.changes === 0) throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.');
  stmt.historial.run(otId, actual.estado, destino, usuario.id, ahora(), nota);
  return { anterior: actual.estado, nuevo: destino };
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
  if (ot.estado !== 'asignada' && stmt.transicion.get(ot.estado, 'asignada', usuario.rol)) {
    aplicarCambioEstado({ otId: ot.id, destino: 'asignada', usuario, nota: notaHist });
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

  // Kanban: O.T. vivas agrupadas por fase. Pensado para polling: ETag y 304 si nada cambió.
  r.get('/kanban', requierePermiso('kanban.ver'), (req, res) => {
    const f = filtroAlcance(req);
    const base = `FROM ot o JOIN estados e ON e.codigo = o.estado JOIN fases fa ON fa.codigo = e.fase WHERE fa.abierta = 1 AND e.activo = 1${f.sql}`;
    const firma = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(o.version), 0) AS v, COALESCE(MAX(COALESCE(o.actualizado, o.creado)), '') AS m ${base}`).get(...f.params);
    const etag = `"${crypto.createHash('sha1').update(`${firma.n}|${firma.v}|${firma.m}|${req.usuario.rol}`).digest('hex').slice(0, 20)}"`;
    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    const fases = db.prepare('SELECT codigo, nombre, orden FROM fases WHERE abierta = 1 ORDER BY orden').all();
    const filas = db.prepare(`
      SELECT o.id, o.numero, o.estado, e.nombre AS estado_nombre, e.color AS estado_color, e.fase,
             o.prioridad, o.tipo, o.origen, o.sintoma, o.version, o.creado, o.actualizado,
             o.cliente_id, c.nombre AS cliente_nombre,
             o.maquina_id, m.marca AS maquina_marca, m.modelo AS maquina_modelo, m.num_flota AS maquina_flota,
             o.tecnico_id, t.nombre AS tecnico_nombre
        FROM ot o
        JOIN estados e ON e.codigo = o.estado
        JOIN fases fa ON fa.codigo = e.fase
        JOIN clientes c ON c.id = o.cliente_id
        LEFT JOIN maquinas m ON m.id = o.maquina_id
        LEFT JOIN usuarios t ON t.id = o.tecnico_id
       WHERE fa.abierta = 1 AND e.activo = 1${f.sql}
       ORDER BY o.prioridad, COALESCE(o.actualizado, o.creado) DESC, o.id DESC`).all(...f.params);
    const porFase = Object.fromEntries(fases.map((fa) => [fa.codigo, []]));
    for (const fila of filas) (porFase[fila.fase] || (porFase[fila.fase] = [])).push(fila);
    res.set('ETag', etag);
    res.json({
      generado: ahora(),
      total: filas.length,
      fases: fases.map((fa) => ({ ...fa, ots: porFase[fa.codigo] })),
    });
  });

  // Alta.
  r.post('/ot', requierePermiso('ot.crear'), (req, res) => {
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
      const num = siguienteNumeroOT();
      const info = db.prepare(`
        INSERT INTO ot (numero, anio, secuencia, cliente_id, maquina_id, estado, prioridad, tipo, origen, sintoma, descripcion, notas_internas, creado_por, creado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(num.numero, num.anio, num.secuencia, campos.cliente_id, campos.maquina_id ?? null, estado.codigo, prioridad,
          campos.tipo, campos.origen, campos.sintoma ?? null, campos.descripcion ?? null, campos.notas_internas ?? null, req.usuario.id, ahora());
      stmt.historial.run(info.lastInsertRowid, null, estado.codigo, req.usuario.id, ahora(), 'Apertura de la O.T.');
      return info.lastInsertRowid;
    });
    const id = crear.immediate();
    res.status(201).json(detalleOT(req, id));
  });

  // Detalle: O.T. + historial + asignaciones + transiciones posibles para el rol.
  r.get('/ot/:id', requierePermiso('ot.ver'), (req, res) => {
    res.json(detalleOT(req, idRuta(req.params.id)));
  });

  r.get('/ot/:id/historial', requierePermiso('ot.ver'), (req, res) => {
    const id = idRuta(req.params.id);
    cargarOT(req, id);
    res.json(stmt.leerHistorial.all(id));
  });

  // Edición con bloqueo optimista: `version` obligatoria; 409 si otro usuario la cambió.
  r.put('/ot/:id', requierePermiso('ot.editar'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const version = entero(b.version, { nombre: 'version', obligatorio: true, min: 1 });
    const ot = cargarOT(req, id);
    if (ot.es_final) throw new ErrorHttp(400, 'La O.T. está en un estado final y no admite cambios');
    const campos = leerCamposOT(b, true);
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
    const r2 = db.prepare(`UPDATE ot SET ${set}, version = version + 1, actualizado = ? WHERE id = ? AND version = ?`)
      .run(...columnas.map((c) => campos[c]), ahora(), id, version);
    if (r2.changes === 0) {
      const actual = stmt.otBloqueo.get(id);
      throw new ErrorHttp(409, 'La O.T. ha sido modificada por otro usuario. Recarga y vuelve a intentarlo.', { version: actual ? actual.version : null });
    }
    res.json(detalleOT(req, id));
  });

  // Cambio de estado.
  r.post('/ot/:id/estado', requierePermiso('ot.cambiar_estado'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const destino = texto(b.estado, { nombre: 'estado', obligatorio: true, max: 50 });
    const nota = texto(b.nota, { nombre: 'nota', max: 1000 });
    const version = entero(b.version, { nombre: 'version', min: 1 });
    cargarOT(req, id); // alcance
    const cambio = db.transaction(() => aplicarCambioEstado({ otId: id, destino, usuario: req.usuario, nota, versionEsperada: version })).immediate();
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
