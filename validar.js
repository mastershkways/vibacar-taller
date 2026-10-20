// validar.js — Validación de entrada de la API y error HTTP.
//
// Las rutas lanzan `new ErrorHttp(400, 'mensaje')` y el manejador de errores de server.js
// lo convierte en la respuesta JSON. Los validadores devuelven el valor limpio o lanzan 400.

class ErrorHttp extends Error {
  constructor(status, mensaje, extra = {}) {
    super(mensaje);
    this.status = status;
    this.extra = extra;
  }
}

function falta(nombre) {
  return new ErrorHttp(400, `Falta el campo "${nombre}"`);
}

// Texto recortado. null si viene vacío y no es obligatorio.
function texto(valor, { nombre, obligatorio = false, max = 500 } = {}) {
  if (valor === undefined || valor === null) {
    if (obligatorio) throw falta(nombre);
    return null;
  }
  const t = String(valor).trim();
  if (!t) {
    if (obligatorio) throw falta(nombre);
    return null;
  }
  if (t.length > max) throw new ErrorHttp(400, `"${nombre}" supera los ${max} caracteres`);
  return t;
}

// Entero. null si no viene y no es obligatorio.
function entero(valor, { nombre, obligatorio = false, min = null, max = null } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obligatorio) throw falta(nombre);
    return null;
  }
  const n = Number(valor);
  if (!Number.isInteger(n)) throw new ErrorHttp(400, `"${nombre}" debe ser un número entero`);
  if (min !== null && n < min) throw new ErrorHttp(400, `"${nombre}" debe ser ≥ ${min}`);
  if (max !== null && n > max) throw new ErrorHttp(400, `"${nombre}" debe ser ≤ ${max}`);
  return n;
}

// Booleano → 0/1 para SQLite. undefined si no viene (para no tocar la columna en un PUT parcial).
function booleano(valor) {
  if (valor === undefined || valor === null) return undefined;
  if (valor === true || valor === 1 || valor === '1' || valor === 'true' || valor === 'si' || valor === 'sí') return 1;
  if (valor === false || valor === 0 || valor === '0' || valor === 'false' || valor === 'no') return 0;
  throw new ErrorHttp(400, 'Valor booleano no válido');
}

// Uno de una lista de valores. Devuelve `defecto` si no viene.
function enumerado(valor, { nombre, valores, defecto = null }) {
  if (valor === undefined || valor === null || valor === '') return defecto;
  const v = String(valor).trim();
  if (!valores.includes(v)) throw new ErrorHttp(400, `"${nombre}" debe ser uno de: ${valores.join(', ')}`);
  return v;
}

// Id de ruta (/api/x/:id).
function idRuta(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) throw new ErrorHttp(400, 'Identificador no válido');
  return n;
}

module.exports = { ErrorHttp, texto, entero, booleano, enumerado, idRuta };
