// db.js — Base de datos SQLite de Gestión de Taller Vibacar.
//
// Abre .cache/datos.db, aplica las migraciones (crear tablas / añadir columnas que falten)
// y carga las semillas la primera vez (fases, estados provisionales, transiciones, admin inicial).
// Todo es idempotente: se puede requerir desde server.js y desde cualquier script de scripts/.

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const CARPETA_CACHE = path.join(__dirname, '.cache');
const RUTA_BD = process.env.RUTA_BD || path.join(CARPETA_CACHE, 'datos.db');

// Roles de la app: la fuente de verdad es permisos.js. No hay CHECK en la tabla
// para poder añadir roles sin reconstruir la tabla.
const ROLES = Object.keys(require('./permisos').ROLES);

// ---------------------------------------------------------------------------
// Apertura y configuración
// ---------------------------------------------------------------------------
fs.mkdirSync(CARPETA_CACHE, { recursive: true });
const db = new Database(RUTA_BD);

db.pragma('journal_mode = WAL');      // lectores no bloquean al escritor
db.pragma('busy_timeout = 5000');     // espera hasta 5 s si la base está ocupada
db.pragma('foreign_keys = ON');       // integridad referencial
db.pragma('synchronous = NORMAL');    // seguro con WAL y bastante más rápido que FULL

// Fecha/hora local en formato "YYYY-MM-DD HH:MM:SS" (igual que datetime('now','localtime') en SQLite).
function ahora() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Contraseñas (scrypt, incluido en Node; sin dependencias)
// Formato guardado: "scrypt$<sal hex>$<hash hex>"
// ---------------------------------------------------------------------------
function hashClave(clave) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(clave), sal, 64).toString('hex');
  return `scrypt$${sal}$${hash}`;
}

function verificarClave(clave, guardado) {
  if (!guardado || typeof guardado !== 'string') return false;
  const [algo, sal, hash] = guardado.split('$');
  if (algo !== 'scrypt' || !sal || !hash) return false;
  const calculado = crypto.scryptSync(String(clave), sal, 64);
  const esperado = Buffer.from(hash, 'hex');
  return calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
}

