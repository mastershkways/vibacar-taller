// Prueba de la migración de `ot_tiempos` para el comodín (F4-07) sobre una BD temporal: se crea la base nueva, se le pone la
// tabla de tiempos como era antes (ot_id NOT NULL, sin comodin_id / concepto / incidencia_id) con tramos de verdad y se vuelve
// a lanzar migrar() → la tabla se reconstruye conservando los tramos, sus ids, los índices y la regla de un solo tramo abierto.
// Uso: RUTA_BD=<db nueva> APP_USUARIO=admin_prueba APP_CLAVE=... node tests/prueba-migracion-tiempos.js  (lo lanza tests/ejecutar-fase3.ps1)
const fs = require('fs');
const ruta = process.env.RUTA_BD;
if (!ruta) { console.error('Falta RUTA_BD'); process.exit(2); }
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(ruta + s); } catch {} }

const { db, migrar } = require('../db'); // base nueva: ya nace con la tabla nueva
const res = [];
const ok = (n, c, e = '') => res.push(`${c ? 'OK ' : 'FALLO'} ${n}${e ? ' — ' + e : ''}`);
const columnas = () => db.prepare('PRAGMA table_info(ot_tiempos)').all();
const indices = () => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ot_tiempos' AND name LIKE 'idx_%' ORDER BY name").all().map((i) => i.name);
const falla = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

ok('base nueva: ot_id admite NULL y están las columnas del comodín', columnas().find((c) => c.name === 'ot_id').notnull === 0 && ['comodin_id', 'concepto', 'incidencia_id'].every((n) => columnas().some((c) => c.name === n)));
ok('base nueva: tablas comodines, comodin_conceptos (7 de semilla, 3 de ausencia) e incidencias', db.prepare('SELECT COUNT(*) n FROM comodin_conceptos').get().n === 7 && db.prepare('SELECT COUNT(*) n FROM comodin_conceptos WHERE ausencia = 1').get().n === 3 && db.prepare('SELECT COUNT(*) n FROM comodines').get().n === 0 && db.prepare('SELECT COUNT(*) n FROM incidencias').get().n === 0);

