// server.js — Gestión de Taller Vibacar. Arranque del servidor Express.
//
// Orden de montaje (importa):
//   1. express.json
//   2. rutas de acceso (login/salir/sesión)         → auth.js
//   3. requiereSesion para TODO lo demás             → auth.js
//   4. API de maestros y de O.T. bajo /api           → rutas-maestros.js, rutas-ot.js
//   5. interfaz estática (public/)                   → index.html y recursos
//   6. 404 JSON para /api y manejador de errores

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const express = require('express');
const { db, ahora, RUTA_BD } = require('./db'); // abre la BD, migra y siembra
const auth = require('./auth');
const { ErrorHttp } = require('./validar');
const montarRutasMaestros = require('./rutas-maestros');
const montarRutasOT = require('./rutas-ot');

const PORT = parseInt(process.env.PORT, 10) || 3010;
const CARPETA_PUBLIC = path.join(__dirname, 'public');
const INDEX = path.join(CARPETA_PUBLIC, 'index.html');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// 1-2. Acceso
auth.montarRutasAcceso(app);

// 3. A partir de aquí, todo requiere sesión (salvo RUTAS_PUBLICAS de auth.js)
app.use(auth.requiereSesion);

// Página principal. Si aún no existe public/index.html (Paso 6), una pantalla provisional.
app.get('/', (req, res) => {
  if (fs.existsSync(INDEX)) return res.sendFile(INDEX);
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Gestión de Taller Vibacar</title>
    <body style="font-family:system-ui;padding:40px;color:#111827">
    <h1>Gestión de Taller Vibacar</h1>
    <p>Sesión iniciada como <b>${req.usuario.nombre}</b> (${req.usuario.rol}). La interfaz se construye en el Paso 6.</p>
    <form method="post" action="/acceso/salir"><button>Salir</button></form></body>`);
});

// 4. API
montarRutasMaestros(app);
montarRutasOT(app);

// 5. Estáticos
app.use(express.static(CARPETA_PUBLIC));

// 6. 404 y errores
app.use('/api', (req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.originalUrl}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ErrorHttp) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'El cuerpo de la petición no es JSON válido' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Petición demasiado grande' });
  if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
    return res.status(409).json({ error: 'Conflicto con los datos existentes', detalle: err.message });
  }
  console.error(`${ahora()} ERROR ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

app.listen(PORT, () => {
  const nUsuarios = db.prepare('SELECT COUNT(*) AS n FROM usuarios WHERE activo = 1').get().n;
  const nOT = db.prepare('SELECT COUNT(*) AS n FROM ot').get().n;
  console.log(`✅ Gestión de Taller Vibacar escuchando en http://localhost:${PORT}`);
  console.log(`   BD: ${RUTA_BD} (${nUsuarios} usuarios activos, ${nOT} O.T.)`);
  if (!fs.existsSync(INDEX)) console.log('   Aviso: public/index.html aún no existe; se sirve una pantalla provisional.');
});
