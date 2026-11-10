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
  activo        INTEGER NOT NULL DEFAULT 1,     -- baja lógica: nunca se borra un cliente
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

-- Fases: columnas del Tablero (F4-04: 5 verticales + cerrada). Varios estados pueden pertenecer a la misma fase.
CREATE TABLE IF NOT EXISTS fases (
  codigo  TEXT    PRIMARY KEY,
  nombre  TEXT    NOT NULL,
  orden   INTEGER NOT NULL DEFAULT 0,
  abierta INTEGER NOT NULL DEFAULT 1          -- 1 = la O.T. sigue viva (se muestra en el Kanban)
);

-- Estados: uno por fase (F4-04). Lo que antes eran estados intermedios (pendiente de repuesto, pendiente de nº de pedido…)
-- ahora son etiquetas dentro de la vertical. Los estados antiguos quedan con activo = 0 para que el historial siga leyéndose.
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

-- Transiciones: desde F4-04 el flujo es libre (cualquier estado → cualquier estado con confirmación) y esta tabla ya no
-- limita nada; se conserva vacía para marcar, en la Fase 5, qué cambios disparan avisos.
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
  numero      TEXT    NOT NULL UNIQUE,          -- formato Karve: 10 dígitos, '0000107951' (F3.5-05)
  anio        INTEGER NOT NULL,                 -- año de apertura (informativo)
  secuencia   INTEGER NOT NULL,                 -- número sin ceros a la izquierda
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

-- Fase 3.5 (F3.5-03): contactos del cliente (todos los de Karve; los 3 principales van en la ficha) y registro de sincronizaciones.
CREATE TABLE IF NOT EXISTS cliente_contactos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id   INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  karve_id     TEXT    UNIQUE,
  nombre       TEXT    NOT NULL,
  telefono     TEXT,
  email        TEXT,
  cargo        TEXT,
  departamento TEXT,
  activo       INTEGER NOT NULL DEFAULT 1,
  creado       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cliente_contactos_cliente ON cliente_contactos(cliente_id);

