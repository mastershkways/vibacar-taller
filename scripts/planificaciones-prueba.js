// scripts/planificaciones-prueba.js — Planificaciones de PRUEBA para ver el Planificador con datos (demos y desarrollo).
//
//   node scripts/planificaciones-prueba.js              simulación: dice qué haría y no escribe nada
//   node scripts/planificaciones-prueba.js --aplicar    lo escribe en la base de RUTA_BD (por defecto .cache/datos.db)
//   node scripts/planificaciones-prueba.js --quitar     quita los bloques de prueba y desactiva los usuarios prueba_*
//
// Es una capa de SEED sobre los datos traídos de Karve, para entornos de pruebas (también el de Sendoa mientras se valida la
// aplicación; con RUTA_BD se puede apuntar a una copia). Para dejar la base limpia al final: `--quitar`, o la purga completa
// (`node scripts/generar-datos-prueba.js --limpiar` + sincronizar + importar O.T.). Usa las mismas reglas que la aplicación
// (crearBloque / aplicarCambioEstado), así que el estado, el técnico y el historial quedan como si se hubiera planificado a mano.
//
// Qué hace con --aplicar:
//   - Técnicos: si no hay ninguno activo, crea usuarios de prueba (prueba_tec1…) con el nombre de los operarios de Karve que más
//     O.T. planificadas tienen (se saltan los genéricos: TALLER, REPUESTOS, ADMINISTRACION…) y un SAT externo de prueba. Si Karve
//     responde (SOLO LECTURA, base de pruebas), les pone su código de operario real en `karve_id`, para que la importación de
//     O.T. los enlace como hará con los técnicos de verdad.
//   - Reparte las O.T. planificadas de cada uno en los próximos días laborables (2 a 4 por día, de 1 a 4 h, con hueco para comer),
//     con un día sobrecargado, un solape y una O.T. partida en dos días para que se vean los avisos y los carriles.
//   - Bandeja: marca 3 O.T. pausadas por repuesto como "repuesto recibido" y preplanifica una pausada por presupuesto.
//   - Crea prueba_responsable (rol responsable_st, contraseña prueba123) para entrar directamente en el Planificador.
// Todo lo que crea lleva el usuario prueba_responsable como autor: así --quitar sabe qué deshacer.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { db, ahora, hashClave, RUTA_BD } = require('../db');
const karve = require('../karve');
const rutasOT = require('../rutas-ot');
const plan = require('../rutas-planificador');

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--ayuda')) { console.log('Uso: node scripts/planificaciones-prueba.js [--aplicar | --quitar]'); process.exit(0); }
const aplicar = args.includes('--aplicar');
const quitar = args.includes('--quitar');
const CLAVE = 'prueba123';
const N_TECNICOS = 6;
const DIAS = 8;                                             // días laborables a rellenar, empezando hoy
const GENERICOS = /^(AREA RECAMBIOS|TALLER|REPUESTOS|RECAMBIOS|MANTENIMIENTOS|ADMINISTRACION|ALMACEN|COMERCIAL|S\.?A\.?T\.?.*|\W.*)$/i;
const DURACIONES = [120, 90, 180, 60, 150, 120, 240];

const dos = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const horaDe = (min) => `${dos(Math.floor(min / 60))}:${dos(min % 60)}`;
const nombrePropio = (s) => s.trim().toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
function laborables(n, desde = 0) {                           // n días laborables a partir de hoy + desde (hacia delante)
  const dias = []; const d = new Date(); d.setDate(d.getDate() + desde);
  while (dias.length < n) { if (d.getDay() !== 0 && d.getDay() !== 6) dias.push(iso(d)); d.setDate(d.getDate() + 1); }
  return dias;
}
function laborableAnterior() { const d = new Date(); do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6); return iso(d); }

console.log(`Base: ${RUTA_BD}`);
const resumen = { tecnicos: [], bloques: 0, porDia: {}, propuestas: 0, preplanificadas: 0, partidas: 0, vencidos: 0 };
class Simulacion extends Error {}

