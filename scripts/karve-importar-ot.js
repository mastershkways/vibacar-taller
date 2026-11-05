// scripts/karve-importar-ot.js — Importa de Karve las O.T. vivas y una muestra de las cerradas recientes (F3.6-01).
//   node scripts/karve-importar-ot.js                 → base de pruebas (KARVE_COPIA_CONNECTION_STRING), escribe en la BD local
//   node scripts/karve-importar-ot.js --simular       → mismo informe sin escribir nada
//   node scripts/karve-importar-ot.js --cerradas=300  → cuántas cerradas recientes traer (150 por defecto, 0 = ninguna)
//   node scripts/karve-importar-ot.js produccion      → contra KARVE_CONNECTION_STRING
// Antes hay que tener sincronizados clientes y máquinas (scripts/karve-sincronizar.js): una O.T. cuyo cliente no esté
// en la base local se omite. Se puede repetir: lo ya importado y no tocado en la app se actualiza; lo tocado se conserva.
// Código de salida 0 si va bien, 1 si falla. No hace falta que el servidor esté arrancado.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { importar, CERRADAS_DEFECTO } = require('../karve-importar-ot');

const args = process.argv.slice(2);
const entorno = args.find((a) => a === 'produccion' || a === 'copia') || 'copia';
const simular = args.includes('--simular');
const argCerradas = args.find((a) => a.startsWith('--cerradas='));
const cerradas = argCerradas ? Number.parseInt(argCerradas.split('=')[1], 10) : CERRADAS_DEFECTO;

(async () => {
  console.log(`Importación de O.T. desde Karve (${entorno}, vivas + ${cerradas} cerradas recientes)${simular ? ' — SIMULACIÓN, no se escribe nada' : ''}…`);
  try {
    const r = await importar({ entorno, cerradas, origen: 'cron', simular });
    const linea = (n, x) => `   ${n}: ${x.leidas} leídas · ${x.nuevas} nuevas · ${x.actualizadas} actualizadas · ${x.sin_cambios} sin cambios · ${x.conservadas} conservadas`;
    console.log(`✅ Hecho en ${(r.duracion_ms / 1000).toFixed(1)} s`);
    console.log(linea('Vivas', r.vivas));
    console.log(linea('Cerradas', r.cerradas));
    const porEstado = Object.entries(r.por_estado).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(' · ');
    if (porEstado) console.log(`   Nuevas por estado local: ${porEstado}`);
    for (const a of r.avisos) console.log(`   ⚠️ ${a}`);
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
})();