-- F4-01: etiquetas dentro de cada vertical del Tablero (motivo de la pausa, situación de la finalizada, cómo se cerró…).
-- responsable = rol que "limpia" esa etiqueta (recambista los repuestos, administrativo el nº de pedido y la facturación…).
CREATE TABLE IF NOT EXISTS etiquetas (
  codigo      TEXT    PRIMARY KEY,
  nombre      TEXT    NOT NULL,
  estado      TEXT    NOT NULL REFERENCES estados(codigo),
  orden       INTEGER NOT NULL DEFAULT 0,
  responsable TEXT,                          -- rol responsable (informativo; el Tablero lo resalta)
  color       TEXT,
  activo      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_etiquetas_estado ON etiquetas(estado);

-- F4-01: bloques de planificación. Una O.T. puede ocupar varios días y/o varios técnicos; 0 bloques = sin planificar.
-- La duración la pone quien planifica (2 h por defecto); los bloques pasados se conservan (previsto frente a fichado).
CREATE TABLE IF NOT EXISTS ot_bloques (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ot_id         INTEGER NOT NULL REFERENCES ot(id) ON DELETE CASCADE,
  tecnico_id    INTEGER NOT NULL REFERENCES usuarios(id),
  dia           TEXT    NOT NULL,              -- 'YYYY-MM-DD'
  hora_inicio   TEXT    NOT NULL DEFAULT '08:00',
  duracion_min  INTEGER NOT NULL DEFAULT 120,
  orden         INTEGER NOT NULL DEFAULT 1,    -- orden dentro del día del técnico
  nota          TEXT,
  creado_por    INTEGER REFERENCES usuarios(id),
  creado        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ot_bloques_ot ON ot_bloques(ot_id);
CREATE INDEX IF NOT EXISTS idx_ot_bloques_tecnico_dia ON ot_bloques(tecnico_id, dia);

CREATE TABLE IF NOT EXISTS sincronizaciones (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  inicio      TEXT    NOT NULL,
  fin         TEXT,
  origen      TEXT    NOT NULL,              -- manual (botón) | cron (script programado) | prueba | ot-manual / ot-cron (importación de O.T.)
  usuario_id  INTEGER REFERENCES usuarios(id),
  estado      TEXT    NOT NULL,              -- ok | error
  resumen     TEXT,                          -- JSON con contadores y avisos
  mensaje     TEXT
);
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
  // Fase 2 (F2-02): maestro de clientes. La tabla local es un espejo de Karve (Fase 5):
  // origen = manual (creado aquí) | karve (sincronizado; karve_id es su código en Karve).
  ['clientes', 'direccion', 'TEXT'],
  ['clientes', 'origen', "TEXT NOT NULL DEFAULT 'manual'"],
  // Fase 2 (F2-05): comercial responsable del cliente (cartera del vendedor); el alcance clientes_propios filtra por él.
  ['clientes', 'comercial_id', 'INTEGER REFERENCES usuarios(id)'],
  // Fase 3 (F3-03): contactos del cliente y fecha de la última factura (vendrá de Karve en la Fase 3.5; regla de 3 años).
  // `origen` y `activo` se conservan en BD pero ya no se gestionan desde la interfaz.
  ['clientes', 'compras_nombre', 'TEXT'],
  ['clientes', 'compras_telefono', 'TEXT'],
  ['clientes', 'tecnico_nombre', 'TEXT'],
  ['clientes', 'tecnico_telefono', 'TEXT'],
  ['clientes', 'tecnico_email', 'TEXT'],
  ['clientes', 'email_facturas', 'TEXT'],
  ['clientes', 'ultima_factura', 'TEXT'],
  // Fase 3.5 / F4-03: zona manual del cliente (Bizkaia, Araba, Gipuzkoa, Madrid, otras); la sincronización la precarga desde la provincia de Karve.
  ['clientes', 'zona', 'TEXT'],
  // Fase 2 (F2-03): maestro de máquinas, mismo espejo de Karve que clientes (origen + karve_id).
  ['maquinas', 'origen', "TEXT NOT NULL DEFAULT 'manual'"],
  // Fase 3 (F3-04): estado de la máquina, nº de contrato (salvo cliente final) y características técnicas; `origen` se conserva sin interfaz.
  ['maquinas', 'estado', "TEXT NOT NULL DEFAULT 'cliente_final'"],
  ['maquinas', 'num_contrato', 'TEXT'],
  ['maquinas', 'caracteristicas', 'TEXT'],
  ['maquinas', 'observaciones', 'TEXT'],
  // Fase 3.6 (F3.6-01): O.T. importadas de Karve (su estado y operario como referencia, fecha prevista) y fecha de cierre (F3.6-02).
  ['ot', 'karve_estado', 'TEXT'],
  ['ot', 'karve_operario', 'TEXT'],
  ['ot', 'fecha_prevista', 'TEXT'],
  ['ot', 'fecha_cierre', 'TEXT'],
  // Fase 4 (F4-01): etiqueta dentro de la vertical (catálogo `etiquetas`) y roles que "limpian" cada vertical.
  ['ot', 'etiqueta', 'TEXT'],
  ['estados', 'responsables', 'TEXT'],                     // roles separados por coma; el Tablero resalta "tu vertical"
];

function asegurarColumna(tabla, columna, definicion) {
  const existe = db.prepare(`PRAGMA table_info(${tabla})`).all().some((c) => c.name === columna);
  if (!existe) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
    console.log(`   BD: añadida columna ${tabla}.${columna}`);
  }
}

// F3-05: roles anteriores → nuevos, en usuarios y en transiciones. El admin inicial (APP_USUARIO) pasa a
// administrativo para que nadie pierda la gestión de usuarios; el resto de admontaller → responsable_st; financiero → administrativo.
function migrarRoles() {
  const { ROLES_ANTIGUOS } = require('./permisos');
  const viejos = Object.keys(ROLES_ANTIGUOS);
  const marcas = viejos.map(() => '?').join(', ');
  const n = db.prepare(`SELECT COUNT(*) AS n FROM usuarios WHERE rol IN (${marcas})`).get(...viejos).n;
  if (n) {
    const admin = (process.env.APP_USUARIO || '').trim();
    if (admin) db.prepare("UPDATE usuarios SET rol = 'administrativo' WHERE usuario = ? AND rol = 'admontaller'").run(admin);
    for (const [viejo, nuevo] of Object.entries(ROLES_ANTIGUOS)) db.prepare('UPDATE usuarios SET rol = ? WHERE rol = ?').run(nuevo, viejo);
    console.log(`   BD: ${n} usuario(s) con roles antiguos migrados (${Object.entries(ROLES_ANTIGUOS).map(([v, nv]) => `${v} → ${nv}`).join(', ')}${admin ? `; "${admin}" → administrativo` : ''})`);
  }
  const filas = db.prepare(`SELECT origen, destino, rol FROM transiciones WHERE rol IN (${marcas})`).all(...viejos);
  if (filas.length) {
    const existe = db.prepare('SELECT 1 FROM transiciones WHERE origen = ? AND destino = ? AND rol = ?');
    const ins = db.prepare('INSERT INTO transiciones (origen, destino, rol) VALUES (?, ?, ?)');
    for (const t of filas) for (const rol of (t.rol === 'admontaller' ? OFICINA : [ROLES_ANTIGUOS[t.rol]])) if (!existe.get(t.origen, t.destino, rol)) ins.run(t.origen, t.destino, rol);
    db.prepare(`DELETE FROM transiciones WHERE rol IN (${marcas})`).run(...viejos);
    console.log(`   BD: ${filas.length} transiciones migradas a los roles nuevos`);
  }
}

