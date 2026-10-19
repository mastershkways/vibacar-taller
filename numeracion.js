// numeracion.js — Numeración de las Órdenes de Trabajo: AAAA-NNNN (ej. 2026-0001).
//
// El histórico real de números vive en Karve. Aquí se mantiene un contador por año en la tabla
// `contadores` (clave 'ot-2026') solo para repartir números sin duplicados entre usuarios
// concurrentes. Ese contador NO arranca ciegamente en 1: se fija con el último número real
// (de momento a mano con CONTADOR_OT_INICIAL del .env o scripts/fijar-contador.js; en la
// Fase 5, leyéndolo de Karve con fijarContador()).

const { db, ahora } = require('./db');

const ANCHO = 4; // 2026-0001

function claveDe(anio) {
  return `ot-${anio}`;
}

function anioActual() {
  return new Date().getFullYear();
}

function formatearNumero(anio, secuencia) {
  return `${anio}-${String(secuencia).padStart(ANCHO, '0')}`;
}

// Mayor secuencia ya usada en la tabla ot para ese año (0 si no hay ninguna).
function maxSecuenciaUsada(anio) {
  const fila = db.prepare('SELECT MAX(secuencia) AS m FROM ot WHERE anio = ?').get(anio);
  return fila && fila.m ? fila.m : 0;
}

// Valor actual del contador de un año, o null si todavía no existe.
function leerContador(anio = anioActual()) {
  const fila = db.prepare('SELECT valor FROM contadores WHERE clave = ?').get(claveDe(anio));
  return fila ? fila.valor : null;
}

// Valor con el que se crea el contador de un año la primera vez:
// - año actual: CONTADOR_OT_INICIAL del .env (último número real conocido), o 0 si no está.
// - otros años: 0 (la Fase 5 lo sustituirá por el valor de Karve).
// Nunca por debajo de lo que ya haya en la tabla ot.
function valorInicial(anio) {
  let v = 0;
  if (anio === anioActual()) {
    const env = parseInt(process.env.CONTADOR_OT_INICIAL, 10);
    if (Number.isInteger(env) && env > 0) v = env;
  }
  return Math.max(v, maxSecuenciaUsada(anio));
}

// Fija el contador de un año a un valor concreto (último número usado). Es el punto de entrada
// para sincronizar con Karve: fijarContador(2026, ultimaSecuenciaEnKarve).
// Por seguridad no se permite bajar por debajo de lo ya usado en la tabla ot salvo forzar=true.
function fijarContador(anio, valor, { forzar = false } = {}) {
  anio = parseInt(anio, 10);
  valor = parseInt(valor, 10);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) throw new Error(`Año no válido: ${anio}`);
  if (!Number.isInteger(valor) || valor < 0) throw new Error(`Valor no válido: ${valor}`);
  const usado = maxSecuenciaUsada(anio);
  if (valor < usado && !forzar) {
    throw new Error(`No se puede fijar el contador de ${anio} en ${valor}: ya existe la O.T. ${formatearNumero(anio, usado)}. Usa forzar si sabes lo que haces.`);
  }
  db.prepare(`INSERT INTO contadores (clave, valor, actualizado) VALUES (?, ?, ?)
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado`)
    .run(claveDe(anio), valor, ahora());
  return { anio, valor, proximo: formatearNumero(anio, valor + 1) };
}

// Reserva y devuelve el siguiente número de O.T. del año. Transacción IMMEDIATE: toma el bloqueo
// de escritura al empezar, así dos peticiones simultáneas nunca obtienen el mismo número.
const siguienteNumeroOT = db.transaction((anio = anioActual()) => {
  const clave = claveDe(anio);
  let fila = db.prepare('SELECT valor FROM contadores WHERE clave = ?').get(clave);
  if (!fila) {
    const inicial = valorInicial(anio);
    db.prepare('INSERT INTO contadores (clave, valor, actualizado) VALUES (?, ?, ?)').run(clave, inicial, ahora());
    fila = { valor: inicial };
  }
  const secuencia = fila.valor + 1;
  db.prepare('UPDATE contadores SET valor = ?, actualizado = ? WHERE clave = ?').run(secuencia, ahora(), clave);
  return { anio, secuencia, numero: formatearNumero(anio, secuencia) };
}).immediate;

// Vista previa sin reservar (para mostrar "próximo número" en pantalla).
function proximoNumero(anio = anioActual()) {
  const actual = leerContador(anio);
  const base = actual === null ? valorInicial(anio) : actual;
  return formatearNumero(anio, base + 1);
}

module.exports = { siguienteNumeroOT, fijarContador, leerContador, proximoNumero, formatearNumero, anioActual };
