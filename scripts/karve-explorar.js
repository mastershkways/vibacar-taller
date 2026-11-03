// scripts/karve-explorar.js — Investigación de SOLO LECTURA de la estructura de Karve (SQL Anywhere 17).
//
//   node scripts/karve-explorar.js                      → catálogo completo + candidatas (clientes, máquinas, comerciales, facturas…)
//   node scripts/karve-explorar.js --buscar texto       → tablas, vistas y columnas cuyo nombre contiene el texto
//   node scripts/karve-explorar.js --tabla CV.CLIEN1    → columnas y muestra (5 filas) de una tabla o vista concreta
//   node scripts/karve-explorar.js --salida ruta.md     → además guarda el informe en un archivo (por defecto contexto/KARVE-ESTRUCTURA-<fecha>.md)
//   node scripts/karve-explorar.js produccion           → contra producción en vez de la base de pruebas
//
// Solo consulta el catálogo (SYS.*) y hace SELECT TOP n de muestra. No modifica nada.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const karve = require('../karve');

const args = process.argv.slice(2);
const opcion = (nombre) => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : null; };
const entorno = args.find((a) => a === 'produccion' || a === 'copia') || 'copia';
const buscar = opcion('--buscar');
const tablaPedida = opcion('--tabla');
const salida = opcion('--salida') || (buscar || tablaPedida ? null : path.join(__dirname, '..', 'contexto', `KARVE-ESTRUCTURA-${new Date().toISOString().slice(0, 10)}.md`));
const MUESTRA = Number(opcion('--muestra') || (tablaPedida ? 5 : 3));

// Qué buscamos en la Fase 3.5, por patrones en el nombre de tabla/vista.
const CATEGORIAS = [
  { clave: 'clientes', titulo: 'Clientes', patron: /CLIEN/i },
  { clave: 'maquinas', titulo: 'Máquinas / equipos / flota', patron: /MAQ|EQUIP|FLOTA|VEHIC|SERIE|ACTIVO|INMOV/i },
  { clave: 'comerciales', titulo: 'Comerciales / vendedores / agentes', patron: /VENDE|COMERC|AGENTE|REPRES|DELEG/i },
  { clave: 'facturas', titulo: 'Facturas de venta', patron: /FACT|VENTA|CABFAC|FACTURA/i },
  { clave: 'operarios', titulo: 'Operarios / técnicos / empleados', patron: /OPERAR|EMPLE|TECNIC|TRABAJ|PERSONAL/i },
  { clave: 'ot', titulo: 'Órdenes de trabajo / partes / taller', patron: /^TL_|ORDEN|PARTE|TALLER|REPAR|AVERIA|SAT/i },
  { clave: 'contratos', titulo: 'Contratos / alquiler', patron: /CONTRAT|ALQUIL|RENT/i },
];

const lineas = [];
const out = (t = '') => { lineas.push(t); console.log(t); };
const corto = (v) => {
  if (v === null || v === undefined) return '∅';
  if (v instanceof Date) return v.toISOString().slice(0, 19).replace('T', ' ');
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 40 ? s.slice(0, 37) + '…' : s;
};

async function catalogo(c) {
  // SYSTABLE (vista de compatibilidad: table_type en texto) + SYSUSER: tablas base y vistas de los usuarios normales.
  const sql = `SELECT u.user_name AS propietario, t.table_name AS nombre, t.table_type AS tipo, t.count AS filas, t.table_id AS id
                 FROM SYS.SYSTABLE t JOIN SYS.SYSUSER u ON u.user_id = t.creator
                WHERE u.user_name NOT IN ('SYS', 'dbo', 'rs_systabgroup', 'SA_DEBUG', 'ml_server', 'diagnostics')
                  AND t.table_type IN ('BASE', 'VIEW')
                ORDER BY u.user_name, t.table_name`;
  // El driver devuelve los BIGINT como BigInt: se pasan a Number para ordenar y comparar.
  return (await karve.consultar(sql, [], { conexion: c })).filas.map((t) => ({ ...t, filas: t.filas == null ? null : Number(t.filas), id: Number(t.id) }));
}

async function columnas(c, tabla) {
  const sql = `SELECT c.column_name AS nombre, d.domain_name AS tipo, c.width AS ancho, c.scale AS escala, c.nulls AS nulos, c.pkey AS pk, c."default" AS defecto
                 FROM SYS.SYSCOLUMN c JOIN SYS.SYSDOMAIN d ON d.domain_id = c.domain_id
                WHERE c.table_id = ? ORDER BY c.column_id`; // SYSCOLUMN (compatibilidad) trae pkey; SYSTABCOL no
  return (await karve.consultar(sql, [tabla.id], { conexion: c })).filas;
}

async function muestra(c, tabla, n) {
  try {
    return await karve.consultar(`SELECT TOP ${n} * FROM "${tabla.propietario}"."${tabla.nombre}"`, [], { conexion: c });
  } catch (e) {
    return { error: karve.describirError(e), filas: [], columnas: [] };
  }
}

function tipoCol(col) {
  const t = String(col.tipo).toLowerCase();
  if (/char|varchar|binary/.test(t)) return `${t}(${col.ancho})`;
  if (/numeric|decimal/.test(t)) return `${t}(${col.ancho},${col.escala})`;
  return t;
}

