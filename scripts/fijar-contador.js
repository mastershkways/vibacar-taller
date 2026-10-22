// scripts/fijar-contador.js — Fija el contador de numeración de O.T. de un año (último número usado).
//
//   node scripts/fijar-contador.js                 muestra el contador y el próximo número del año actual
//   node scripts/fijar-contador.js 412             la última O.T. real de este año es la AAAA-0412 → la próxima será AAAA-0413
//   node scripts/fijar-contador.js 412 2026        lo mismo, indicando el año
//   node scripts/fijar-contador.js 50 2026 --forzar   permite bajar por debajo de O.T. ya existentes (peligroso)
//
// Hasta que exista la sincronización con Karve (Fase 5), este script es la forma de arrancar
// con el número correlativo real. No hace falta parar el servidor.

const { fijarContador, leerContador, proximoNumero, anioActual } = require('../numeracion');

const args = process.argv.slice(2);
const forzar = args.includes('--forzar');
const valores = args.filter((a) => !a.startsWith('--'));

function mostrar(anio) {
  const actual = leerContador(anio);
  console.log(`Año ${anio}: contador ${actual === null ? 'sin crear (se creará con CONTADOR_OT_INICIAL del .env o con el máximo ya usado)' : actual}; próximo número: ${proximoNumero(anio)}`);
}

try {
  const anio = valores[1] ? parseInt(valores[1], 10) : anioActual();
  if (!valores.length) {
    mostrar(anio);
    process.exit(0);
  }
  const r = fijarContador(anio, valores[0], { forzar });
  console.log(`Contador de ${r.anio} fijado en ${r.valor}. La próxima O.T. será la ${r.proximo}.`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