// F3.5-05: numeración anterior 'AAAA-NNNN' → formato Karve de 10 dígitos; contadores 'ot-AAAA' → 'ot'.
function migrarNumeracion() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM ot WHERE numero LIKE '____-____'").get().n;
  if (n) {
    db.prepare("UPDATE ot SET numero = printf('%010d', secuencia) WHERE numero LIKE '____-____'").run();
    console.log(`   BD: ${n} O.T. renumeradas al formato de Karve (10 dígitos)`);
  }
  const viejos = db.prepare("SELECT MAX(valor) AS m, COUNT(*) AS n FROM contadores WHERE clave LIKE 'ot-%'").get();
  if (viejos.n) {
    const actual = db.prepare("SELECT valor FROM contadores WHERE clave = 'ot'").get();
    if (!actual) db.prepare("INSERT INTO contadores (clave, valor) VALUES ('ot', ?)").run(viejos.m || 0);
    db.prepare("DELETE FROM contadores WHERE clave LIKE 'ot-%'").run();
    console.log('   BD: contador de O.T. unificado (sin año)');
  }
  // F3.5-06: el nº de flota ya no usa contador (es el código de Karve o el siguiente al máximo numérico).
  const flota = db.prepare("DELETE FROM contadores WHERE clave LIKE 'flota-%'").run();
  if (flota.changes) console.log('   BD: contadores de nº de flota retirados');
}