// ---------------------------------------------------------------------------
// Migraciones
// ---------------------------------------------------------------------------
const TABLAS = `
CREATE TABLE IF NOT EXISTS usuarios (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  nombre      TEXT    NOT NULL,
  clave_hash  TEXT    NOT NULL,
  rol         TEXT    NOT NULL,
  email       TEXT,
  activo      INTEGER NOT NULL DEFAULT 1,
  creado      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado TEXT
);

CREATE TABLE IF NOT EXISTS sesiones (
  sid         TEXT    PRIMARY KEY,
  usuario_id  INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  creado      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  expira      TEXT    NOT NULL,
  ultimo_uso  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sesiones_usuario ON sesiones(usuario_id);

CREATE TABLE IF NOT EXISTS clientes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre        TEXT    NOT NULL,
  cif           TEXT,
  email         TEXT,
  telefono      TEXT,
  exige_pedido  INTEGER NOT NULL DEFAULT 0,   -- 1 = exige Nº de Pedido antes de facturar
  karve_id      TEXT,                          -- código del cliente en Karve (Fase 5)
  activo        INTEGER NOT NULL DEFAULT 1,
  creado        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado   TEXT
);
CREATE INDEX IF NOT EXISTS idx_clientes_nombre ON clientes(nombre);
CREATE INDEX IF NOT EXISTS idx_clientes_karve ON clientes(karve_id);

CREATE TABLE IF NOT EXISTS maquinas (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id        INTEGER NOT NULL REFERENCES clientes(id),
  marca             TEXT,
  modelo            TEXT,
  bastidor          TEXT,
  num_flota         TEXT,                      -- número de flota que usa el cliente
  horometro_ultimo  REAL,                      -- últimas horas de máquina registradas
  karve_id          TEXT,
  activo            INTEGER NOT NULL DEFAULT 1,
  creado            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado       TEXT
);
CREATE INDEX IF NOT EXISTS idx_maquinas_cliente ON maquinas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_maquinas_bastidor ON maquinas(bastidor);

-- Fases: columnas del Kanban. Varios estados pueden pertenecer a la misma fase.
CREATE TABLE IF NOT EXISTS fases (
  codigo  TEXT    PRIMARY KEY,
  nombre  TEXT    NOT NULL,
  orden   INTEGER NOT NULL DEFAULT 0,
  abierta INTEGER NOT NULL DEFAULT 1          -- 1 = la O.T. sigue viva (se muestra en el Kanban)
);

-- Estados: los ~50 reales se cargarán aquí (desde Karve). De momento, uno por fase.
CREATE TABLE IF NOT EXISTS estados (
  codigo             TEXT    PRIMARY KEY,
  nombre             TEXT    NOT NULL,
  fase               TEXT    NOT NULL REFERENCES fases(codigo),
  orden              INTEGER NOT NULL DEFAULT 0,
  es_inicial         INTEGER NOT NULL DEFAULT 0, -- puede ser el primer estado de una O.T.
  es_final           INTEGER NOT NULL DEFAULT 0, -- la O.T. no admite más cambios
  prioridad_defecto  INTEGER NOT NULL DEFAULT 2, -- 1 alta, 2 media, 3 baja
  color              TEXT,
  activo             INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_estados_fase ON estados(fase);

-- Transiciones permitidas: de qué estado a cuál, y qué rol puede hacerlo ('*' = cualquiera).
CREATE TABLE IF NOT EXISTS transiciones (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  origen   TEXT NOT NULL REFERENCES estados(codigo),
  destino  TEXT NOT NULL REFERENCES estados(codigo),
  rol      TEXT NOT NULL DEFAULT '*',
  UNIQUE (origen, destino, rol)
);

-- Contadores para numeración (clave 'ot-2026' → última secuencia usada ese año).
CREATE TABLE IF NOT EXISTS contadores (
  clave       TEXT    PRIMARY KEY,
  valor       INTEGER NOT NULL DEFAULT 0,
  actualizado TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ot (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  numero      TEXT    NOT NULL UNIQUE,          -- '2026-0001'
  anio        INTEGER NOT NULL,
  secuencia   INTEGER NOT NULL,
  cliente_id  INTEGER NOT NULL REFERENCES clientes(id),
  maquina_id  INTEGER REFERENCES maquinas(id),
  estado      TEXT    NOT NULL REFERENCES estados(codigo),
  prioridad   INTEGER NOT NULL DEFAULT 2,       -- 1 alta, 2 media, 3 baja
  tipo        TEXT    NOT NULL DEFAULT 'correctivo', -- correctivo | preventivo
  origen      TEXT    NOT NULL DEFAULT 'manual',     -- manual | whatsapp | correo | auto
  sintoma     TEXT,                              -- lo que dice el cliente ("no arranca")
  descripcion TEXT,                              -- detalle del aviso
  tecnico_id  INTEGER REFERENCES usuarios(id),   -- técnico asignado (aprobado)
  creado_por  INTEGER REFERENCES usuarios(id),
  creado      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado TEXT,
  version     INTEGER NOT NULL DEFAULT 1,        -- bloqueo optimista
  UNIQUE (anio, secuencia)
);
CREATE INDEX IF NOT EXISTS idx_ot_estado ON ot(estado);
CREATE INDEX IF NOT EXISTS idx_ot_tecnico ON ot(tecnico_id);
CREATE INDEX IF NOT EXISTS idx_ot_cliente ON ot(cliente_id);
CREATE INDEX IF NOT EXISTS idx_ot_maquina ON ot(maquina_id);

CREATE TABLE IF NOT EXISTS ot_historial (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ot_id            INTEGER NOT NULL REFERENCES ot(id) ON DELETE CASCADE,
  estado_anterior  TEXT,
  estado_nuevo     TEXT    NOT NULL,
  usuario_id       INTEGER REFERENCES usuarios(id),
  fecha            TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  nota             TEXT
);
CREATE INDEX IF NOT EXISTS idx_ot_historial_ot ON ot_historial(ot_id);

-- Propuestas de asignación de técnico (manuales o del sistema/IA) y su aprobación.
CREATE TABLE IF NOT EXISTS ot_asignaciones (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ot_id         INTEGER NOT NULL REFERENCES ot(id) ON DELETE CASCADE,
  tecnico_id    INTEGER NOT NULL REFERENCES usuarios(id),
  origen        TEXT    NOT NULL DEFAULT 'manual',    -- manual | sistema
  propuesto_por INTEGER REFERENCES usuarios(id),      -- NULL si la propone el sistema
  estado        TEXT    NOT NULL DEFAULT 'propuesta', -- propuesta | aprobada | rechazada
  fecha         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  resuelto_por  INTEGER REFERENCES usuarios(id),
  resuelto_en   TEXT,
  nota          TEXT
);
CREATE INDEX IF NOT EXISTS idx_ot_asignaciones_ot ON ot_asignaciones(ot_id);
`;