// Código de operario de Karve por nombre (solo lectura; si Karve no responde en 60 s se sigue sin códigos).
async function codigosKarve() {
  if (!karve.hayConfiguracion('copia')) return { mapa: new Map(), nota: 'sin cadena de conexión a Karve: técnicos sin código de operario' };
  try {
    const consulta = karve.consultar('SELECT DISTINCT operarioAsignado AS codigo, nomOperarioAsignado AS nombre FROM CV.kv_vOrdenesTrabajo WHERE fechaCierre IS NULL AND operarioAsignado IS NOT NULL', [], { entorno: 'copia' });
    const limite = new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('Karve no responde en 60 s')), 60000));
    const { filas } = await Promise.race([consulta, limite]);
    return { mapa: new Map(filas.map((f) => [String(f.nombre || '').trim(), String(f.codigo || '').trim()])), nota: null };
  } catch (e) {
    return { mapa: new Map(), nota: `no se han podido leer los códigos de operario de Karve (${karve.describirError ? karve.describirError(e) : e.message}): técnicos sin código` };
  }
}

function autor() {
  let u = db.prepare("SELECT id, usuario, nombre, rol FROM usuarios WHERE usuario = 'prueba_responsable'").get();
  if (!u) {
    const info = db.prepare("INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES ('prueba_responsable', 'Responsable (prueba)', ?, 'responsable_st')").run(hashClave(CLAVE));
    u = { id: info.lastInsertRowid, usuario: 'prueba_responsable', nombre: 'Responsable (prueba)', rol: 'responsable_st' };
  } else db.prepare('UPDATE usuarios SET activo = 1 WHERE id = ?').run(u.id);
  return u;
}