async function describir(c, tabla, n) {
  out(`### ${tabla.propietario}.${tabla.nombre} (${tabla.tipo === 'VIEW' ? 'vista' : 'tabla'}, ~${tabla.filas ?? '?'} filas)`);
  const cols = await columnas(c, tabla);
  out('| Columna | Tipo | Nulos | PK |');
  out('|---|---|---|---|');
  for (const col of cols) out(`| ${col.nombre} | ${tipoCol(col)} | ${col.nulos === 'Y' ? 'sí' : 'no'} | ${col.pk === 'Y' ? '🔑' : ''} |`);
  const m = await muestra(c, tabla, n);
  if (m.error) { out(`Muestra: no se ha podido leer (${m.error})`); out(); return; }
  if (!m.filas.length) { out('Muestra: sin filas'); out(); return; }
  out(`Muestra (${m.filas.length} filas, columnas con algún valor):`);
  const conDatos = m.columnas.filter((k) => m.filas.some((f) => f[k] !== null && f[k] !== undefined && String(f[k]).trim() !== ''));
  for (const f of m.filas) out('- ' + conDatos.map((k) => `${k}=${corto(f[k])}`).join(' · '));
  out();
}

(async () => {
  if (!karve.hayConfiguracion(entorno)) { console.error(`Falta ${karve.ENTORNOS[entorno].variable} en el .env`); process.exit(2); }
  let c;
  try { c = await karve.conectar(entorno); } catch (e) { console.error(`❌ No se ha podido conectar: ${karve.describirError(e)}`); process.exit(1); }
  try {
    const info = await karve.probar(entorno);
    out(`# Estructura de Karve — ${karve.ENTORNOS[entorno].nombre} (${info.base}), ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
    out(`Solo lectura. Generado por scripts/karve-explorar.js. Las muestras son datos reales de la base de pruebas: este archivo no se versiona.`);
    out();
    const todas = await catalogo(c);

    if (tablaPedida) {
      const [prop, nom] = tablaPedida.includes('.') ? tablaPedida.split('.') : ['CV', tablaPedida];
      const t = todas.find((x) => x.propietario.toLowerCase() === prop.toLowerCase() && x.nombre.toLowerCase() === nom.toLowerCase());
      if (!t) { out(`No existe ${tablaPedida}. Prueba con --buscar ${nom}`); }
      else await describir(c, t, MUESTRA);
    } else if (buscar) {
      const re = new RegExp(buscar, 'i');
      out(`## Tablas y vistas cuyo nombre contiene "${buscar}"`);
      for (const t of todas.filter((x) => re.test(x.nombre))) out(`- ${t.propietario}.${t.nombre} (${t.tipo}, ~${t.filas ?? '?'} filas)`);
      out();
      out(`## Columnas cuyo nombre contiene "${buscar}"`);
      const sql = `SELECT u.user_name AS propietario, t.table_name AS tabla, c.column_name AS columna
                     FROM SYS.SYSTABCOL c JOIN SYS.SYSTABLE t ON t.table_id = c.table_id JOIN SYS.SYSUSER u ON u.user_id = t.creator
                    WHERE u.user_name NOT IN ('SYS', 'dbo', 'rs_systabgroup', 'SA_DEBUG') AND c.column_name LIKE ?
                    ORDER BY u.user_name, t.table_name, c.column_id`;
      for (const f of (await karve.consultar(sql, [`%${buscar}%`], { conexion: c })).filas) out(`- ${f.propietario}.${f.tabla}.${f.columna}`);
    } else {
      const porProp = {};
      for (const t of todas) (porProp[t.propietario] = porProp[t.propietario] || []).push(t);
      out('## Catálogo');
      for (const [prop, ts] of Object.entries(porProp)) out(`- **${prop}**: ${ts.filter((t) => t.tipo === 'BASE').length} tablas, ${ts.filter((t) => t.tipo === 'VIEW').length} vistas`);
      out();
      for (const cat of CATEGORIAS) {
        const cands = todas.filter((t) => cat.patron.test(t.nombre));
        out(`## ${cat.titulo} — ${cands.length} candidatas`);
        for (const t of cands) out(`- ${t.propietario}.${t.nombre} (${t.tipo === 'VIEW' ? 'vista' : 'tabla'}, ~${t.filas ?? '?'} filas)`);
        out();
        // Detalle de las más pobladas de cada categoría (tablas base primero), para no volcar cientos de objetos.
        const detalle = cands.filter((t) => (t.filas || 0) > 0).sort((a, b) => (a.tipo === b.tipo ? (b.filas || 0) - (a.filas || 0) : a.tipo === 'BASE' ? -1 : 1)).slice(0, 6);
        for (const t of detalle) await describir(c, t, MUESTRA);
      }
      out('## Todas las tablas y vistas (nombre, tipo, ~filas)');
      for (const t of todas) out(`- ${t.propietario}.${t.nombre} · ${t.tipo} · ${t.filas ?? '?'}`);
    }
  } catch (e) {
    console.error(`❌ Error durante la exploración: ${karve.describirError(e)}`);
    process.exitCode = 1;
  } finally {
    await c.close();
  }
  if (salida) {
    fs.mkdirSync(path.dirname(salida), { recursive: true });
    fs.writeFileSync(salida, lineas.join('\n') + '\n', 'utf8');
    console.log(`\nInforme guardado en ${salida}`);
  }
})();
