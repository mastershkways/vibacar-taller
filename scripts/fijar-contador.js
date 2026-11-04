// scripts/fijar-contador.js — Contador de numeración de O.T. (formato Karve, 10 dígitos).
//
//   node scripts/fijar-contador.js                 muestra el contador local, el próximo número y el máximo de Karve
//   node scripts/fijar-contador.js --karve         sube el contador local al máximo de Karve (nunca lo baja)
//   node scripts/fijar-contador.js 107950          la última O.T. real es la 0000107950 → la próxima será 0000107951
//   node scripts/fijar-contador.js 50 --forzar     permite bajar por debajo de O.T. ya existentes (peligroso)
//
// El servidor ya sincroniza el contador con Karve al arrancar, en cada "Sincronizar Karve" y antes de cada alta;
// este script es para comprobarlo o para arrancar sin conexión. No hace falta parar el servidor.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { fijarContador, leerContador, proximoNumero, leerMaximoKarve, sincronizarContadorKarve, formatearNumero } = require('../numeracion');

const args = process.argv.slice(2);
const forzar = args.includes('--forzar');
const desdeKarve = args.includes('--karve');
const valores = args.filter((a) => !a.startsWith('--'));

(async () => {
  try {
    if (desdeKarve) {
      const r = await sincronizarContadorKarve();
      if (r.maximoKarve === null) { console.error('No se ha podido leer el máximo de Karve (¿falta la cadena en el .env o no responde?)'); process.exit(1); }
      console.log(`Máximo en Karve: ${formatearNumero(r.maximoKarve)} · contador local: ${r.contador} (${r.actualizado ? 'actualizado' : 'ya estaba al día'}) · próxima O.T.: ${r.proximo}`);
      return;
    }
    if (!valores.length) {
      const actual = leerContador();
      console.log(`Contador local: ${actual === null ? 'sin crear (se creará con CONTADOR_OT_INICIAL del .env o con el máximo ya usado)' : actual} · próximo número: ${proximoNumero()}`);
      const max = await leerMaximoKarve().catch((e) => { console.log(`Karve: ${e.message}`); return null; });
      if (max !== null) console.log(`Máximo en Karve: ${formatearNumero(max)}${max > (actual ?? 0) ? ' → el contador local está por debajo: ejecuta --karve o deja que el servidor lo suba en la próxima alta' : ''}`);
      return;
    }
    const r = fijarContador(valores[0], { forzar });
    console.log(`Contador fijado en ${r.valor}. La próxima O.T. será la ${r.proximo}.`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }
})();
