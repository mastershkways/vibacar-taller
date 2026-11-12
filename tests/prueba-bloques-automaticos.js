// Prueba de los bloques automáticos de la importación de Karve (F4-13) sobre una BD temporal, sin servidor ni Karve: se crean
// técnicos y O.T. "importadas" (origen karve, versión 1) y se llama a planificarAutomaticas() con una fecha de hoy fija.
// Uso: RUTA_BD=<db nueva> APP_USUARIO=admin_prueba APP_CLAVE=... node tests/prueba-bloques-automaticos.js  (lo lanza tests/ejecutar-fase3.ps1)
const fs = require('fs');
const ruta = process.env.RUTA_BD;
if (!ruta) { console.error('Falta RUTA_BD'); process.exit(2); }
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(ruta + s); } catch {} }

const { db } = require('../db');
const { planificarAutomaticas, laborablesDesde, HORIZONTE_LABORABLES } = require('../karve-importar-ot');
const plan = require('../rutas-planificador');
const res = [];
const ok = (n, c, e = '') => res.push(`${c ? 'OK ' : 'FALLO'} ${n}${e ? ' — ' + e : ''}`);

const HOY = '2026-03-04';                                  // miércoles
const [D1, D2, D3, D4] = laborablesDesde(HOY, 4);           // jue 05, vie 06, lun 09, mar 10
const usuario = (login, nombre, rol, karve, activo = 1) => db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol, karve_id, activo) VALUES (?, ?, ?, ?, ?, ?)').run(login, nombre, 'x', rol, karve, activo).lastInsertRowid;
const tA = usuario('ta', 'Técnico A', 'tecnico', '0000001');
const tB = usuario('tb', 'SAT B', 'sat', '0000002');
const tC = usuario('tc', 'Técnico C', 'tecnico', '0000003');
const tBaja = usuario('tx', 'Técnico de baja', 'tecnico', '0000004', 0);
const cliente = db.prepare("INSERT INTO clientes (nombre, zona) VALUES ('Cliente de bloques', 'Bizkaia')").run().lastInsertRowid;
let sec = 0;
function ot({ tecnico = tA, prevista = '2025-06-01', estado = 'planificada', prioridad = 2, version = 1, origen = 'karve' } = {}) {
  sec++;
  return db.prepare('INSERT INTO ot (numero, anio, secuencia, cliente_id, estado, prioridad, origen, tecnico_id, fecha_prevista, version) VALUES (?, 2026, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(sec).padStart(10, '0'), sec, cliente, estado, prioridad, origen, tecnico, prevista, version).lastInsertRowid;
}
const bloquesDe = (id) => db.prepare('SELECT * FROM ot_bloques WHERE ot_id = ? ORDER BY dia, hora_inicio').all(id);
const delTecnico = (t, dia) => db.prepare('SELECT hora_inicio FROM ot_bloques WHERE tecnico_id = ? AND dia = ? ORDER BY hora_inicio').all(t, dia).map((b) => b.hora_inicio).join(',');
const contador = () => ({ en_fecha: 0, repartidas: 0, quitados: 0, sin_hueco: 0, sin_repartir: 0, sin_tecnico: 0 });
const lanzar = (opciones = {}) => db.transaction(() => planificarAutomaticas(contador(), { hoy: HOY, ...opciones }))();

ok('los 4 laborables siguientes a un miércoles saltan el fin de semana', [D1, D2, D3, D4].join() === '2026-03-05,2026-03-06,2026-03-09,2026-03-10', [D1, D2, D3, D4].join());

// --- Primera pasada -----------------------------------------------------------------------------------------------------
const enFecha1 = ot({ prevista: D2 });
const enFecha2 = ot({ prevista: D2 });
const urgente = ot({ prioridad: 1, prevista: '2025-09-01' });
const vencidas = [ot({ prevista: '2025-01-10' }), ot({ prevista: '2025-02-10' }), ot({ prevista: '2025-03-10' }), ot({ prevista: '2025-04-10' }), ot({ prevista: '2025-05-10' })];
const sinTecnico = ot({ tecnico: null });
const deBaja = ot({ tecnico: tBaja });
const tocada = ot({ version: 2 });
const pausada = ot({ estado: 'pausada' });
const manual = ot({ origen: 'manual' });
const hoyMismo = ot({ tecnico: tB, prevista: HOY });

let r = lanzar();
ok('contadores: 3 en su fecha, 6 repartidas, 1 sin técnico, nada quitado ni sin hueco', r.en_fecha === 3 && r.repartidas === 6 && r.sin_tecnico === 1 && r.quitados === 0 && r.sin_hueco === 0, JSON.stringify(r));
let b = bloquesDe(enFecha1)[0];
ok('fecha prevista futura → bloque ese día a las 08:00, 2 h, origen karve, sin autor', b && b.dia === D2 && b.hora_inicio === '08:00' && b.duracion_min === 120 && b.origen === 'karve' && b.creado_por === null && b.tecnico_id === tA, JSON.stringify(b));
ok('la segunda del mismo día y técnico se apila detrás (10:00)', bloquesDe(enFecha2)[0].hora_inicio === '10:00' && bloquesDe(enFecha2)[0].dia === D2);
ok('fecha prevista = hoy → bloque hoy', bloquesDe(hoyMismo)[0].dia === HOY && bloquesDe(hoyMismo)[0].tecnico_id === tB);
ok('la O.T. no sube de versión, no cambia de estado ni de técnico', db.prepare('SELECT version, estado, tecnico_id FROM ot WHERE id = ?').get(enFecha1).version === 1 && db.prepare('SELECT estado FROM ot WHERE id = ?').get(enFecha1).estado === 'planificada');
const h = db.prepare('SELECT * FROM ot_historial WHERE ot_id = ?').all(enFecha1);
ok('historial: "Planificada automáticamente (Karve): vie 06/03 08:00 · 2 h · Técnico A", sin usuario', h.length === 1 && h[0].nota === 'Planificada automáticamente (Karve): vie 06/03 08:00 · 2 h · Técnico A' && h[0].usuario_id === null && h[0].estado_anterior === 'planificada' && h[0].estado_nuevo === 'planificada', h[0] && h[0].nota);
ok('vencidas: se reparten desde mañana, la urgente la primera (jueves 08:00)', bloquesDe(urgente)[0].dia === D1 && bloquesDe(urgente)[0].hora_inicio === '08:00', JSON.stringify(bloquesDe(urgente)[0]));
ok('…después por antigüedad de la fecha prevista: jueves 10:00, 12:00 y 14:00', vencidas.slice(0, 3).map((id) => `${bloquesDe(id)[0].dia} ${bloquesDe(id)[0].hora_inicio}`).join() === `${D1} 10:00,${D1} 12:00,${D1} 14:00`, vencidas.map((id) => `${bloquesDe(id)[0].dia} ${bloquesDe(id)[0].hora_inicio}`).join());
ok('…jornada de 8 h llena el jueves: las otras dos van al viernes detrás de las de fecha fija (12:00 y 14:00)', delTecnico(tA, D1) === '08:00,10:00,12:00,14:00' && delTecnico(tA, D2) === '08:00,10:00,12:00,14:00' && bloquesDe(vencidas[3])[0].dia === D2 && bloquesDe(vencidas[3])[0].hora_inicio === '12:00', `${delTecnico(tA, D1)} | ${delTecnico(tA, D2)}`);
ok('sin bloque: sin técnico, técnico de baja, tocada en la app, pausada y creada en la app', [sinTecnico, deBaja, tocada, pausada, manual].every((id) => bloquesDe(id).length === 0));
ok('avisos del Planificador: jornada llena pero sin exceso ni solapes', plan.avisosDe(tA, D1, db.prepare('SELECT b.id, b.hora_inicio, b.duracion_min, c.zona AS cliente_zona FROM ot_bloques b JOIN ot o ON o.id = b.ot_id JOIN clientes c ON c.id = o.cliente_id WHERE b.tecnico_id = ? AND b.dia = ?').all(tA, D1)).length === 0);

// --- Repetir no cambia nada -----------------------------------------------------------------------------------------------
const antes = db.prepare('SELECT COUNT(*) AS n, SUM(id) AS s FROM ot_bloques').get();
r = lanzar();
const despues = db.prepare('SELECT COUNT(*) AS n, SUM(id) AS s FROM ot_bloques').get();
ok('segunda pasada: no crea ni quita nada', r.en_fecha === 0 && r.repartidas === 0 && r.quitados === 0 && antes.n === despues.n && antes.s === despues.s, JSON.stringify(r));

// --- Cambios en Karve sobre O.T. no tocadas ------------------------------------------------------------------------------------
db.prepare('UPDATE ot SET fecha_prevista = ? WHERE id = ?').run(D4, enFecha1);
db.prepare("UPDATE ot SET estado = 'pausada', etiqueta = 'repuesto' WHERE id = ?").run(vencidas[0]);
db.prepare('UPDATE ot SET tecnico_id = ? WHERE id = ?').run(tB, vencidas[1]);
db.prepare('UPDATE ot SET tecnico_id = ? WHERE id = ?').run(tBaja, vencidas[2]);
r = lanzar();
ok('contadores: 4 quitados, 1 recolocada en su fecha y 1 repartida', r.quitados === 4 && r.en_fecha === 1 && r.repartidas === 1, JSON.stringify(r));
ok('cambia la fecha prevista → el bloque se mueve a la fecha nueva', bloquesDe(enFecha1).length === 1 && bloquesDe(enFecha1)[0].dia === D4);
ok('deja de estar planificada → se quita su bloque', bloquesDe(vencidas[0]).length === 0);
ok('cambia de operario → el bloque pasa al técnico nuevo (su primer día libre)', bloquesDe(vencidas[1]).length === 1 && bloquesDe(vencidas[1])[0].tecnico_id === tB && bloquesDe(vencidas[1])[0].dia === D1, JSON.stringify(bloquesDe(vencidas[1])[0]));
ok('su técnico pasa a estar de baja → se quita y no se recoloca', bloquesDe(vencidas[2]).length === 0);

// --- Lo tocado a mano se respeta -----------------------------------------------------------------------------------------------
const bManual = bloquesDe(enFecha2)[0];
db.prepare("UPDATE ot_bloques SET origen = 'manual', dia = ?, hora_inicio = '16:00' WHERE id = ?").run(D3, bManual.id);
db.prepare('UPDATE ot SET version = 2 WHERE id = ?').run(enFecha2);
const bEmpezada = bloquesDe(urgente)[0];
db.prepare("UPDATE ot SET estado = 'en_curso', version = 2 WHERE id = ?").run(urgente);   // el técnico ha empezado: la O.T. ya está tocada
r = lanzar();
ok('bloque movido a mano (origen manual, O.T. tocada) → la importación no lo toca', bloquesDe(enFecha2).length === 1 && bloquesDe(enFecha2)[0].id === bManual.id && bloquesDe(enFecha2)[0].dia === D3 && bloquesDe(enFecha2)[0].hora_inicio === '16:00');
ok('O.T. empezada por el técnico → conserva su bloque automático', bloquesDe(urgente).length === 1 && bloquesDe(urgente)[0].id === bEmpezada.id && r.quitados === 0, JSON.stringify(r));

// --- Pasa el tiempo: lo automático que no se empezó se recoloca -------------------------------------------------------------
r = db.transaction(() => planificarAutomaticas(contador(), { hoy: D3 }))();   // hoy = lunes 09
const viejos = db.prepare("SELECT COUNT(*) AS n FROM ot_bloques b JOIN ot o ON o.id = b.ot_id WHERE b.origen = 'karve' AND o.version = 1 AND b.dia < ?").get(D3).n;
ok('con hoy = lunes: los automáticos de la semana pasada sin empezar se quitan y se recolocan desde el martes', viejos === 0 && r.quitados >= 3 && r.repartidas >= 3 && bloquesDe(vencidas[3])[0].dia >= D4, JSON.stringify(r));
ok('…el de la O.T. empezada (ya pasado) se conserva como previsto', bloquesDe(urgente).length === 1 && bloquesDe(urgente)[0].dia === D1);

// --- Sin repartir, horizonte y tope de medianoche ------------------------------------------------------------------------------
const otra = ot({ tecnico: tC, prevista: '2025-07-01' });
r = lanzar({ repartir: false });
ok('repartir = false: la de fecha vencida no recibe bloque (sin_repartir)', bloquesDe(otra).length === 0 && r.sin_repartir >= 1 && r.repartidas === 0, JSON.stringify(r));
const muchas = Array.from({ length: HORIZONTE_LABORABLES * 4 + 4 }, () => ot({ tecnico: tC, prevista: '2025-08-01' }));   // + la anterior = 85
r = lanzar();
const porDia = db.prepare('SELECT dia, COUNT(*) AS n, SUM(duracion_min) AS m FROM ot_bloques WHERE tecnico_id = ? GROUP BY dia').all(tC);
ok(`horizonte: ${HORIZONTE_LABORABLES} días laborables a 4 por día = 80 colocadas y 5 sin hueco`, r.repartidas === 80 && r.sin_hueco === 5 && porDia.length === HORIZONTE_LABORABLES && porDia.every((d) => d.n === 4 && d.m === 480), JSON.stringify(r));
ok('…ninguna en fin de semana', porDia.every((d) => { const [a, m, dd] = d.dia.split('-').map(Number); const w = new Date(a, m - 1, dd).getDay(); return w !== 0 && w !== 6; }));
ok('…y las que no caben siguen sin bloque (bandeja)', muchas.filter((id) => bloquesDe(id).length === 0).length + (bloquesDe(otra).length === 0 ? 1 : 0) === 5);
db.prepare("INSERT INTO ot_bloques (ot_id, tecnico_id, dia, hora_inicio, duracion_min) VALUES (?, ?, '2026-04-20', '22:00', 120)").run(manual, tB);
ok('hueco con el día ocupado hasta medianoche: no pasa de las 22:00', plan.huecoPara(tB, '2026-04-20').hora_inicio === '22:00' && plan.huecoPara(tB, '2026-04-20').ocupado_min === 120, JSON.stringify(plan.huecoPara(tB, '2026-04-20')));
ok('hueco en un día vacío: 08:00', plan.huecoPara(tB, '2026-04-21').hora_inicio === '08:00' && plan.huecoPara(tB, '2026-04-21').ocupado_min === 0);

console.log(res.join('\n'));
const fallos = res.filter((x) => x.startsWith('FALLO')).length;
console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
process.exit(0);