// F4-04 (2026-11-10): Tablero v2. Los 10 estados provisionales pasan a 5 verticales + cerrada, con etiquetas dentro.
// Los estados antiguos se quedan inactivos (el historial los sigue nombrando) colgando de su vertical nueva; sus fases
// antiguas se borran. Cada O.T. se recoloca según su estado antiguo y, si viene de Karve, según `karve_estado`.
const ESTADO_V2_POR_ANTIGUO = {
  abierta:              ['pendiente_planificar', null],
  pendiente_asignacion: ['pendiente_planificar', null],
  asignada:             ['planificada', null],
  pendiente_repuesto:   ['pausada', 'repuesto'],
  pendiente_pedido:     ['pausada', 'num_pedido'],
  vb_factura:           ['finalizada', 'vb_factura'],
};
const ETIQUETA_V2_POR_KARVE = {
  'PDTE OK PPTO': 'ok_presupuesto', 'PPTO': 'presupuesto', 'PPTO URG.': 'presupuesto', 'PDTE. DICTAMEN': 'presupuesto',
  'S.A.T. EXTERNO': 'sat_externo', 'PDTE ALBARAN': 'albaran',
};
function migrarTableroV2() {
  const antiguos = Object.keys(ESTADO_V2_POR_ANTIGUO);
  const marcas = antiguos.map(() => '?').join(', ');
  const activos = db.prepare(`SELECT codigo FROM estados WHERE activo = 1 AND codigo IN (${marcas})`).all(...antiguos).map((e) => e.codigo);
  if (!activos.length) return; // ya migrada (o base nueva)
  const insFase = db.prepare('INSERT OR IGNORE INTO fases (codigo, nombre, orden, abierta) VALUES (?, ?, ?, ?)');
  const updFase = db.prepare('UPDATE fases SET nombre = ?, orden = ?, abierta = ? WHERE codigo = ?');
  for (const f of FASES_SEMILLA) { insFase.run(...f); updFase.run(f[1], f[2], f[3], f[0]); }
  const insEstado = db.prepare(`INSERT OR IGNORE INTO estados (codigo, nombre, fase, orden, es_inicial, es_final, prioridad_defecto, color, responsables, activo)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const updEstado = db.prepare('UPDATE estados SET nombre = ?, fase = ?, orden = ?, es_inicial = ?, es_final = ?, prioridad_defecto = ?, color = ?, responsables = ?, activo = 1 WHERE codigo = ?');
  for (const e of ESTADOS_SEMILLA) { insEstado.run(...e); updEstado.run(e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8], e[0]); }
  const insEtiqueta = db.prepare('INSERT OR IGNORE INTO etiquetas (codigo, nombre, estado, orden, responsable, color) VALUES (?, ?, ?, ?, ?, ?)');
  for (const t of ETIQUETAS_SEMILLA) insEtiqueta.run(...t);

  // O.T. de cada estado antiguo → (estado nuevo, etiqueta); las de en_curso/pausada/finalizada reciben etiqueta por su estado de Karve.
  const updOT = db.prepare('UPDATE ot SET estado = ?, etiqueta = ? WHERE id = ?');
  const porEstado = {};
  for (const o of db.prepare(`SELECT id, estado, karve_estado, etiqueta FROM ot WHERE estado IN (${marcas}) OR (etiqueta IS NULL AND karve_estado IS NOT NULL AND estado IN ('en_curso', 'pausada', 'finalizada'))`).all(...antiguos)) {
    const [nuevo, etiquetaBase] = ESTADO_V2_POR_ANTIGUO[o.estado] || [o.estado, null];
    const etiqueta = ETIQUETA_V2_POR_KARVE[o.karve_estado] && ['pausada', 'en_curso', 'finalizada'].includes(nuevo) ? ETIQUETA_V2_POR_KARVE[o.karve_estado] : etiquetaBase;
    updOT.run(nuevo, etiqueta, o.id);
    porEstado[nuevo] = (porEstado[nuevo] || 0) + 1;
  }
  // Estados antiguos: inactivos y colgados de la vertical nueva; sus fases desaparecen. Las transiciones ya no se usan.
  const updViejo = db.prepare('UPDATE estados SET activo = 0, es_inicial = 0, fase = ? WHERE codigo = ?');
  for (const viejo of activos) updViejo.run(ESTADO_V2_POR_ANTIGUO[viejo][0], viejo);
  db.exec('DELETE FROM transiciones');
  db.prepare(`DELETE FROM fases WHERE codigo IN (${marcas})`).run(...antiguos);
  console.log(`   BD: Tablero v2: ${activos.length} estados antiguos retirados; O.T. recolocadas: ${Object.entries(porEstado).map(([e, n]) => `${e} ${n}`).join(', ') || 'ninguna'}`);
}

function migrar() {
  db.exec(TABLAS);
  for (const [tabla, columna, definicion] of COLUMNAS_NUEVAS) asegurarColumna(tabla, columna, definicion);
  migrarRoles();
  migrarNumeracion();
  sembrar();
  migrarTableroV2();
}

// ---------------------------------------------------------------------------
// Semillas (solo cuando la tabla correspondiente está vacía; lo editado en BD manda)
// ---------------------------------------------------------------------------

// Verticales del Tablero v2 (F4-04, decisión de gerencia 2026-11-06 / Sendoa 2026-11-10), en orden. Cerrada no se muestra.
const FASES_SEMILLA = [
  ['pendiente_planificar', 'Pendiente de planificar', 1, 1],
  ['planificada',          'Planificada',             2, 1],
  ['en_curso',             'En curso',                3, 1],
  ['pausada',              'Pausada',                 4, 1],
  ['finalizada',           'Finalizada',              5, 1],
  ['cerrada',              'Cerrada',                 6, 0],
];

// Un estado por vertical, mismo código. [codigo, nombre, fase, orden, es_inicial, es_final, prioridad, color, responsables]
// `responsables` = roles que "limpian" esa vertical (el Tablero se la resalta y pueden filtrar "solo mi vertical").
const ESTADOS_SEMILLA = [
  ['pendiente_planificar', 'Pendiente de planificar', 'pendiente_planificar', 1, 1, 0, 2, '#6b7280', 'responsable_st,operativo'],
  ['planificada',          'Planificada',             'planificada',          1, 0, 0, 2, '#3b82f6', 'responsable_st,operativo'],
  ['en_curso',             'En curso',                'en_curso',             1, 0, 0, 2, '#2563eb', 'tecnico,sat,operativo'],
  ['pausada',              'Pausada',                 'pausada',              1, 0, 0, 2, '#a855f7', 'recambista,administrativo,operativo'],
  ['finalizada',           'Finalizada',              'finalizada',           1, 0, 0, 2, '#10b981', 'administrativo,responsable_st'],
  ['cerrada',              'Cerrada',                 'cerrada',              1, 0, 1, 2, '#374151', null],
];

// Etiquetas dentro de cada vertical. [codigo, nombre, estado, orden, responsable, color]
const ETIQUETAS_SEMILLA = [
  ['repuesto',       'Pendiente de repuesto',      'pausada',    1, 'recambista',     '#f59e0b'],
  ['presupuesto',    'Presupuesto',                'pausada',    2, 'operativo',      '#a855f7'],
  ['ok_presupuesto', 'Pendiente OK presupuesto',   'pausada',    3, 'operativo',      '#c084fc'],
  ['num_pedido',     'Pendiente de nº de pedido',  'pausada',    4, 'administrativo', '#f97316'],
  ['espera_cliente', 'Espera del cliente',         'pausada',    5, 'operativo',      '#9ca3af'],
  ['sat_externo',    'SAT externo',                'en_curso',   1, 'operativo',      '#0ea5e9'],
  ['albaran',        'Pendiente de albarán',       'finalizada', 1, 'administrativo', '#14b8a6'],
  ['vb_factura',     'Vº B factura',               'finalizada', 2, 'administrativo', '#0d9488'],
  ['facturada',      'Facturada',                  'cerrada',    1, null,             '#374151'],
  ['sin_cargo',      'Sin cargo',                  'cerrada',    2, null,             '#6b7280'],
  ['anulada',        'Anulada',                    'cerrada',    3, null,             '#9ca3af'],
];

// OFICINA = los que mandan sobre la O.T. (F3-05); se usa al migrar transiciones antiguas. Desde F4-04 el flujo es libre.
const OFICINA = ['administrativo', 'responsable_st', 'operativo'];

function tablaVacia(tabla) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${tabla}`).get().n === 0;
}

