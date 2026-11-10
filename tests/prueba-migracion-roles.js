// Prueba de la migración de roles (F3-05) sobre una BD temporal con usuarios y transiciones de los roles antiguos.
// Uso: RUTA_BD=<db nueva> APP_USUARIO=jefe node tests/prueba-migracion-roles.js  (lo lanza tests/ejecutar-fase3.ps1)
const fs = require('fs');
const ruta = process.env.RUTA_BD;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(ruta + s); } catch {} }
const Database = require('better-sqlite3');
const d = new Database(ruta);
d.exec(`
  CREATE TABLE usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL UNIQUE COLLATE NOCASE, nombre TEXT NOT NULL, clave_hash TEXT NOT NULL, rol TEXT NOT NULL, email TEXT, activo INTEGER NOT NULL DEFAULT 1, creado TEXT NOT NULL DEFAULT (datetime('now','localtime')), actualizado TEXT);
  INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES ('jefe', 'Jefe', 'x', 'admontaller'), ('otroadmon', 'Otro', 'x', 'admontaller'), ('contable', 'Contable', 'x', 'financiero'), ('mec', 'Mec', 'x', 'tecnico'), ('gsat', 'GSat', 'x', 'gestor_sat');
  CREATE TABLE fases (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL, orden INTEGER NOT NULL, abierta INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE estados (codigo TEXT PRIMARY KEY, nombre TEXT NOT NULL, fase TEXT NOT NULL REFERENCES fases(codigo), orden INTEGER NOT NULL DEFAULT 0, es_inicial INTEGER NOT NULL DEFAULT 0, es_final INTEGER NOT NULL DEFAULT 0, prioridad_defecto INTEGER, color TEXT, activo INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE transiciones (id INTEGER PRIMARY KEY AUTOINCREMENT, origen TEXT NOT NULL REFERENCES estados(codigo), destino TEXT NOT NULL REFERENCES estados(codigo), rol TEXT NOT NULL DEFAULT '*', UNIQUE (origen, destino, rol));
  INSERT INTO fases VALUES ('f1', 'F1', 1, 1);
  INSERT INTO estados (codigo, nombre, fase) VALUES ('a', 'A', 'f1'), ('b', 'B', 'f1');
  INSERT INTO transiciones (origen, destino, rol) VALUES ('a', 'b', 'admontaller'), ('a', 'b', 'financiero'), ('a', 'b', 'tecnico'), ('b', 'a', 'financiero');
`);
d.close();

const { db } = require('../db'); // al abrir db.js se ejecuta la migración
const roles = Object.fromEntries(db.prepare('SELECT usuario, rol FROM usuarios').all().map((u) => [u.usuario, u.rol]));
const trans = db.prepare('SELECT origen, destino, rol FROM transiciones ORDER BY origen, destino, rol').all().map((t) => `${t.origen}>${t.destino}:${t.rol}`);
const res = [];
const ok = (n, c, e = '') => res.push(`${c ? 'OK ' : 'FALLO'} ${n}${e ? ' — ' + e : ''}`);
ok('APP_USUARIO (admontaller) → administrativo', roles.jefe === 'administrativo', roles.jefe);
ok('otro admontaller → responsable_st', roles.otroadmon === 'responsable_st', roles.otroadmon);
ok('financiero → administrativo', roles.contable === 'administrativo', roles.contable);
ok('tecnico intacto', roles.mec === 'tecnico');
ok('gestor_sat → operativo (F4-12)', roles.gsat === 'operativo', roles.gsat);
ok('transición admontaller a>b → administrativo + responsable_st + operativo; financiero a>b → administrativo (sin duplicar); tecnico intacta',
  JSON.stringify(trans) === JSON.stringify(['a>b:administrativo', 'a>b:operativo', 'a>b:responsable_st', 'a>b:tecnico', 'b>a:administrativo']), trans.join(' '));
ok('no quedan roles antiguos', !trans.some((t) => /admontaller|financiero|gestor_sat/.test(t)) && !Object.values(roles).some((r) => /admontaller|financiero|gestor_sat/.test(r)));
console.log(res.join('\n'));
const fallos = res.filter((r) => r.startsWith('FALLO')).length;
console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
