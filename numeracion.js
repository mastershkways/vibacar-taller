// numeracion.js — Numeración de las Órdenes de Trabajo con el formato de Karve: secuencial de 10 dígitos
// rellenado con ceros (0000107951), sin año. Decisión de Sendoa (2026-11-04): administración sigue abriendo
// O.T. en el ERP, así que nuestras O.T. tienen que seguir la misma secuencia para que las encuentren después.
//
// Cómo se evita la colisión:
//   - contador local 'ot' en la tabla `contadores` (reparte números sin duplicados entre usuarios concurrentes);
//   - antes de cada alta, rutas-ot.js lee el máximo de Karve (kv_vOrdenesTrabajo) y se lo pasa como `minimo`:
//     el número asignado es siempre MAX(contador, máximo de Karve, máximo local) + 1;
//   - si Karve no responde, se usa el contador local (que se sincroniza al arrancar, en cada sincronización y
//     con scripts/fijar-contador.js --karve), y queda un aviso en el log.
// También vive aquí el nº de flota de máquinas (correlativo numérico, el mismo código que usa Karve).

const { db, ahora } = require('./db');
const karve = require('./karve');

const ANCHO = 10;
const CLAVE = 'ot';

function anioActual() {
  return new Date().getFullYear();
}

function formatearNumero(secuencia) {
  return String(secuencia).padStart(ANCHO, '0');
}

// Mayor secuencia ya usada en la tabla ot (0 si no hay ninguna).
function maxSecuenciaUsada() {
  const fila = db.prepare('SELECT MAX(secuencia) AS m FROM ot').get();
  return fila && fila.m ? fila.m : 0;
}

// Valor actual del contador, o null si todavía no existe.
function leerContador() {
  const fila = db.prepare('SELECT valor FROM contadores WHERE clave = ?').get(CLAVE);
  return fila ? fila.valor : null;
}

// Valor con el que se crea el contador la primera vez: CONTADOR_OT_INICIAL del .env (último número real
// conocido) o lo ya usado en la tabla ot, lo que sea mayor.
function valorInicial() {
  const env = parseInt(process.env.CONTADOR_OT_INICIAL, 10);
  return Math.max(Number.isInteger(env) && env > 0 ? env : 0, maxSecuenciaUsada());
}

// Fija el contador a un valor concreto (último número usado). No se baja por debajo de lo ya usado salvo forzar.
function fijarContador(valor, { forzar = false } = {}) {
  valor = parseInt(valor, 10);
  if (!Number.isInteger(valor) || valor < 0) throw new Error(`Valor no válido: ${valor}`);
  const usado = maxSecuenciaUsada();
  if (valor < usado && !forzar) {
    throw new Error(`No se puede fijar el contador en ${valor}: ya existe la O.T. ${formatearNumero(usado)}. Usa --forzar si sabes lo que haces.`);
  }
  db.prepare(`INSERT INTO contadores (clave, valor, actualizado) VALUES (?, ?, ?)
              ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, actualizado = excluded.actualizado`)
    .run(CLAVE, valor, ahora());
  return { valor, proximo: formatearNumero(valor + 1) };
}

// Reserva y devuelve el siguiente número. Transacción IMMEDIATE: dos peticiones simultáneas nunca obtienen el
// mismo número. `minimo` = máximo leído en Karve justo antes (rutas-ot.js); la secuencia nunca queda por debajo.
const siguienteNumeroOT = db.transaction(({ minimo = 0 } = {}) => {
  let fila = db.prepare('SELECT valor FROM contadores WHERE clave = ?').get(CLAVE);
  if (!fila) {
    const inicial = valorInicial();
    db.prepare('INSERT INTO contadores (clave, valor, actualizado) VALUES (?, ?, ?)').run(CLAVE, inicial, ahora());
    fila = { valor: inicial };
  }
  const secuencia = Math.max(fila.valor, maxSecuenciaUsada(), Number(minimo) || 0) + 1;
  db.prepare('UPDATE contadores SET valor = ?, actualizado = ? WHERE clave = ?').run(secuencia, ahora(), CLAVE);
  return { secuencia, numero: formatearNumero(secuencia), anio: anioActual() };
}).immediate;

// Vista previa sin reservar.
function proximoNumero() {
  const actual = leerContador();
  const base = actual === null ? valorInicial() : actual;
  return formatearNumero(Math.max(base, maxSecuenciaUsada()) + 1);
}

// Máximo número de O.T. en Karve (solo los ids numéricos: hay 27 históricos con sufijo, p. ej. 0058757MO).
// Devuelve null si no hay conexión configurada o no responde en `timeoutMs`.
async function leerMaximoKarve({ entorno = 'copia', timeoutMs = 8000 } = {}) {
  if (!karve.hayConfiguracion(entorno)) return null;
  const consulta = karve.consultar('SELECT MAX(CAST(id AS BIGINT)) AS maximo FROM CV.kv_vOrdenesTrabajo WHERE ISNUMERIC(id) = 1', [], { entorno });
  const tope = new Promise((_, rej) => setTimeout(() => rej(new Error(`Karve no responde en ${timeoutMs} ms`)), timeoutMs));
  const { filas } = await Promise.race([consulta, tope]);
  const m = filas[0] && filas[0].maximo;
  return m === null || m === undefined ? null : Number(m);
}

// Sube el contador local hasta el máximo de Karve si está por debajo. Nunca lo baja.
async function sincronizarContadorKarve({ entorno = 'copia', timeoutMs = 8000 } = {}) {
  const maximoKarve = await leerMaximoKarve({ entorno, timeoutMs });
  if (maximoKarve === null) return { maximoKarve: null, contador: leerContador(), proximo: proximoNumero(), actualizado: false };
  const actual = Math.max(leerContador() ?? 0, maxSecuenciaUsada());
  const actualizado = maximoKarve > actual;
  if (actualizado) fijarContador(maximoKarve);
  return { maximoKarve, contador: leerContador(), proximo: proximoNumero(), actualizado };
}

// ---------------------------------------------------------------------------
// Nº de flota de máquinas (F3.5-06): es el código numérico de la máquina en Karve (kv_vMaquinas.id sin ceros a la
// izquierda, p. ej. 3641; crecerá a 5 cifras sin más). Para una máquina creada a mano se asigna el siguiente al mayor
// numérico que haya en maquinas.num_flota; los códigos no numéricos (001854C, IB-12) no cuentan. Sin contador aparte:
// el máximo real manda, así la sincronización con Karve y las altas manuales no se pisan.
// ---------------------------------------------------------------------------
const siguienteNumeroFlota = db.transaction(() => {
  const fila = db.prepare("SELECT MAX(CAST(num_flota AS INTEGER)) AS m FROM maquinas WHERE num_flota IS NOT NULL AND num_flota <> '' AND num_flota NOT GLOB '*[^0-9]*'").get();
  return String((fila && fila.m ? fila.m : 0) + 1);
}).immediate;

module.exports = { siguienteNumeroOT, fijarContador, leerContador, proximoNumero, formatearNumero, anioActual, leerMaximoKarve, sincronizarContadorKarve, siguienteNumeroFlota };
