// scripts/karve-sincronizar.js — Sincroniza clientes, contactos y máquinas desde Karve (solo lectura en Karve).
//   node scripts/karve-sincronizar.js               → base de pruebas (KARVE_COPIA_CONNECTION_STRING), escribe en la BD local
//   node scripts/karve-sincronizar.js --simular     → mismo informe sin escribir nada
//   node scripts/karve-sincronizar.js produccion    → contra KARVE_CONNECTION_STRING
// Pensado para el Programador de tareas de Windows (cron nocturno): código de salida 0 si va bien, 1 si falla.
// La base local se toma del .env (RUTA_BD o .cache/datos.db); no hace falta que el servidor esté arrancado.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { sincronizar } = require('../karve-sincronizar');

const args = process.argv.slice(2);
const entorno = args.find((a) => a === 'produccion' || a === 'copia') || 'copia';
const simular = args.includes('--simular');

(async () => {
  console.log(`Sincronización desde Karve (${entorno})${simular ? ' — SIMULACIÓN, no se escribe nada' : ''}…`);
  try {
    const r = await sincronizar({ entorno, origen: 'cron', simular });
    const linea = (n, x) => `   ${n}: ${x.leidos} leídos · ${x.nuevos} nuevos · ${x.actualizados} actualizados · ${x.sin_cambios} sin cambios`;
    console.log(`✅ Hecho en ${(r.duracion_ms / 1000).toFixed(1)} s`);
    console.log(linea('Clientes', r.clientes) + ` · ${r.clientes.bajas} de baja en Karve`);
    console.log(linea('Contactos', r.contactos) + ` · ${r.contactos.huecos_rellenados} huecos de ficha rellenados`);
    console.log(linea('Máquinas', r.maquinas) + ` · ${r.maquinas.sin_cliente} sin cliente (omitidas)`);
    for (const a of r.avisos) console.log(`   ⚠️ ${a}`);
    process.exit(0);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
})();