// Columnas añadidas después de la primera versión. Formato: [tabla, columna, definición SQL].
// Cuando haga falta una columna nueva, se añade aquí y migrar() la crea si no existe.
const COLUMNAS_NUEVAS = [
  // Preparación para la Fase 5: los usuarios podrían venir/sincronizarse desde Karve.
  ['usuarios', 'karve_id', 'TEXT'],                       // identificador del usuario en Karve
  ['usuarios', 'origen', "TEXT NOT NULL DEFAULT 'local'"], // local = clave en esta BD | karve = validación delegada
  ['usuarios', 'ultimo_acceso', 'TEXT'],
  // Paso 6: notas internas del taller sobre la O.T. (no saldrán en el parte/PDF).
  ['ot', 'notas_internas', 'TEXT'],
];

function asegurarColumna(tabla, columna, definicion) {
  const existe = db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
  if (!existe) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
    console.log(`   BD: añadida columna ${tabla}.${columna}`);
  }
}

function migrar() {
  db.exec(TABLAS);
  for (const [tabla, columna, definicion] of COLUMNAS_NUEVAS) asegurarColumna(tabla, columna, definicion);
  sembrar();
}

// ---------------------------------------------------------------------------
// Semillas (solo cuando la tabla correspondiente está vacía; lo editado en BD manda)
// ---------------------------------------------------------------------------

// Fases provisionales del Kanban, en orden. Los estados reales de Karve se mapearán a estas fases.
const FASES_SEMILLA = [
  ['abierta',              'Abierta',                 1, 1],
  ['pendiente_repuesto',   'Pendiente de repuesto',   2, 1],
  ['pendiente_asignacion', 'Pendiente de asignación', 3, 1],
  ['asignada',             'Asignada',                4, 1],
  ['en_curso',             'En curso',                5, 1],
  ['pausada',              'Pausada',                 6, 1],
  ['finalizada',           'Finalizada',              7, 1],
  ['pendiente_pedido',     'Pendiente de Nº pedido',  8, 1],
  ['vb_factura',           'Visto bueno factura',     9, 1],
  ['cerrada',              'Cerrada',                10, 0],
];

// Estados provisionales: uno por fase, mismo código. [codigo, nombre, fase, orden, es_inicial, es_final, prioridad, color]
const ESTADOS_SEMILLA = [
  ['abierta',              'Abierta',                 'abierta',              1, 1, 0, 2, '#6b7280'],
  ['pendiente_repuesto',   'Pendiente de repuesto',   'pendiente_repuesto',   1, 0, 0, 2, '#f59e0b'],
  ['pendiente_asignacion', 'Pendiente de asignación', 'pendiente_asignacion', 1, 0, 0, 2, '#eab308'],
  ['asignada',             'Asignada',                'asignada',             1, 0, 0, 2, '#3b82f6'],
  ['en_curso',             'En curso',                'en_curso',             1, 0, 0, 2, '#2563eb'],
  ['pausada',              'Pausada',                 'pausada',              1, 0, 0, 2, '#a855f7'],
  ['finalizada',           'Finalizada',              'finalizada',           1, 0, 0, 2, '#10b981'],
  ['pendiente_pedido',     'Pendiente de Nº pedido',  'pendiente_pedido',     1, 0, 0, 2, '#f97316'],
  ['vb_factura',           'Visto bueno factura',     'vb_factura',           1, 0, 0, 2, '#14b8a6'],
  ['cerrada',              'Cerrada',                 'cerrada',              1, 0, 1, 2, '#374151'],
];