const sembrar = db.transaction(() => {
  if (tablaVacia('fases')) {
    const ins = db.prepare('INSERT INTO fases (codigo, nombre, orden, abierta) VALUES (?, ?, ?, ?)');
    for (const f of FASES_SEMILLA) ins.run(...f);
    console.log(`   BD: cargadas ${FASES_SEMILLA.length} fases (verticales del Tablero)`);
  }
  if (tablaVacia('estados')) {
    const ins = db.prepare(`INSERT INTO estados (codigo, nombre, fase, orden, es_inicial, es_final, prioridad_defecto, color, responsables)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of ESTADOS_SEMILLA) ins.run(...e);
    console.log(`   BD: cargados ${ESTADOS_SEMILLA.length} estados (verticales del Tablero)`);
  }
  if (tablaVacia('etiquetas') && db.prepare("SELECT 1 FROM estados WHERE codigo = 'pausada'").get()) {
    const ins = db.prepare('INSERT INTO etiquetas (codigo, nombre, estado, orden, responsable, color) VALUES (?, ?, ?, ?, ?, ?)');
    for (const t of ETIQUETAS_SEMILLA) ins.run(...t);
    console.log(`   BD: cargadas ${ETIQUETAS_SEMILLA.length} etiquetas`);
  }
  if (tablaVacia('usuarios')) {
    const usuario = (process.env.APP_USUARIO || '').trim();
    const clave = process.env.APP_CLAVE || '';
    if (usuario && clave) {
      db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?, ?, ?, ?)')
        .run(usuario, 'Administrador', hashClave(clave), 'administrativo');
      console.log(`   BD: creado el usuario administrador inicial "${usuario}" (rol administrativo)`);
    } else {
      console.warn('   ⚠️ BD: no hay usuarios y faltan APP_USUARIO/APP_CLAVE en el .env: nadie podrá entrar.');
    }
  }
});

migrar();

module.exports = { db, migrar, ahora, hashClave, verificarClave, ROLES, RUTA_BD, ESTADO_V2_POR_ANTIGUO };
