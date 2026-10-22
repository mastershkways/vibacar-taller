// auth.js — Acceso y sesiones de Gestión de Taller Vibacar.
//
// - Login contra la tabla `usuarios` (POST /acceso) y cierre (POST /acceso/salir).
// - Sesiones en la tabla `sesiones`: sid aleatorio, caducidad SESION_DIAS, cookie HttpOnly.
// - La cookie lleva el sid firmado con SECRETO_COOKIE: un valor manipulado se rechaza sin tocar la BD.
// - requiereSesion: middleware que protege todo salvo RUTAS_PUBLICAS. requiereRol: por rol.
// - validarCredenciales() despacha por `usuarios.origen`: 'local' (scrypt en esta BD) o 'karve'
//   (hueco para delegar en el ERP en la Fase 5). Sesiones y middleware no dependen de ello.

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, ahora, verificarClave } = require('./db');
const { describirRol } = require('./permisos');

const NOMBRE_COOKIE = 'sid';
const SESION_DIAS = Math.max(1, parseInt(process.env.SESION_DIAS, 10) || 30);
const COOKIE_SEGURA = /^(1|true|si|sí)$/i.test(process.env.COOKIE_SEGURA || ''); // solo con HTTPS
const RENOVAR_CADA_MS = 60 * 60 * 1000; // la caducidad se extiende como mucho una vez por hora

let SECRETO = (process.env.SECRETO_COOKIE || '').trim();
if (!SECRETO) {
  SECRETO = crypto.randomBytes(32).toString('hex');
  console.warn('   ⚠️ Falta SECRETO_COOKIE en el .env: se usa uno temporal y las sesiones caducarán al reiniciar.');
}

// Rutas que se sirven sin sesión (la pantalla de acceso y sus recursos).
const RUTAS_PUBLICAS = ['/acceso', '/acceso.html', '/favicon.ico', '/img/logo.png'];

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function firmar(valor) {
  return crypto.createHmac('sha256', SECRETO).update(valor).digest('base64url');
}

