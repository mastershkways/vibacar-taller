// rutas-maestros.js — API de maestros: clientes, máquinas, estados/fases/transiciones, usuarios.
//
// Todas las rutas cuelgan de /api y ya pasan por requiereSesion (server.js). Aquí se aplica
// requierePermiso() de permisos.js en cada una.

const express = require('express');
const { db, ahora, hashClave } = require('./db');
const { requierePermiso, esRolValido, ROLES } = require('./permisos');
const { ErrorHttp, texto, entero, booleano, idRuta } = require('./validar');

// UPDATE parcial: solo las columnas presentes en `cambios` (valor undefined = no tocar).
function actualizarParcial(tabla, id, cambios) {
  const columnas = Object.keys(cambios).filter((k) => cambios[k] !== undefined);
  if (!columnas.length) throw new ErrorHttp(400, 'No hay ningún campo que actualizar');
  const set = columnas.map((c) => `${c} = ?`).join(', ');
  const valores = columnas.map((c) => cambios[c]);
  const r = db.prepare(`UPDATE ${tabla} SET ${set}, actualizado = ? WHERE id = ?`).run(...valores, ahora(), id);
  if (r.changes === 0) throw new ErrorHttp(404, 'No encontrado');
}

const COLUMNAS_USUARIO = 'id, usuario, nombre, rol, email, activo, origen, karve_id, ultimo_acceso, creado, actualizado';

