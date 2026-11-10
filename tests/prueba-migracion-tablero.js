// Prueba de la migración al Tablero v2 (F4-04) sobre una BD temporal: se crea la base nueva, se le meten los 10 estados
// antiguos y O.T. en cada uno (algunas con karve_estado) y se vuelve a lanzar migrar() → verticales + etiquetas.
// Uso: RUTA_BD=<db nueva> APP_USUARIO=admin_prueba APP_CLAVE=... node tests/prueba-migracion-tablero.js  (lo lanza tests/ejecutar-fase3.ps1)
const fs = require('fs');
const ruta = process.env.RUTA_BD;
if (!ruta) { console.error('Falta RUTA_BD'); process.exit(2); }
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(ruta + s); } catch {} }

const { db, migrar, ESTADO_V2_POR_ANTIGUO } = require('../db'); // base nueva: ya nace con las verticales v2
const res = [];
const ok = (n, c, e = '') => res.push(`${c ? 'OK ' : 'FALLO'} ${n}${e ? ' — ' + e : ''}`);

// Estados antiguos (como los dejaba la Fase 3) y una O.T. por caso.
const ANTIGUOS = [
  ['abierta', 'Abierta', 1], ['pendiente_repuesto', 'Pendiente de repuesto', 2], ['pendiente_asignacion', 'Pendiente de asignación', 3],
  ['asignada', 'Asignada', 4], ['pendiente_pedido', 'Pendiente de Nº pedido', 8], ['vb_factura', 'Visto bueno factura', 9],
];
const prep = db.transaction(() => {
  for (const [codigo, nombre, orden] of ANTIGUOS) {
    db.prepare('INSERT INTO fases (codigo, nombre, orden, abierta) VALUES (?, ?, ?, 1)').run(codigo, nombre, orden + 10);
    db.prepare('INSERT INTO estados (codigo, nombre, fase, orden, es_inicial, es_final, prioridad_defecto, color, activo) VALUES (?, ?, ?, 1, ?, 0, 2, NULL, 1)').run(codigo, nombre, codigo, codigo === 'abierta' ? 1 : 0);
  }
  db.prepare("INSERT INTO transiciones (origen, destino, rol) VALUES ('abierta', 'asignada', 'administrativo')").run();
  db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES ('gsat', 'Gestora', 'x', 'gestor_sat')").run();
  db.prepare("INSERT INTO clientes (nombre) VALUES ('Cliente migración')").run();
  const ins = db.prepare('INSERT INTO ot (numero, anio, secuencia, cliente_id, estado, karve_estado, creado_por) VALUES (?, 2026, ?, 1, ?, ?, 1)');
  const insH = db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, nota) VALUES (?, ?, ?, ?)');
  const casos = [
    ['0000000001', 'abierta', null], ['0000000002', 'pendiente_asignacion', null], ['0000000003', 'asignada', 'HACER'],
    ['0000000004', 'pendiente_repuesto', 'RECAMBIOS'], ['0000000005', 'pendiente_pedido', 'PDTE Nº PEDIDO'], ['0000000006', 'vb_factura', 'Vº B FACT.'],
    ['0000000007', 'pausada', 'PDTE OK PPTO'], ['0000000008', 'pausada', 'PPTO'], ['0000000009', 'en_curso', 'S.A.T. EXTERNO'], ['0000000010', 'en_curso', null],
    ['0000000011', 'finalizada', 'PDTE ALBARAN'], ['0000000012', 'finalizada', 'HECHO'], ['0000000013', 'cerrada', 'HECHO'],
  ];
  casos.forEach(([numero, estado, karve], i) => {
    const info = ins.run(numero, i + 1, estado, karve);
    insH.run(info.lastInsertRowid, null, 'abierta', 'Apertura');
    if (estado !== 'abierta') insH.run(info.lastInsertRowid, 'abierta', estado, 'paso');
  });
});
prep();

migrar(); // segunda pasada: detecta los estados antiguos activos y recoloca

const otPor = Object.fromEntries(db.prepare('SELECT numero, estado, etiqueta FROM ot').all().map((o) => [o.numero, `${o.estado}:${o.etiqueta || ''}`]));
const esperado = {
  '0000000001': 'pendiente_planificar:', '0000000002': 'pendiente_planificar:', '0000000003': 'planificada:',
  '0000000004': 'pausada:repuesto', '0000000005': 'pausada:num_pedido', '0000000006': 'finalizada:vb_factura',
  '0000000007': 'pausada:ok_presupuesto', '0000000008': 'pausada:presupuesto', '0000000009': 'en_curso:sat_externo', '0000000010': 'en_curso:',
  '0000000011': 'finalizada:albaran', '0000000012': 'finalizada:', '0000000013': 'cerrada:',
};
for (const [numero, esp] of Object.entries(esperado)) ok(`O.T. ${numero}: ${esp}`, otPor[numero] === esp, otPor[numero]);

const fases = db.prepare('SELECT codigo FROM fases ORDER BY orden').all().map((f) => f.codigo);
ok('fases: solo las 6 verticales v2, en orden', fases.join(',') === 'pendiente_planificar,planificada,en_curso,pausada,finalizada,cerrada', fases.join(','));
const viejos = db.prepare(`SELECT codigo, activo, fase FROM estados WHERE codigo IN (${Object.keys(ESTADO_V2_POR_ANTIGUO).map(() => '?').join(',')})`).all(...Object.keys(ESTADO_V2_POR_ANTIGUO));
ok('estados antiguos: inactivos y colgados de su vertical nueva (pendiente_repuesto → pausada, vb_factura → finalizada)', viejos.length === 6 && viejos.every((e) => e.activo === 0 && e.fase === ESTADO_V2_POR_ANTIGUO[e.codigo][0]), JSON.stringify(viejos));
ok('estados activos: exactamente las 6 verticales', db.prepare('SELECT COUNT(*) n FROM estados WHERE activo = 1').get().n === 6);
ok('transiciones vaciadas', db.prepare('SELECT COUNT(*) n FROM transiciones').get().n === 0);
ok('etiquetas: 11 cargadas', db.prepare('SELECT COUNT(*) n FROM etiquetas').get().n === 11);
const hist = db.prepare(`SELECT h.estado_nuevo, e.nombre FROM ot_historial h LEFT JOIN estados e ON e.codigo = h.estado_nuevo JOIN ot o ON o.id = h.ot_id WHERE o.numero = '0000000004' ORDER BY h.id DESC LIMIT 1`).get();
ok('historial: el paso antiguo sigue leyéndose con su nombre ("Pendiente de repuesto")', hist && hist.estado_nuevo === 'pendiente_repuesto' && hist.nombre === 'Pendiente de repuesto', JSON.stringify(hist));
ok('usuario gestor_sat → operativo', db.prepare("SELECT rol FROM usuarios WHERE usuario = 'gsat'").get().rol === 'operativo');
ok('tabla ot_bloques creada con sus índices', db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('ot_bloques', 'idx_ot_bloques_tecnico_dia')").get().n === 2);

let error = null;
try { migrar(); } catch (e) { error = e; }
ok('migrar() otra vez no hace nada ni falla', !error && db.prepare('SELECT COUNT(*) n FROM estados WHERE activo = 1').get().n === 6 && otPor['0000000004'] === 'pausada:repuesto', error && error.message);

console.log(res.join('\n'));
const fallos = res.filter((r) => r.startsWith('FALLO')).length;
console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
process.exit(fallos ? 1 : 0);
