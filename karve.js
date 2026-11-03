// karve.js — Conexión de SOLO LECTURA a Karve (SAP SQL Anywhere 17) por ODBC.
//
// Reglas:
//   - El driver NO se instala por npm: va en la carpeta local `driver-sql/` (ignorada por git), que se antepone al PATH
//     para que Windows encuentre las DLL auxiliares de Sybase. El nombre "SQL Anywhere 17" tiene que estar registrado en
//     el Administrador ODBC de 64 bits (ver docs/INSTALACION.md); si no, el error es IM002.
//   - Dos cadenas en el .env: KARVE_COPIA_CONNECTION_STRING (base de PRUEBAS, la que se usa en la Fase 3.5) y
//     KARVE_CONNECTION_STRING (producción, más adelante). Nunca se registran ni se devuelven al navegador.
//   - Este módulo solo ejecuta SELECT. Cualquier otra sentencia se rechaza antes de llegar a Karve.
//   - Sin `CharSet=UTF-8` el driver devuelve rotos los acentos; se añade si la cadena no lo trae.

const fs = require('fs');
const path = require('path');

const DRIVER_DIR = path.join(__dirname, 'driver-sql');
if (fs.existsSync(DRIVER_DIR) && !(process.env.PATH || '').split(';').includes(DRIVER_DIR)) {
  process.env.PATH = `${DRIVER_DIR};${process.env.PATH || ''}`;
}

let odbc = null;
let errorOdbc = null;
try { odbc = require('odbc'); } catch (e) { errorOdbc = e; }

const ENTORNOS = {
  copia: { variable: 'KARVE_COPIA_CONNECTION_STRING', nombre: 'base de pruebas de Karve' },
  produccion: { variable: 'KARVE_CONNECTION_STRING', nombre: 'Karve (producción)' },
};

function entornoDe(nombre = 'copia') {
  const e = ENTORNOS[nombre];
  if (!e) throw new Error(`Entorno de Karve desconocido: ${nombre}`);
  return e;
}

function hayConfiguracion(entorno = 'copia') {
  return Boolean((process.env[entornoDe(entorno).variable] || '').trim());
}

function cadenaConexion(entorno = 'copia') {
  const e = entornoDe(entorno);
  const cadena = (process.env[e.variable] || '').trim();
  if (!cadena) throw new Error(`Falta ${e.variable} en el .env`);
  return cadena + (/charset=/i.test(cadena) ? '' : ';CharSet=UTF-8;');
}

// Solo SELECT / WITH, una única sentencia (sin ';' seguido de más SQL).
function esSoloLectura(sql) {
  const s = String(sql || '').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  return /^(select|with)\b/i.test(s) && !/;\s*\S/.test(s);
}

async function conectar(entorno = 'copia') {
  if (!odbc) throw new Error(`Falta el paquete "odbc" (npm install odbc): ${errorOdbc && errorOdbc.message}`);
  return odbc.connect(cadenaConexion(entorno));
}

// Ejecuta un SELECT y devuelve las filas como objetos planos. Abre y cierra la conexión salvo que se pase una.
async function consultar(sql, params = [], { entorno = 'copia', conexion = null } = {}) {
  if (!esSoloLectura(sql)) throw new Error('karve.js solo ejecuta sentencias SELECT');
  const c = conexion || await conectar(entorno);
  try {
    const resultado = await c.query(sql, params);
    return { filas: Array.from(resultado, (f) => ({ ...f })), columnas: (resultado.columns || []).map((col) => col.name) };
  } finally {
    if (!conexion) await c.close();
  }
}

// Comprobación rápida: nombre de la base, hora del servidor, usuario y latencia. No devuelve nada sensible.
async function probar(entorno = 'copia') {
  const t0 = Date.now();
  const { filas } = await consultar('SELECT db_name() AS base, CURRENT TIMESTAMP AS ahora, CURRENT USER AS usuario, @@VERSION AS version', [], { entorno });
  return { ...filas[0], ms: Date.now() - t0 };
}

// Mensaje de error sin cadenas de conexión ni credenciales (los errores ODBC pueden incluir la cadena).
function describirError(e) {
  const partes = [];
  if (e && Array.isArray(e.odbcErrors)) for (const o of e.odbcErrors) partes.push(`[${o.state || '?'}] ${o.message || ''}`);
  else if (e && e.message) partes.push(e.message);
  let texto = partes.join(' | ') || String(e);
  for (const nombre of Object.values(ENTORNOS).map((x) => x.variable)) {
    const v = (process.env[nombre] || '').trim();
    if (v) texto = texto.split(v).join('<cadena de conexión>');
  }
  texto = texto.replace(/PWD=[^;]*/gi, 'PWD=***').replace(/UID=[^;]*/gi, 'UID=***');
  if (/IM002/.test(texto)) texto += ' → el driver "SQL Anywhere 17" (64 bits) no está registrado en el Administrador ODBC (ver docs/INSTALACION.md)';
  return texto;
}

module.exports = { ENTORNOS, hayConfiguracion, conectar, consultar, probar, describirError, esSoloLectura, DRIVER_DIR };