// ---------------------------------------------------------------------------
// --quitar
// ---------------------------------------------------------------------------
if (quitar) {
  const u = db.prepare("SELECT id, usuario, nombre, rol FROM usuarios WHERE usuario = 'prueba_responsable'").get();
  if (!u) { console.log('No hay datos de prueba (no existe prueba_responsable).'); process.exit(0); }
  const bloques = db.prepare('SELECT * FROM ot_bloques WHERE creado_por = ? ORDER BY dia DESC, id DESC').all(u.id);
  db.transaction(() => {
    for (const b of bloques) plan.quitarBloque(b.ot_id, b, u);
    db.prepare("UPDATE usuarios SET activo = 0 WHERE usuario LIKE 'prueba\\_%' ESCAPE '\\'").run();
    db.prepare("DELETE FROM sesiones WHERE usuario_id IN (SELECT id FROM usuarios WHERE usuario LIKE 'prueba\\_%' ESCAPE '\\')").run();
  })();
  console.log(`✅ Quitados ${bloques.length} bloques de prueba; usuarios prueba_* desactivados. Las O.T. que se quedan sin plan vuelven a "Pendiente de planificar".`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Generación (dentro de una transacción; sin --aplicar se deshace al final)
// ---------------------------------------------------------------------------
function generar(codigos) {
  const u = autor();
  const hoy = iso(new Date());

  // Técnicos: los que haya; si no hay, de prueba con los nombres de los operarios de Karve.
  let tecnicos = db.prepare("SELECT id, nombre, rol FROM usuarios WHERE activo = 1 AND rol IN ('tecnico', 'sat') ORDER BY (rol = 'sat'), id").all();
  if (!tecnicos.length) {
    const operarios = db.prepare(`SELECT karve_operario AS nombre, COUNT(*) AS n FROM ot WHERE estado = 'planificada' AND karve_operario IS NOT NULL GROUP BY 1 ORDER BY n DESC`).all()
      .filter((o) => !GENERICOS.test(o.nombre.trim())).slice(0, N_TECNICOS);
    const lista = operarios.length ? operarios.map((o) => [nombrePropio(o.nombre), o.nombre]) : Array.from({ length: 4 }, (_, i) => [`Técnico ${i + 1} (prueba)`, null]);
    const ins = db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol, karve_id) VALUES (?, ?, ?, ?, ?)');
    lista.forEach(([nombre, operario], i) => {
      const login = `prueba_tec${i + 1}`;
      const codigo = (operario && codigos.get(operario.trim())) || null;
      const ya = db.prepare('SELECT id FROM usuarios WHERE usuario = ?').get(login);
      if (ya) db.prepare("UPDATE usuarios SET activo = 1, nombre = ?, rol = 'tecnico', karve_id = ? WHERE id = ?").run(nombre, codigo, ya.id);
      tecnicos.push({ id: ya ? ya.id : ins.run(login, nombre, hashClave(CLAVE), 'tecnico', codigo).lastInsertRowid, nombre, rol: 'tecnico', karve: operario, codigo });
    });
    const sat = db.prepare("SELECT id FROM usuarios WHERE usuario = 'prueba_sat'").get();
    if (sat) db.prepare('UPDATE usuarios SET activo = 1 WHERE id = ?').run(sat.id);
    tecnicos.push({ id: sat ? sat.id : ins.run('prueba_sat', 'SAT externo (prueba)', hashClave(CLAVE), 'sat', null).lastInsertRowid, nombre: 'SAT externo (prueba)', rol: 'sat', karve: null });
  }
  resumen.tecnicos = tecnicos.map((t) => `${t.nombre}${t.rol === 'sat' ? ' (SAT)' : ''}${t.codigo ? ` [Karve ${t.codigo}]` : ''}`);

  const sinFuturo = `NOT EXISTS (SELECT 1 FROM ot_bloques b WHERE b.ot_id = o.id AND b.dia >= '${hoy}')`;
  const usadas = new Set();
  const cola = (where, params = []) => db.prepare(`SELECT o.id, o.numero FROM ot o WHERE ${sinFuturo} AND ${where} ORDER BY o.prioridad, o.fecha_prevista DESC, o.id DESC`).all(...params).filter((o) => !usadas.has(o.id));
  const comunes = cola("o.estado IN ('planificada', 'pendiente_planificar') AND o.tecnico_id IS NULL");
  const bloque = (ot, tecnico, dia, minuto, duracion, nota = null) => {
    plan.crearBloque(ot.id, { tecnico_id: tecnico.id, dia, hora_inicio: horaDe(minuto), duracion_min: duracion, nota }, u);
    usadas.add(ot.id);
    resumen.bloques++;
    resumen.porDia[dia] = (resumen.porDia[dia] || 0) + 1;
  };

  const dias = laborables(DIAS);
  tecnicos.forEach((t, ti) => {
    // Sus O.T.: las que Karve le tiene asignadas (por nombre de operario); el SAT, las de etiqueta "SAT externo"; si faltan, del montón común.
    let suyas = t.rol === 'sat'
      ? cola("o.estado = 'en_curso' AND o.etiqueta = 'sat_externo'")
      : (t.karve ? cola("o.estado = 'planificada' AND o.karve_operario = ?", [t.karve]) : []);
    const siguiente = () => { let ot = suyas.shift(); while (!ot && comunes.length) { const c = comunes.shift(); if (!usadas.has(c.id)) ot = c; } return ot || null; };
    let k = ti;                                                 // índice para variar duraciones
    dias.forEach((dia, di) => {
      const sobrecarga = ti === 0 && di === 1;                    // un día con más horas que la jornada
      const cuantas = sobrecarga ? 5 : (t.rol === 'sat' ? 1 + ((ti + di) % 2) : 2 + ((ti + di) % 3));
      let minuto = 8 * 60 + (ti % 2) * 30;
      for (let n = 0; n < cuantas; n++) {
        const ot = siguiente();
        if (!ot) return;
        const duracion = sobrecarga ? 150 : DURACIONES[k++ % DURACIONES.length];
        if (!sobrecarga && minuto >= 12 * 60 + 30 && minuto < 14 * 60) minuto = 14 * 60;      // hueco para comer
        if (!sobrecarga && minuto + duracion > 18 * 60) return;
        const solape = ti === 1 && di === 2 && n === 1;            // un bloque que pisa al anterior
        bloque(ot, t, dia, solape ? minuto - 60 : minuto, duracion, solape ? 'Coincide con la anterior: revisar' : null);
        if (ti === 2 && di === 0 && n === 0 && dias[1]) {            // una O.T. partida en dos días
          plan.crearBloque(ot.id, { tecnico_id: t.id, dia: dias[1], hora_inicio: '15:30', duracion_min: 120, nota: 'Continuación' }, u);
          resumen.bloques++; resumen.partidas++; resumen.porDia[dias[1]] = (resumen.porDia[dias[1]] || 0) + 1;
        }
        minuto += duracion + 30;                                  // media hora de desplazamiento
      }
    });
  });

  // Dos bloques de ayer que no se llegaron a hacer: la O.T. vuelve a la bandeja como "bloque vencido".
  const ayer = laborableAnterior();
  tecnicos.filter((t) => t.rol !== 'sat').slice(0, 2).forEach((t) => {
    const ot = comunes.find((o) => !usadas.has(o.id));
    if (!ot) return;
    plan.crearBloque(ot.id, { tecnico_id: t.id, dia: ayer, hora_inicio: '09:00', duracion_min: 120, nota: null }, u);
    usadas.add(ot.id); resumen.bloques++; resumen.vencidos++;
  });

  // Bandeja: tres "repuesto recibido" y una pausada por presupuesto preplanificada para la semana que viene.
  for (const ot of cola("o.estado = 'pausada' AND o.etiqueta = 'repuesto'").slice(0, 3)) {
    rutasOT.aplicarCambioEstado({ otId: ot.id, destino: 'pendiente_planificar', usuario: u, nota: 'Repuesto recibido (prueba)' });
    resumen.propuestas++;
  }
  const presupuesto = cola("o.estado = 'pausada' AND o.etiqueta IN ('presupuesto', 'ok_presupuesto')")[0];
  if (presupuesto && tecnicos[0]) {
    plan.crearBloque(presupuesto.id, { tecnico_id: tecnicos[0].id, dia: laborables(1, 7)[0], hora_inicio: '10:00', duracion_min: 180, nota: 'Pendiente de que acepten el presupuesto' }, u);
    resumen.bloques++; resumen.preplanificadas++;
  }

  // Avisos resultantes (los mismos que calcula la aplicación).
  resumen.avisos = [];
  for (const t of tecnicos) for (const dia of dias) {
    const bs = db.prepare('SELECT b.id, b.hora_inicio, b.duracion_min, c.zona AS cliente_zona FROM ot_bloques b JOIN ot o ON o.id = b.ot_id JOIN clientes c ON c.id = o.cliente_id WHERE b.tecnico_id = ? AND b.dia = ?').all(t.id, dia);
    resumen.avisos.push(...plan.avisosDe(t.id, dia, bs, t.nombre));
  }
  if (!aplicar) throw new Simulacion();
}

(async () => {
const { mapa: codigos, nota } = await codigosKarve();
if (nota) console.log(`   Aviso: ${nota}`);
try { db.transaction(() => generar(codigos))(); } catch (e) { if (!(e instanceof Simulacion)) { console.error(`Error: ${e.message}`); process.exit(1); } }

console.log(`${aplicar ? '✅ Planificaciones de prueba creadas' : 'SIMULACIÓN (no se ha escrito nada; añade --aplicar)'}: ${resumen.bloques} bloques para ${resumen.tecnicos.length} técnicos.`);
console.log(`   Técnicos: ${resumen.tecnicos.join(' · ')}`);
console.log(`   Bloques por día: ${Object.keys(resumen.porDia).sort().map((d) => `${d.slice(8)}/${d.slice(5, 7)} ${resumen.porDia[d]}`).join(' · ')}`);
console.log(`   Además: ${resumen.partidas} O.T. partida en dos días · ${resumen.vencidos} con bloque vencido (ayer) · ${resumen.propuestas} "repuesto recibido" en la bandeja · ${resumen.preplanificadas} pausada preplanificada`);
const porTipo = {};
for (const a of resumen.avisos || []) porTipo[a.tipo] = (porTipo[a.tipo] || 0) + 1;
console.log(`   Avisos: ${Object.entries(porTipo).map(([t, n]) => `${n} de ${t}`).join(' · ') || 'ninguno'}`);
if (aplicar) console.log(`   Para entrar directo al Planificador: usuario prueba_responsable, contraseña ${CLAVE}. Para deshacerlo: node scripts/planificaciones-prueba.js --quitar`);
process.exit(0);
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