// Flujo básico provisional. [origen, destino, roles que pueden hacerlo]
const TRANSICIONES_SEMILLA = [
  ['abierta',              'pendiente_repuesto',   ['admontaller', 'recambista']],
  ['abierta',              'pendiente_asignacion', ['admontaller']],
  ['abierta',              'cerrada',              ['admontaller']],                       // anulación
  ['pendiente_repuesto',   'pendiente_asignacion', ['admontaller', 'recambista']],
  ['pendiente_asignacion', 'asignada',             ['admontaller']],
  ['asignada',             'en_curso',             ['admontaller', 'tecnico', 'sat']],
  ['asignada',             'pendiente_asignacion', ['admontaller']],                       // reasignar
  ['en_curso',             'pausada',              ['admontaller', 'tecnico', 'sat']],
  ['en_curso',             'pendiente_repuesto',   ['admontaller', 'tecnico']],            // faltan piezas a mitad
  ['en_curso',             'finalizada',           ['admontaller', 'tecnico', 'sat']],
  ['pausada',              'en_curso',             ['admontaller', 'tecnico', 'sat']],
  ['finalizada',           'pendiente_pedido',     ['admontaller', 'financiero']],
  ['finalizada',           'vb_factura',           ['admontaller', 'financiero']],
  ['finalizada',           'en_curso',             ['admontaller']],                       // reabrir
  ['pendiente_pedido',     'vb_factura',           ['admontaller', 'financiero']],
  ['vb_factura',           'cerrada',              ['admontaller', 'financiero']],
];

function tablaVacia(tabla) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n === 0;
}

const sembrar = db.transaction(() => {
  if (tablaVacia('fases')) {
    const ins = db.prepare('INSERT INTO fases (codigo, nombre, orden, abierta) VALUES (?, ?, ?, ?)');
    for (const f of FASES_SEMILLA) ins.run(...f);
    console.log(`   BD: cargadas ${FASES_SEMILLA.length} fases provisionales`);
  }
  if (tablaVacia('estados')) {
    const ins = db.prepare(`INSERT INTO estados (codigo, nombre, fase, orden, es_inicial, es_final, prioridad_defecto, color)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of ESTADOS_SEMILLA) ins.run(...e);
    console.log(`   BD: cargados ${ESTADOS_SEMILLA.length} estados provisionales`);
  }
  if (tablaVacia('transiciones')) {
    const ins = db.prepare('INSERT INTO transiciones (origen, destino, rol) VALUES (?, ?, ?)');
    let n = 0;
    for (const [origen, destino, roles] of TRANSICIONES_SEMILLA) for (const rol of roles) { ins.run(origen, destino, rol); n++; }
    console.log(`   BD: cargadas ${n} transiciones provisionales`);
  }
  if (tablaVacia('usuarios')) {
    const usuario = (process.env.APP_USUARIO || '').trim();
    const clave = process.env.APP_CLAVE || '';
    if (usuario && clave) {
      db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?, ?, ?, ?)')
        .run(usuario, 'Administrador', hashClave(clave), 'admontaller');
      console.log(`   BD: creado el usuario administrador inicial "${usuario}" (rol admontaller)`);
    } else {
      console.warn('   ⚠️ BD: no hay usuarios y faltan APP_USUARIO/APP_CLAVE en el .env: nadie podrá entrar.');
    }
  }
});

migrar();

module.exports = { db, migrar, ahora, hashClave, verificarClave, ROLES, RUTA_BD };
