// scripts/karve-probar.js — Comprueba la conexión de solo lectura a Karve.
//   node scripts/karve-probar.js            → base de pruebas (KARVE_COPIA_CONNECTION_STRING)
//   node scripts/karve-probar.js produccion → producción (KARVE_CONNECTION_STRING)
// No imprime nunca la cadena de conexión.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const karve = require('../karve');

const entorno = process.argv[2] || 'copia';
(async () => {
  if (!karve.hayConfiguracion(entorno)) {
    console.error(`Falta ${karve.ENTORNOS[entorno].variable} en el .env`);
    process.exit(2);
  }
  try {
    const r = await karve.probar(entorno);
    console.log(`✅ Conectado a ${karve.ENTORNOS[entorno].nombre}`);
    console.log(`   Base: ${r.base} · usuario: ${r.usuario} · hora del servidor: ${r.ahora} · ${r.ms} ms`);
    console.log(`   Servidor: ${String(r.version).split('\n')[0].slice(0, 120)}`);
  } catch (e) {
    console.error(`❌ No se ha podido conectar: ${karve.describirError(e)}`);
    process.exit(1);
  }
})();