// La tabla como era en fd6d6cb (F4-06), con sus índices, y datos de verdad.
db.exec(`
DROP TABLE ot_tiempos;
CREATE TABLE ot_tiempos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ot_id       INTEGER NOT NULL REFERENCES ot(id) ON DELETE CASCADE,
  tecnico_id  INTEGER NOT NULL REFERENCES usuarios(id),
  bloque_id   INTEGER REFERENCES ot_bloques(id) ON DELETE SET NULL,
  tipo        TEXT    NOT NULL,
  inicio      TEXT    NOT NULL,
  fin         TEXT,
  cierre      TEXT,
  origen      TEXT    NOT NULL DEFAULT 'crono',
  revisar     INTEGER NOT NULL DEFAULT 0,
  nota        TEXT,
  creado      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_ot_tiempos_ot ON ot_tiempos(ot_id);
CREATE INDEX idx_ot_tiempos_tecnico ON ot_tiempos(tecnico_id, inicio);
CREATE INDEX idx_ot_tiempos_bloque ON ot_tiempos(bloque_id);
CREATE UNIQUE INDEX idx_ot_tiempos_abierto ON ot_tiempos(tecnico_id) WHERE fin IS NULL;
`);
db.transaction(() => {
  db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES ('tec_a', 'Técnico A', 'x', 'tecnico'), ('tec_b', 'Técnico B', 'x', 'tecnico')").run();
  db.prepare("INSERT INTO clientes (nombre) VALUES ('Cliente migración')").run();
  db.prepare("INSERT INTO ot (numero, anio, secuencia, cliente_id, estado) VALUES ('0000000001', 2026, 1, 1, 'en_curso'), ('0000000002', 2026, 2, 1, 'finalizada')").run();
  db.prepare("INSERT INTO ot_bloques (ot_id, tecnico_id, dia) VALUES (1, 1, '2026-11-12')").run();
  const ins = db.prepare('INSERT INTO ot_tiempos (id, ot_id, tecnico_id, bloque_id, tipo, inicio, fin, cierre, origen, revisar, nota, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(3, 1, 1, 1, 'desplazamiento', '2026-11-12 08:00:00', '2026-11-12 08:30:10', 'cambio', 'crono', 0, null, '2026-11-12 08:00:00');
  ins.run(4, 1, 1, 1, 'trabajo', '2026-11-12 08:30:10', '2026-11-13 07:55:00', 'parar', 'crono', 1, 'Con nota', '2026-11-12 08:30:10');
  ins.run(9, 2, 2, null, 'espera', '2026-11-12 09:00:00', '2026-11-12 09:20:00', 'fin', 'crono', 0, null, '2026-11-12 09:00:00');
  ins.run(12, 1, 2, null, 'trabajo', '2026-11-13 08:00:00', null, null, 'crono', 0, null, '2026-11-13 08:00:00');
})();
const antes = db.prepare('SELECT id, ot_id, tecnico_id, bloque_id, tipo, inicio, fin, cierre, origen, revisar, nota, creado FROM ot_tiempos ORDER BY id').all();
ok('preparación: tabla antigua con 4 tramos (uno abierto) y ot_id NOT NULL', antes.length === 4 && columnas().find((c) => c.name === 'ot_id').notnull === 1 && !columnas().some((c) => c.name === 'comodin_id'));

let error = falla(() => migrar());
ok('migrar() reconstruye la tabla sin errores', !error, error || '');
const despues = db.prepare('SELECT id, ot_id, tecnico_id, bloque_id, tipo, inicio, fin, cierre, origen, revisar, nota, creado FROM ot_tiempos ORDER BY id').all();
ok('los 4 tramos se conservan idénticos, con sus ids', JSON.stringify(despues) === JSON.stringify(antes), JSON.stringify(despues.map((t) => t.id)));
ok('ot_id admite NULL y aparecen comodin_id, concepto e incidencia_id (a NULL en los tramos antiguos)', columnas().find((c) => c.name === 'ot_id').notnull === 0
  && db.prepare('SELECT COUNT(*) n FROM ot_tiempos WHERE comodin_id IS NULL AND concepto IS NULL AND incidencia_id IS NULL').get().n === 4);
ok('los 4 índices siguen, con sus nombres', JSON.stringify(indices()) === JSON.stringify(['idx_ot_tiempos_abierto', 'idx_ot_tiempos_bloque', 'idx_ot_tiempos_ot', 'idx_ot_tiempos_tecnico']), indices().join(','));
ok('no queda la tabla intermedia', !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ot_tiempos_v2'").get());
ok('integridad y claves ajenas correctas', db.pragma('integrity_check', { simple: true }) === 'ok' && db.pragma('foreign_key_check').length === 0);

error = falla(() => db.prepare("INSERT INTO ot_tiempos (ot_id, tecnico_id, tipo, inicio) VALUES (1, 2, 'trabajo', '2026-11-13 09:00:00')").run());
ok('un técnico sigue sin poder tener dos tramos abiertos (índice único)', error && /UNIQUE/.test(error), error || 'no falló');
const nuevo = db.prepare("INSERT INTO ot_tiempos (ot_id, tecnico_id, tipo, inicio, fin) VALUES (1, 1, 'trabajo', '2026-11-13 09:00:00', '2026-11-13 10:00:00')").run().lastInsertRowid;
ok('el siguiente tramo recibe un id posterior al último (la secuencia no se reinicia)', nuevo === 13, `${nuevo}`);
db.prepare("INSERT INTO comodines (tecnico_id, mes, codigo) VALUES (1, '2026-11', 'CM-202611-001')").run();
const cm = db.prepare("INSERT INTO ot_tiempos (comodin_id, tecnico_id, tipo, concepto, inicio, fin) VALUES (1, 1, 'comodin', 'taller', '2026-11-13 10:00:00', '2026-11-13 11:00:00')").run().lastInsertRowid;
ok('ya se puede guardar un tramo del comodín, sin O.T.', cm === 14 && db.prepare('SELECT ot_id FROM ot_tiempos WHERE id = 14').get().ot_id === null);
error = falla(() => db.prepare("INSERT INTO ot_tiempos (tecnico_id, tipo, inicio, fin) VALUES (1, 'trabajo', '2026-11-13 11:00:00', '2026-11-13 12:00:00')").run());
ok('un tramo sin O.T. ni comodín se rechaza', error && /CHECK/.test(error), error || 'no falló');
error = falla(() => db.prepare("INSERT INTO ot_tiempos (ot_id, comodin_id, tecnico_id, tipo, inicio, fin) VALUES (1, 1, 1, 'trabajo', '2026-11-13 11:00:00', '2026-11-13 12:00:00')").run());
ok('…y uno con O.T. y comodín a la vez, también', error && /CHECK/.test(error), error || 'no falló');
error = falla(() => db.prepare("INSERT INTO comodines (tecnico_id, mes, codigo) VALUES (1, '2026-11', 'CM-OTRO')").run());
ok('un solo comodín por técnico y mes', error && /UNIQUE/.test(error), error || 'no falló');
db.prepare('DELETE FROM ot WHERE id = 2').run();
ok('borrar una O.T. sigue llevándose sus tramos (ON DELETE CASCADE)', !db.prepare('SELECT 1 FROM ot_tiempos WHERE id = 9').get());
db.prepare('DELETE FROM ot_bloques WHERE id = 1').run();
ok('borrar un bloque deja sus tramos sin bloque (ON DELETE SET NULL)', db.prepare('SELECT bloque_id FROM ot_tiempos WHERE id = 3').get().bloque_id === null);

db.exec("DELETE FROM comodin_conceptos WHERE codigo IN ('vacaciones', 'baja', 'festivo'); UPDATE comodin_conceptos SET nombre = 'Taller (renombrado)' WHERE codigo = 'taller'");
const n = db.prepare('SELECT COUNT(*) n FROM ot_tiempos').get().n;
error = falla(() => migrar());
ok('migrar() otra vez no toca los tiempos ni falla', !error && db.prepare('SELECT COUNT(*) n FROM ot_tiempos').get().n === n, error || '');
ok('…y a una base que solo tenía los 4 conceptos de trabajo le añade los 3 de ausencia sin tocar los existentes', db.prepare('SELECT COUNT(*) n FROM comodin_conceptos WHERE ausencia = 1').get().n === 3 && db.prepare("SELECT nombre FROM comodin_conceptos WHERE codigo = 'taller'").get().nombre === 'Taller (renombrado)');

console.log(res.join('\n'));
const fallos = res.filter((r) => r.startsWith('FALLO')).length;
console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
