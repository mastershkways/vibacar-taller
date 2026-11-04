// Prueba sin servidor (F3.5-05): migración de la numeración antigua, generador de 10 dígitos con mínimo de Karve,
// fijar-contador y purga --limpiar del seed. Uso: RUTA_BD=<db nueva> APP_USUARIO=... APP_CLAVE=... node tests/prueba-numeracion-y-limpiar.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ruta = process.env.RUTA_BD;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(ruta + s); } catch {} }
const res = [];
const ok = (n, c, e = '') => res.push(`${c ? 'OK ' : 'FALLO'} ${n}${e ? ' — ' + e : ''}`);
const RAIZ = path.join(__dirname, '..');

// 1) Base real (db.js la crea) con O.T. en el formato antiguo y contadores por año, escritos a pelo en otro proceso
//    → al abrir db.js en este proceso se migran.
const Database = require('better-sqlite3');
execFileSync('node', ['-e', `
  const { db } = require(${JSON.stringify(path.join(RAIZ, 'db.js'))});
  db.prepare("INSERT INTO clientes (nombre) VALUES ('Cliente viejo')").run();
  db.prepare("DELETE FROM contadores").run();
  db.prepare("INSERT INTO contadores (clave, valor) VALUES ('ot-2026', 20), ('ot-2025', 300)").run();
  db.prepare("INSERT INTO ot (numero, anio, secuencia, cliente_id, estado, creado_por) VALUES ('2026-0019', 2026, 19, 1, 'abierta', 1), ('2026-0020', 2026, 20, 1, 'abierta', 1)").run();
`], { env: process.env, stdio: 'ignore' });

const { db } = require('../db'); // migra
const nums = db.prepare('SELECT numero, secuencia FROM ot ORDER BY secuencia').all();
ok('migración: las O.T. 2026-0019/0020 pasan a 0000000019/0000000020', JSON.stringify(nums.map((o) => o.numero)) === JSON.stringify(['0000000019', '0000000020']), nums.map((o) => o.numero).join(','));
const cont = db.prepare('SELECT clave, valor FROM contadores ORDER BY clave').all();
ok("migración: contadores 'ot-AAAA' unificados en 'ot' con el máximo (300)", cont.length === 1 && cont[0].clave === 'ot' && cont[0].valor === 300, JSON.stringify(cont));

// 2) Generador local con mínimo de Karve
const num = require('../numeracion');
ok('proximoNumero → 0000000301 (contador 300 manda sobre la secuencia 20)', num.proximoNumero() === '0000000301', num.proximoNumero());
let n1 = num.siguienteNumeroOT({ minimo: 0 });
ok('siguienteNumeroOT sin mínimo → 0000000301 con anio actual', n1.numero === '0000000301' && n1.secuencia === 301 && n1.anio === new Date().getFullYear(), JSON.stringify(n1));
let n2 = num.siguienteNumeroOT({ minimo: 107950 });
ok('siguienteNumeroOT con mínimo de Karve 107950 → 0000107951', n2.numero === '0000107951', n2.numero);
let n3 = num.siguienteNumeroOT({ minimo: 100 });
ok('un mínimo menor no baja la secuencia → 0000107952', n3.numero === '0000107952', n3.numero);
let e = null; try { num.fijarContador(5); } catch (x) { e = x; }
ok('fijarContador por debajo de lo usado → error salvo --forzar', !!e && /forzar/.test(e.message));
ok('fijarContador(200000) → próxima 0000200001', num.fijarContador(200000).proximo === '0000200001');
ok('formato de 10 dígitos siempre', num.formatearNumero(7) === '0000000007' && num.formatearNumero(1234567890) === '1234567890');

// 3) Seed --limpiar: purga total + 3 usuarios
db.prepare("INSERT INTO ot (numero, anio, secuencia, cliente_id, estado, creado_por) VALUES ('0000107951', 2026, 107951, 1, 'abierta', 1)").run();
db.close();
const salida = execFileSync('node', [path.join(RAIZ, 'scripts', 'generar-datos-prueba.js'), '--limpiar'], { env: process.env, encoding: 'utf8' });
const d2 = new Database(ruta, { readonly: true });
const cuenta = (t) => d2.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
const usuarios = d2.prepare('SELECT usuario, rol, karve_id FROM usuarios ORDER BY id').all();
ok('--limpiar: 0 clientes, 0 O.T., 0 contadores', cuenta('clientes') === 0 && cuenta('ot') === 0 && cuenta('contadores') === 0 && cuenta('maquinas') === 0, `${cuenta('clientes')}/${cuenta('ot')}/${cuenta('contadores')}`);
ok('--limpiar: solo admin del .env (administrativo), nacho (comercial_jefe, 0000023) y jruiz (comercial, 0000028)',
  JSON.stringify(usuarios) === JSON.stringify([{ usuario: process.env.APP_USUARIO, rol: 'administrativo', karve_id: null }, { usuario: 'nacho', rol: 'comercial_jefe', karve_id: '0000023' }, { usuario: 'jruiz', rol: 'comercial', karve_id: '0000028' }]), JSON.stringify(usuarios));
ok('--limpiar: muestra la contraseña inicial una vez y el siguiente paso', /Contraseña inicial de nacho y jruiz: \S{6,}/.test(salida) && /Sincronizar Karve/.test(salida));
d2.close();

console.log(res.join('\n'));
const fallos = res.filter((r) => r.startsWith('FALLO')).length;
console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