function leerCookie(req, nombre) {
  const m = new RegExp(`(?:^|;\\s*)${nombre}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}

// Devuelve el sid si la cookie está bien firmada; si no, null.
function sidDeCookie(req) {
  const valor = leerCookie(req, NOMBRE_COOKIE);
  if (!valor) return null;
  const i = valor.lastIndexOf('.');
  if (i <= 0) return null;
  const sid = valor.slice(0, i);
  const firma = valor.slice(i + 1);
  const esperada = firmar(sid);
  if (firma.length !== esperada.length) return null;
  return crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada)) ? sid : null;
}

function ponerCookie(res, sid) {
  const partes = [
    `${NOMBRE_COOKIE}=${encodeURIComponent(`${sid}.${firmar(sid)}`)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESION_DIAS * 24 * 60 * 60}`,
  ];
  if (COOKIE_SEGURA) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function borrarCookie(res) {
  res.setHeader('Set-Cookie', `${NOMBRE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function fechaMas(dias) {
  const d = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esPeticionApi(req) {
  return req.path.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
}

// ---------------------------------------------------------------------------
// Validación de credenciales (punto delegable a Karve en la Fase 5)
// ---------------------------------------------------------------------------
function validarCredenciales(usuario, clave) {
  switch (usuario.origen || 'local') {
    case 'local':
      return verificarClave(clave, usuario.clave_hash);
    case 'karve':
      // Fase 5: validar contra Karve (driver en carpeta local, nunca npm).
      console.warn(`   Acceso: el usuario "${usuario.usuario}" tiene origen 'karve' y la validación delegada aún no existe.`);
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Freno a fuerza bruta: por usuario+IP, 10 fallos → bloqueo 15 minutos (en memoria).
// ---------------------------------------------------------------------------
const MAX_FALLOS = 10;
const BLOQUEO_MS = 15 * 60 * 1000;
const fallos = new Map();

function claveFallo(req, usuario) {
  return `${req.ip}|${(usuario || '').toLowerCase()}`;
}
function estaBloqueado(req, usuario) {
  const f = fallos.get(claveFallo(req, usuario));
  if (!f) return false;
  if (Date.now() - f.ultimo > BLOQUEO_MS) { fallos.delete(claveFallo(req, usuario)); return false; }
  return f.n >= MAX_FALLOS;
}
function anotarFallo(req, usuario) {
  const k = claveFallo(req, usuario);
  const f = fallos.get(k) || { n: 0, ultimo: 0 };
  fallos.set(k, { n: f.n + 1, ultimo: Date.now() });
}
function limpiarFallos(req, usuario) {
  fallos.delete(claveFallo(req, usuario));
}

// ---------------------------------------------------------------------------
// Sesiones en BD
// ---------------------------------------------------------------------------
const stmt = {
  usuarioPorNombre: db.prepare('SELECT * FROM usuarios WHERE usuario = ? AND activo = 1'),
  crearSesion: db.prepare('INSERT INTO sesiones (sid, usuario_id, creado, expira, ultimo_uso) VALUES (?, ?, ?, ?, ?)'),
  sesionConUsuario: db.prepare(`
    SELECT s.sid, s.expira, s.ultimo_uso,
           u.id, u.usuario, u.nombre, u.rol, u.email, u.origen, u.karve_id, u.activo
      FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.sid = ?`),
  renovarSesion: db.prepare('UPDATE sesiones SET expira = ?, ultimo_uso = ? WHERE sid = ?'),
  borrarSesion: db.prepare('DELETE FROM sesiones WHERE sid = ?'),
  borrarCaducadas: db.prepare('DELETE FROM sesiones WHERE expira < ?'),
  marcarAcceso: db.prepare('UPDATE usuarios SET ultimo_acceso = ? WHERE id = ?'),
};

function crearSesion(usuarioId) {
  const sid = crypto.randomBytes(32).toString('hex');
  const hoy = ahora();
  stmt.crearSesion.run(sid, usuarioId, hoy, fechaMas(SESION_DIAS), hoy);
  stmt.marcarAcceso.run(hoy, usuarioId);
  return sid;
}

// Devuelve { sid, usuario } si la sesión es válida; null si no existe, caducó o el usuario está inactivo.
function sesionDe(req) {
  const sid = sidDeCookie(req);
  if (!sid) return null;
  const fila = stmt.sesionConUsuario.get(sid);
  if (!fila) return null;
  const hoy = ahora();
  if (fila.expira < hoy || !fila.activo) { stmt.borrarSesion.run(sid); return null; }
  // Caducidad deslizante: se extiende como mucho una vez por hora para no escribir en cada petición.
  if (!fila.ultimo_uso || Date.now() - new Date(fila.ultimo_uso.replace(' ', 'T')).getTime() > RENOVAR_CADA_MS) {
    stmt.renovarSesion.run(fechaMas(SESION_DIAS), hoy, sid);
  }
  return {
    sid,
    usuario: { id: fila.id, usuario: fila.usuario, nombre: fila.nombre, rol: fila.rol, email: fila.email, origen: fila.origen, karve_id: fila.karve_id },
  };
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------
function requiereSesion(req, res, next) {
  if (RUTAS_PUBLICAS.includes(req.path) || req.path.startsWith('/acceso/')) return next();
  const s = sesionDe(req);
  if (!s) {
    if (esPeticionApi(req)) return res.status(401).json({ error: 'Sesión no iniciada o caducada' });
    const volver = req.method === 'GET' && req.path !== '/' ? `?volver=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/acceso${volver}`);
  }
  req.sesion = s;
  req.usuario = s.usuario;
  next();
}

function requiereRol(...roles) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'Sesión no iniciada' });
    if (!roles.includes(req.usuario.rol)) return res.status(403).json({ error: 'No tienes permiso para esta acción' });
    next();
  };
}

// ---------------------------------------------------------------------------
// Rutas de acceso. Se montan ANTES de requiereSesion y de express.static.
// ---------------------------------------------------------------------------
function montarRutasAcceso(app) {
  const json = express.json({ limit: '10kb' });

  app.get('/acceso', (req, res) => {
    if (sesionDe(req)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'acceso.html'));
  });

  app.post('/acceso', json, (req, res) => {
    const usuario = String((req.body && req.body.usuario) || '').trim();
    const clave = String((req.body && req.body.clave) || '');
    if (!usuario || !clave) return res.status(400).json({ error: 'Indica usuario y contraseña' });
    if (estaBloqueado(req, usuario)) return res.status(429).json({ error: 'Demasiados intentos. Espera 15 minutos.' });

    const fila = stmt.usuarioPorNombre.get(usuario);
    let ok = false;
    if (fila) {
      ok = validarCredenciales(fila, clave);
    } else {
      // Usuario inexistente: se calcula un scrypt igualmente para que tarde lo mismo que un fallo de clave.
      crypto.scryptSync(clave, 'usuario-inexistente', 64);
    }
    if (!ok) {
      anotarFallo(req, usuario);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }

    limpiarFallos(req, usuario);
    stmt.borrarCaducadas.run(ahora());
    const sid = crearSesion(fila.id);
    ponerCookie(res, sid);
    res.json({ ok: true, usuario: { id: fila.id, usuario: fila.usuario, nombre: fila.nombre, rol: fila.rol } });
  });

  app.post('/acceso/salir', (req, res) => {
    const sid = sidDeCookie(req);
    if (sid) stmt.borrarSesion.run(sid);
    borrarCookie(res);
    if (esPeticionApi(req)) return res.json({ ok: true });
    res.redirect('/acceso');
  });

  // Quién soy (lo usa index.html al cargar): usuario + nombre del rol, alcance y lista de permisos.
  app.get('/api/sesion', requiereSesion, (req, res) => {
    const r = describirRol(req.usuario.rol) || { nombre: req.usuario.rol, alcance: null, permisos: [] };
    res.json({ usuario: req.usuario, rol: r.nombre, alcance: r.alcance, permisos: r.permisos });
  });
}

module.exports = { montarRutasAcceso, requiereSesion, requiereRol, sesionDe, RUTAS_PUBLICAS };