module.exports = function montarRutasMaestros(app) {
  const r = express.Router();

  // -------------------------------------------------------------------------
  // Clientes — espejo local del maestro de Karve (Fase 5). Baja lógica con `activo`;
  // `origen` (manual | karve) y `karve_id` los fijará la sincronización, no la API.
  // -------------------------------------------------------------------------
  r.get('/clientes', requierePermiso('clientes.ver'), (req, res) => {
    const q = texto(req.query.q, { nombre: 'q', max: 100 });
    const todos = req.query.todos === '1';
    let sql = 'SELECT * FROM clientes WHERE 1 = 1';
    const p = [];
    if (!todos) sql += ' AND activo = 1';
    if (q) {
      sql += ' AND (nombre LIKE ? OR cif LIKE ? OR karve_id LIKE ? OR email LIKE ? OR telefono LIKE ?)';
      p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY activo DESC, nombre COLLATE NOCASE LIMIT 500';
    res.json(db.prepare(sql).all(...p));
  });

  r.get('/clientes/:id', requierePermiso('clientes.ver'), (req, res) => {
    const id = idRuta(req.params.id);
    const cliente = db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
    if (!cliente) throw new ErrorHttp(404, 'Cliente no encontrado');
    const maquinas = db.prepare('SELECT * FROM maquinas WHERE cliente_id = ? ORDER BY activo DESC, marca, modelo').all(id);
    res.json({ ...cliente, maquinas });
  });

  function leerCliente(body, parcial) {
    const email = texto(body.email, { nombre: 'email', max: 200 });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErrorHttp(400, 'El email no tiene un formato válido');
    const cif = texto(body.cif, { nombre: 'cif', max: 20 });
    return {
      nombre: texto(body.nombre, { nombre: 'nombre', obligatorio: !parcial, max: 200 }) ?? undefined,
      cif: (cif ? cif.toUpperCase().replace(/[\s-]/g, '') : null) ?? (parcial && body.cif === undefined ? undefined : null),
      email: email ?? (parcial && body.email === undefined ? undefined : null),
      telefono: texto(body.telefono, { nombre: 'telefono', max: 50 }) ?? (parcial && body.telefono === undefined ? undefined : null),
      direccion: texto(body.direccion, { nombre: 'direccion', max: 300 }) ?? (parcial && body.direccion === undefined ? undefined : null),
      exige_pedido: booleano(body.exige_pedido) ?? (parcial ? undefined : 0),
      karve_id: texto(body.karve_id, { nombre: 'karve_id', max: 50 }) ?? (parcial && body.karve_id === undefined ? undefined : null),
      activo: booleano(body.activo),
    };
  }

  // Un NIF/CIF no puede repetirse entre clientes (como en el ERP). `idPropio` excluye al que se edita.
  function comprobarCifLibre(cif, idPropio = null) {
    if (!cif) return;
    const otro = db.prepare('SELECT id, nombre FROM clientes WHERE cif = ? AND id != ?').get(cif, idPropio || 0);
    if (otro) throw new ErrorHttp(409, `Ya existe un cliente con el NIF/CIF ${cif}: "${otro.nombre}"`, { cliente_id: otro.id });
  }

  r.post('/clientes', requierePermiso('clientes.gestionar'), (req, res) => {
    const c = leerCliente(req.body || {}, false);
    comprobarCifLibre(c.cif);
    const info = db.prepare('INSERT INTO clientes (nombre, cif, email, telefono, direccion, exige_pedido, karve_id, origen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.nombre, c.cif, c.email, c.telefono, c.direccion, c.exige_pedido, c.karve_id, 'manual');
    res.status(201).json(db.prepare('SELECT * FROM clientes WHERE id = ?').get(info.lastInsertRowid));
  });

  // Edición parcial. Desactivar (baja lógica) = PUT { activo: false }; reactivar = PUT { activo: true }.
  r.put('/clientes/:id', requierePermiso('clientes.gestionar'), (req, res) => {
    const id = idRuta(req.params.id);
    if (!db.prepare('SELECT 1 FROM clientes WHERE id = ?').get(id)) throw new ErrorHttp(404, 'Cliente no encontrado');
    const c = leerCliente(req.body || {}, true);
    if (c.cif) comprobarCifLibre(c.cif, id);
    actualizarParcial('clientes', id, c);
    res.json(db.prepare('SELECT * FROM clientes WHERE id = ?').get(id));
  });

  // -------------------------------------------------------------------------
  // Máquinas
  // -------------------------------------------------------------------------
  r.get('/maquinas', requierePermiso('maquinas.ver'), (req, res) => {
    const clienteId = entero(req.query.cliente_id, { nombre: 'cliente_id', min: 1 });
    const q = texto(req.query.q, { nombre: 'q', max: 100 });
    const todos = req.query.todos === '1';
    let sql = `SELECT m.*, c.nombre AS cliente_nombre FROM maquinas m JOIN clientes c ON c.id = m.cliente_id WHERE 1 = 1`;
    const p = [];
    if (!todos) sql += ' AND m.activo = 1';
    if (clienteId) { sql += ' AND m.cliente_id = ?'; p.push(clienteId); }
    if (q) { sql += ' AND (m.marca LIKE ? OR m.modelo LIKE ? OR m.bastidor LIKE ? OR m.num_flota LIKE ?)'; p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    sql += ' ORDER BY c.nombre COLLATE NOCASE, m.marca, m.modelo LIMIT 500';
    res.json(db.prepare(sql).all(...p));
  });

  function comprobarCliente(clienteId) {
    const c = db.prepare('SELECT id, activo FROM clientes WHERE id = ?').get(clienteId);
    if (!c) throw new ErrorHttp(400, 'El cliente no existe');
    if (!c.activo) throw new ErrorHttp(400, 'El cliente está desactivado');
  }

  function leerMaquina(body, parcial) {
    const clienteId = entero(body.cliente_id, { nombre: 'cliente_id', obligatorio: !parcial, min: 1 });
    if (clienteId !== null) comprobarCliente(clienteId);
    const horometro = body.horometro_ultimo === undefined || body.horometro_ultimo === null || body.horometro_ultimo === ''
      ? (parcial ? undefined : null)
      : Number(body.horometro_ultimo);
    if (horometro !== undefined && horometro !== null && (!Number.isFinite(horometro) || horometro < 0)) throw new ErrorHttp(400, '"horometro_ultimo" no es válido');
    const opc = (campo, max) => texto(body[campo], { nombre: campo, max }) ?? (parcial && body[campo] === undefined ? undefined : null);
    return {
      cliente_id: clienteId ?? undefined,
      marca: opc('marca', 100),
      modelo: opc('modelo', 100),
      bastidor: opc('bastidor', 100),
      num_flota: opc('num_flota', 50),
      horometro_ultimo: horometro,
      karve_id: opc('karve_id', 50),
      activo: booleano(body.activo),
    };
  }

  r.post('/maquinas', requierePermiso('maquinas.gestionar'), (req, res) => {
    const m = leerMaquina(req.body || {}, false);
    if (!m.marca && !m.modelo && !m.bastidor && !m.num_flota) throw new ErrorHttp(400, 'Indica al menos marca, modelo, bastidor o nº de flota');
    const info = db.prepare(`INSERT INTO maquinas (cliente_id, marca, modelo, bastidor, num_flota, horometro_ultimo, karve_id)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(m.cliente_id, m.marca, m.modelo, m.bastidor, m.num_flota, m.horometro_ultimo, m.karve_id);
    res.status(201).json(db.prepare('SELECT * FROM maquinas WHERE id = ?').get(info.lastInsertRowid));
  });

  r.put('/maquinas/:id', requierePermiso('maquinas.gestionar'), (req, res) => {
    const id = idRuta(req.params.id);
    actualizarParcial('maquinas', id, leerMaquina(req.body || {}, true));
    res.json(db.prepare('SELECT * FROM maquinas WHERE id = ?').get(id));
  });

  // -------------------------------------------------------------------------
  // Estados, fases y transiciones (las transiciones, filtradas por el rol del usuario)
  // -------------------------------------------------------------------------
  r.get('/estados', requierePermiso('ot.ver'), (req, res) => {
    const fases = db.prepare('SELECT codigo, nombre, orden, abierta FROM fases ORDER BY orden').all();
    const estados = db.prepare(`
      SELECT e.codigo, e.nombre, e.fase, e.orden, e.es_inicial, e.es_final, e.prioridad_defecto, e.color
        FROM estados e JOIN fases f ON f.codigo = e.fase
       WHERE e.activo = 1
       ORDER BY f.orden, e.orden, e.codigo`).all();
    const transiciones = db.prepare(`SELECT DISTINCT origen, destino FROM transiciones WHERE rol IN (?, '*') ORDER BY origen, destino`).all(req.usuario.rol);
    res.json({ fases, estados, transiciones });
  });

  // -------------------------------------------------------------------------
  // Usuarios (solo admin) y lista de técnicos (para asignar)
  // -------------------------------------------------------------------------
  r.get('/tecnicos', requierePermiso('ot.asignar', 'ot.aprobar_asignacion'), (req, res) => {
    res.json(db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE activo = 1 AND rol IN ('tecnico', 'sat') ORDER BY nombre COLLATE NOCASE`).all());
  });

  r.get('/usuarios', requierePermiso('usuarios.gestionar'), (req, res) => {
    res.json({
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.nombre])),
      usuarios: db.prepare(`SELECT ${COLUMNAS_USUARIO} FROM usuarios ORDER BY activo DESC, nombre COLLATE NOCASE`).all(),
    });
  });

  r.post('/usuarios', requierePermiso('usuarios.gestionar'), (req, res) => {
    const b = req.body || {};
    const usuario = texto(b.usuario, { nombre: 'usuario', obligatorio: true, max: 40 });
    if (!/^[a-z0-9._-]{3,40}$/i.test(usuario)) throw new ErrorHttp(400, 'El usuario debe tener 3-40 caracteres: letras, números, punto, guion o guion bajo');
    const nombre = texto(b.nombre, { nombre: 'nombre', obligatorio: true, max: 120 });
    const clave = typeof b.clave === 'string' ? b.clave : '';
    if (clave.length < 6) throw new ErrorHttp(400, 'La contraseña debe tener al menos 6 caracteres');
    const rol = texto(b.rol, { nombre: 'rol', obligatorio: true, max: 30 });
    if (!esRolValido(rol)) throw new ErrorHttp(400, `Rol no válido. Válidos: ${Object.keys(ROLES).join(', ')}`);
    const email = texto(b.email, { nombre: 'email', max: 200 });
    if (db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(usuario)) throw new ErrorHttp(409, 'Ya existe un usuario con ese nombre');
    const info = db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol, email) VALUES (?, ?, ?, ?, ?)')
      .run(usuario, nombre, hashClave(clave), rol, email);
    res.status(201).json(db.prepare(`SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`).get(info.lastInsertRowid));
  });

  r.put('/usuarios/:id', requierePermiso('usuarios.gestionar'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const existente = db.prepare('SELECT id, rol, activo FROM usuarios WHERE id = ?').get(id);
    if (!existente) throw new ErrorHttp(404, 'Usuario no encontrado');
    const cambios = {
      nombre: texto(b.nombre, { nombre: 'nombre', max: 120 }) ?? undefined,
      email: texto(b.email, { nombre: 'email', max: 200 }) ?? (b.email === undefined ? undefined : null),
      rol: texto(b.rol, { nombre: 'rol', max: 30 }) ?? undefined,
      activo: booleano(b.activo),
    };
    if (cambios.rol !== undefined && !esRolValido(cambios.rol)) throw new ErrorHttp(400, `Rol no válido. Válidos: ${Object.keys(ROLES).join(', ')}`);
    if (id === req.usuario.id) {
      if (cambios.activo === 0) throw new ErrorHttp(400, 'No puedes desactivar tu propio usuario');
      if (cambios.rol !== undefined && cambios.rol !== existente.rol) throw new ErrorHttp(400, 'No puedes cambiar tu propio rol');
    }
    if (typeof b.clave === 'string' && b.clave.length) {
      if (b.clave.length < 6) throw new ErrorHttp(400, 'La contraseña debe tener al menos 6 caracteres');
      cambios.clave_hash = hashClave(b.clave);
    }
    actualizarParcial('usuarios', id, cambios);
    if (cambios.activo === 0) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id); // expulsar al desactivar
    res.json(db.prepare(`SELECT ${COLUMNAS_USUARIO} FROM usuarios WHERE id = ?`).get(id));
  });

  app.use('/api', r);
};
