// rutas-maestros.js — API de maestros: clientes, máquinas, estados/fases/transiciones, usuarios.
//
// Todas las rutas cuelgan de /api y ya pasan por requiereSesion (server.js). Aquí se aplica
// requierePermiso() de permisos.js en cada una.

const express = require('express');
const { db, ahora, hashClave } = require('./db');
const { requierePermiso, esRolValido, alcanceDe, ROLES } = require('./permisos');
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
  // F2-05: `comercial_id` = comercial responsable (cartera). El alcance `clientes_propios` (rol comercial)
  // solo deja ver los clientes de su cartera, sus máquinas y sus O.T. (rutas-ot.js); fuera de alcance = 404.
  // F3-03: contactos (compras, técnico, facturas) y `ultima_factura`. Regla de 3 años: un cliente sin factura en
  // los últimos 3 años es "antiguo" y no sale en el listado salvo con ?todos=1. La baja manual (`activo`) ya no
  // se gestiona desde la API: la columna se conserva y las bajas heredadas solo aparecen con ?todos=1.
  // -------------------------------------------------------------------------
  const soloMisClientes = (req) => alcanceDe(req.usuario.rol) === 'clientes_propios';
  const ANTIGUO_SQL = "(c.ultima_factura IS NOT NULL AND c.ultima_factura < date('now', '-3 years'))";
  const COLUMNAS_CLIENTE = `c.*, v.nombre AS comercial_nombre, CASE WHEN ${ANTIGUO_SQL} THEN 1 ELSE 0 END AS antiguo`;
  const leerClienteBD = (id) => db.prepare(`SELECT ${COLUMNAS_CLIENTE} FROM clientes c LEFT JOIN usuarios v ON v.id = c.comercial_id WHERE c.id = ?`).get(id);

  r.get('/clientes', requierePermiso('clientes.ver'), (req, res) => {
    const q = texto(req.query.q, { nombre: 'q', max: 100 });
    const todos = req.query.todos === '1';
    let sql = `SELECT ${COLUMNAS_CLIENTE} FROM clientes c LEFT JOIN usuarios v ON v.id = c.comercial_id WHERE 1 = 1`;
    const p = [];
    if (!todos) sql += ` AND c.activo = 1 AND NOT ${ANTIGUO_SQL}`;
    if (soloMisClientes(req)) { sql += ' AND c.comercial_id = ?'; p.push(req.usuario.id); }
    if (q) {
      sql += ' AND (c.nombre LIKE ? OR c.cif LIKE ? OR c.karve_id LIKE ? OR c.email LIKE ? OR c.telefono LIKE ? OR c.compras_nombre LIKE ? OR c.tecnico_nombre LIKE ?)';
      p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ` ORDER BY c.activo DESC, ${ANTIGUO_SQL} ASC, c.nombre COLLATE NOCASE LIMIT 500`; // antiguos y bajas al final
    res.json(db.prepare(sql).all(...p));
  });

  // Comerciales activos (comercial o jefe comercial), para el selector "Comercial responsable" de la ficha del cliente.
  const ROLES_COMERCIALES = ['comercial', 'comercial_jefe'];
  r.get('/comerciales', requierePermiso('clientes.gestionar'), (req, res) => {
    res.json(db.prepare(`SELECT id, nombre FROM usuarios WHERE activo = 1 AND rol IN ('comercial', 'comercial_jefe') ORDER BY nombre COLLATE NOCASE`).all());
  });

  r.get('/clientes/:id', requierePermiso('clientes.ver'), (req, res) => {
    const id = idRuta(req.params.id);
    const cliente = leerClienteBD(id);
    if (!cliente || (soloMisClientes(req) && cliente.comercial_id !== req.usuario.id)) throw new ErrorHttp(404, 'Cliente no encontrado');
    const maquinas = db.prepare('SELECT * FROM maquinas WHERE cliente_id = ? ORDER BY activo DESC, marca, modelo').all(id);
    res.json({ ...cliente, maquinas });
  });

  const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function leerCliente(body, parcial) {
    // Campo opcional: vacío → null; ausente en un PUT parcial → undefined (no se toca).
    const opc = (campo, max) => texto(body[campo], { nombre: campo, max }) ?? (parcial && body[campo] === undefined ? undefined : null);
    const correo = (campo) => { const v = opc(campo, 200); if (v && !RE_EMAIL.test(v)) throw new ErrorHttp(400, `El email de "${campo}" no tiene un formato válido`); return v; };
    const cif = texto(body.cif, { nombre: 'cif', max: 20 });
    const ultima = opc('ultima_factura', 10);
    if (ultima && (!/^\d{4}-\d{2}-\d{2}$/.test(ultima) || Number.isNaN(Date.parse(ultima)))) throw new ErrorHttp(400, 'La fecha de última factura debe ser AAAA-MM-DD');
    const comercialId = entero(body.comercial_id, { nombre: 'comercial_id', min: 1 });
    if (comercialId) {
      const v = db.prepare('SELECT id, rol, activo FROM usuarios WHERE id = ?').get(comercialId);
      if (!v || !ROLES_COMERCIALES.includes(v.rol)) throw new ErrorHttp(400, 'El comercial responsable debe ser un usuario con rol comercial');
      if (!v.activo) throw new ErrorHttp(400, 'El comercial responsable está desactivado');
    }
    return {
      nombre: texto(body.nombre, { nombre: 'nombre', obligatorio: !parcial, max: 200 }) ?? undefined,
      comercial_id: comercialId ?? (parcial && body.comercial_id === undefined ? undefined : null),
      cif: (cif ? cif.toUpperCase().replace(/[\s-]/g, '') : null) ?? (parcial && body.cif === undefined ? undefined : null),
      email: correo('email'),
      telefono: opc('telefono', 50),
      direccion: opc('direccion', 300),
      compras_nombre: opc('compras_nombre', 120),
      compras_telefono: opc('compras_telefono', 50),
      tecnico_nombre: opc('tecnico_nombre', 120),
      tecnico_telefono: opc('tecnico_telefono', 50),
      tecnico_email: correo('tecnico_email'),
      email_facturas: correo('email_facturas'),
      ultima_factura: ultima,
      exige_pedido: booleano(body.exige_pedido) ?? (parcial ? undefined : 0),
      karve_id: opc('karve_id', 50),
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
    const info = db.prepare(`INSERT INTO clientes (nombre, cif, email, telefono, direccion, exige_pedido, karve_id, comercial_id, compras_nombre, compras_telefono,
      tecnico_nombre, tecnico_telefono, tecnico_email, email_facturas, ultima_factura, origen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')`)
      .run(c.nombre, c.cif, c.email, c.telefono, c.direccion, c.exige_pedido, c.karve_id, c.comercial_id, c.compras_nombre, c.compras_telefono,
        c.tecnico_nombre, c.tecnico_telefono, c.tecnico_email, c.email_facturas, c.ultima_factura);
    res.status(201).json(leerClienteBD(info.lastInsertRowid));
  });

  // Edición parcial. Desde F3-03 no hay baja manual: `activo` se ignora (la "baja" es no facturar en 3 años).
  r.put('/clientes/:id', requierePermiso('clientes.gestionar'), (req, res) => {
    const id = idRuta(req.params.id);
    if (!db.prepare('SELECT 1 FROM clientes WHERE id = ?').get(id)) throw new ErrorHttp(404, 'Cliente no encontrado');
    const c = leerCliente(req.body || {}, true);
    if (c.cif) comprobarCifLibre(c.cif, id);
    actualizarParcial('clientes', id, c);
    res.json(leerClienteBD(id));
  });

  // -------------------------------------------------------------------------
  // Máquinas — espejo local del maestro de Karve (Fase 5), igual que clientes: baja lógica con
  // `activo`; `origen` (manual | karve) y `karve_id` los fijará la sincronización, no la API.
  // Cada máquina pertenece a un cliente, y solo se asigna (o se cambia) a un cliente activo.
  // -------------------------------------------------------------------------
  const COLUMNAS_MAQUINA = `m.*, c.nombre AS cliente_nombre, c.activo AS cliente_activo, c.comercial_id AS cliente_comercial_id,
    (SELECT COUNT(*) FROM ot o WHERE o.maquina_id = m.id) AS num_ot`;
  const leerMaquinaBD = (id) => db.prepare(`SELECT ${COLUMNAS_MAQUINA} FROM maquinas m JOIN clientes c ON c.id = m.cliente_id WHERE m.id = ?`).get(id);

  r.get('/maquinas', requierePermiso('maquinas.ver'), (req, res) => {
    const clienteId = entero(req.query.cliente_id, { nombre: 'cliente_id', min: 1 });
    const q = texto(req.query.q, { nombre: 'q', max: 100 });
    const todos = req.query.todos === '1';
    let sql = `SELECT ${COLUMNAS_MAQUINA} FROM maquinas m JOIN clientes c ON c.id = m.cliente_id WHERE 1 = 1`;
    const p = [];
    if (!todos) sql += ' AND m.activo = 1';
    if (soloMisClientes(req)) { sql += ' AND c.comercial_id = ?'; p.push(req.usuario.id); }
    if (clienteId) { sql += ' AND m.cliente_id = ?'; p.push(clienteId); }
    if (q) {
      sql += ' AND (m.marca LIKE ? OR m.modelo LIKE ? OR m.bastidor LIKE ? OR m.num_flota LIKE ? OR m.karve_id LIKE ? OR c.nombre LIKE ?)';
      p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY m.activo DESC, c.nombre COLLATE NOCASE, m.marca COLLATE NOCASE, m.modelo COLLATE NOCASE LIMIT 500';
    res.json(db.prepare(sql).all(...p));
  });

  r.get('/maquinas/:id', requierePermiso('maquinas.ver'), (req, res) => {
    const m = leerMaquinaBD(idRuta(req.params.id));
    if (!m || (soloMisClientes(req) && m.cliente_comercial_id !== req.usuario.id)) throw new ErrorHttp(404, 'Máquina no encontrada');
    res.json(m);
  });

  function comprobarCliente(clienteId) {
    const c = db.prepare('SELECT id, activo FROM clientes WHERE id = ?').get(clienteId);
    if (!c) throw new ErrorHttp(400, 'El cliente no existe');
    if (!c.activo) throw new ErrorHttp(400, 'El cliente está desactivado: no se le pueden asignar máquinas');
  }

  // Un bastidor (nº de serie) identifica una sola máquina. `idPropio` excluye a la que se edita.
  function comprobarBastidorLibre(bastidor, idPropio = null) {
    if (!bastidor) return;
    const otra = db.prepare('SELECT m.id, m.marca, m.modelo, c.nombre AS cliente FROM maquinas m JOIN clientes c ON c.id = m.cliente_id WHERE m.bastidor = ? AND m.id != ?').get(bastidor, idPropio || 0);
    if (otra) throw new ErrorHttp(409, `Ya existe una máquina con el bastidor ${bastidor}: ${[otra.marca, otra.modelo].filter(Boolean).join(' ') || 'sin marca'} de "${otra.cliente}"`, { maquina_id: otra.id });
  }

  function leerMaquina(body, parcial) {
    const clienteId = entero(body.cliente_id, { nombre: 'cliente_id', obligatorio: !parcial, min: 1 });
    if (clienteId !== null) comprobarCliente(clienteId);
    const horometro = body.horometro_ultimo === undefined || body.horometro_ultimo === null || body.horometro_ultimo === ''
      ? (parcial ? undefined : null)
      : Number(body.horometro_ultimo);
    if (horometro !== undefined && horometro !== null && (!Number.isFinite(horometro) || horometro < 0)) throw new ErrorHttp(400, '"horometro_ultimo" no es válido');
    const opc = (campo, max) => texto(body[campo], { nombre: campo, max }) ?? (parcial && body[campo] === undefined ? undefined : null);
    const bastidor = opc('bastidor', 100);
    return {
      cliente_id: clienteId ?? undefined,
      marca: opc('marca', 100),
      modelo: opc('modelo', 100),
      bastidor: bastidor ? bastidor.toUpperCase() : bastidor, // los bastidores se guardan en mayúsculas
      num_flota: opc('num_flota', 50),
      horometro_ultimo: horometro,
      observaciones: opc('observaciones', 2000),
      karve_id: opc('karve_id', 50),
      activo: booleano(body.activo),
    };
  }

  r.post('/maquinas', requierePermiso('maquinas.gestionar'), (req, res) => {
    const m = leerMaquina(req.body || {}, false);
    if (!m.marca && !m.modelo && !m.bastidor && !m.num_flota) throw new ErrorHttp(400, 'Indica al menos marca, modelo, bastidor o nº de flota');
    comprobarBastidorLibre(m.bastidor);
    const info = db.prepare(`INSERT INTO maquinas (cliente_id, marca, modelo, bastidor, num_flota, horometro_ultimo, observaciones, karve_id, origen)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`)
      .run(m.cliente_id, m.marca, m.modelo, m.bastidor, m.num_flota, m.horometro_ultimo, m.observaciones, m.karve_id);
    res.status(201).json(leerMaquinaBD(info.lastInsertRowid));
  });

  // Edición parcial. Desactivar (baja lógica) = PUT { activo: false }; reactivar = PUT { activo: true }.
  // Si no viene cliente_id no se comprueba el cliente: una máquina de un cliente de baja se puede seguir editando.
  r.put('/maquinas/:id', requierePermiso('maquinas.gestionar'), (req, res) => {
    const id = idRuta(req.params.id);
    if (!db.prepare('SELECT 1 FROM maquinas WHERE id = ?').get(id)) throw new ErrorHttp(404, 'Máquina no encontrada');
    const m = leerMaquina(req.body || {}, true);
    if (m.bastidor) comprobarBastidorLibre(m.bastidor, id);
    actualizarParcial('maquinas', id, m);
    res.json(leerMaquinaBD(id));
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
  // Usuarios (usuarios.gestionar, hoy solo admontaller) y lista de técnicos (para asignar).
  // El acceso web (clave scrypt, rol, activo) es exclusivo de esta app; `karve_id` enlaza al operario con su
  // ficha en Karve para imputar horas en la Fase 5. `origen` lo fijará la sincronización, no la API.
  // Baja lógica con `activo`: el login (auth.js) solo admite activos y al desactivar se expulsan sus sesiones.
  // -------------------------------------------------------------------------
  r.get('/tecnicos', requierePermiso('ot.asignar', 'ot.aprobar_asignacion'), (req, res) => {
    res.json(db.prepare(`SELECT id, nombre, rol FROM usuarios WHERE activo = 1 AND rol IN ('tecnico', 'sat') ORDER BY nombre COLLATE NOCASE`).all());
  });

  const COLUMNAS_USUARIO_FICHA = `${COLUMNAS_USUARIO.split(', ').map((c) => 'u.' + c).join(', ')},
    (SELECT COUNT(*) FROM ot o WHERE o.tecnico_id = u.id) AS num_ot`;
  const leerUsuarioBD = (id) => db.prepare(`SELECT ${COLUMNAS_USUARIO_FICHA} FROM usuarios u WHERE u.id = ?`).get(id);
  const listaRoles = () => Object.entries(ROLES).map(([codigo, v]) => ({ codigo, nombre: v.nombre, grupo: v.grupo, alcance: v.alcance }));

  // Campos comunes de alta y edición. En la edición (parcial) un campo que no viene no se toca; email y karve_id vacíos → null.
  // La contraseña es obligatoria al crear; al editar solo se cambia el hash si viene una nueva.
  function leerUsuario(b, { parcial = false } = {}) {
    const usuario = texto(b.usuario, { nombre: 'usuario', obligatorio: !parcial, max: 40 });
    if (usuario !== null && !/^[a-z0-9._-]{3,40}$/i.test(usuario)) throw new ErrorHttp(400, 'El usuario debe tener 3-40 caracteres: letras, números, punto, guion o guion bajo');
    const nombre = texto(b.nombre, { nombre: 'nombre', obligatorio: !parcial, max: 120 });
    const email = texto(b.email, { nombre: 'email', max: 200 });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErrorHttp(400, 'El email no tiene un formato válido');
    const rol = texto(b.rol, { nombre: 'rol', obligatorio: !parcial, max: 30 });
    if (rol !== null && !esRolValido(rol)) throw new ErrorHttp(400, `Rol no válido. Válidos: ${Object.keys(ROLES).join(', ')}`);
    const karveId = texto(b.karve_id, { nombre: 'karve_id', max: 40 });
    const clave = typeof b.clave === 'string' ? b.clave : '';
    if ((!parcial || clave.length) && clave.length < 6) throw new ErrorHttp(400, 'La contraseña debe tener al menos 6 caracteres');
    const vacioONoTocar = (campo, valor) => valor ?? (parcial && b[campo] === undefined ? undefined : null);
    return {
      usuario: usuario ?? undefined,
      nombre: nombre ?? undefined,
      email: vacioONoTocar('email', email),
      rol: rol ?? undefined,
      karve_id: vacioONoTocar('karve_id', karveId),
      clave_hash: clave.length ? hashClave(clave) : undefined,
    };
  }
  function comprobarLoginLibre(usuario, idPropio = 0) {
    if (!usuario) return;
    const otro = db.prepare('SELECT id, nombre FROM usuarios WHERE usuario = ? AND id <> ?').get(usuario, idPropio);
    if (otro) throw new ErrorHttp(409, `Ya existe un usuario con el login "${usuario}": ${otro.nombre}`, { usuario_id: otro.id });
  }

  r.get('/usuarios', requierePermiso('usuarios.gestionar'), (req, res) => {
    const q = texto(req.query.q, { nombre: 'q', max: 100 });
    const todos = req.query.todos === '1';
    let sql = `SELECT ${COLUMNAS_USUARIO_FICHA} FROM usuarios u WHERE 1 = 1`;
    const p = [];
    if (!todos) sql += ' AND u.activo = 1';
    if (q) {
      sql += ' AND (u.usuario LIKE ? OR u.nombre LIKE ? OR u.email LIKE ? OR u.karve_id LIKE ?)';
      p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    sql += ' ORDER BY u.activo DESC, u.nombre COLLATE NOCASE LIMIT 500';
    res.json({ roles: listaRoles(), usuarios: db.prepare(sql).all(...p) });
  });

  r.get('/usuarios/:id', requierePermiso('usuarios.gestionar'), (req, res) => {
    const u = leerUsuarioBD(idRuta(req.params.id));
    if (!u) throw new ErrorHttp(404, 'Usuario no encontrado');
    res.json(u);
  });

  r.post('/usuarios', requierePermiso('usuarios.gestionar'), (req, res) => {
    const u = leerUsuario(req.body || {});
    comprobarLoginLibre(u.usuario);
    const info = db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol, email, karve_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u.usuario, u.nombre, u.clave_hash, u.rol, u.email, u.karve_id);
    res.status(201).json(leerUsuarioBD(info.lastInsertRowid));
  });

  r.put('/usuarios/:id', requierePermiso('usuarios.gestionar'), (req, res) => {
    const id = idRuta(req.params.id);
    const b = req.body || {};
    const existente = db.prepare('SELECT id, rol, activo FROM usuarios WHERE id = ?').get(id);
    if (!existente) throw new ErrorHttp(404, 'Usuario no encontrado');
    const cambios = { ...leerUsuario(b, { parcial: true }), activo: booleano(b.activo) };
    if (id === req.usuario.id) {
      if (cambios.activo === 0) throw new ErrorHttp(400, 'No puedes desactivar tu propio usuario');
      if (cambios.rol !== undefined && cambios.rol !== existente.rol) throw new ErrorHttp(400, 'No puedes cambiar tu propio rol');
    }
    comprobarLoginLibre(cambios.usuario, id);
    actualizarParcial('usuarios', id, cambios);
    if (cambios.activo === 0) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(id); // expulsar al desactivar
    res.json(leerUsuarioBD(id));
  });

  app.use('/api', r);
};
