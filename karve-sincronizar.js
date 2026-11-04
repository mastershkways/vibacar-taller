// karve-sincronizar.js — Sincronización de clientes, contactos y máquinas desde Karve (SOLO LECTURA en Karve,
// upsert en la base local). La llaman la API (botón "Sincronizar Karve") y scripts/karve-sincronizar.js (cron).
//
// Reglas (decisiones de Sendoa, 2026-11-04):
//   - Karve manda en los datos maestros que trae (nombre, NIF, teléfono, email, dirección, alta, baja, comercial,
//     última factura). Lo que Karve no tiene y se rellena a mano (contactos principales, zona, nº de contrato,
//     características, observaciones, estado reclasificado) NO se pisa si ya tiene valor.
//   - Regla de 3 años: `ultima_factura` = MAX(fecha) de kv_vFacturas; sin factura, cuenta la fecha de alta (`creado`).
//   - Comercial del cliente = CLIENTES2.VENDEDOR → usuario de la app con ese `karve_id` y rol comercial; si no hay, NULL.
//   - Contactos: todos a `cliente_contactos`; heurística por cargo/departamento para los 3 huecos de la ficha si están vacíos.
//   - Máquinas: cliente = el ACTUAL de Karve (si no hay, el propietario; si es propia y no hay ninguno, VIBACAR 0000000);
//     sin cliente resoluble se avisa y se omite. Nº de flota: Karve no lo tiene → F-YY-XXXX al crear. Bastidores
//     repetidos o vacíos: aviso, no bloqueo. Estado: propia → 'propia', resto → 'cliente_final' (administración reclasifica).
//   - Todo se escribe en una transacción; `simular: true` lo deshace al final (informe sin tocar nada).

const { db, ahora } = require('./db');
const karve = require('./karve');
const { siguienteNumeroFlota } = require('./numeracion');

const ZONAS = { 48: 'Bizkaia', '01': 'Araba', 20: 'Gipuzkoa', 28: 'Madrid' };
const ROLES_COMERCIALES = ['comercial', 'comercial_jefe'];
const KARVE_VIBACAR = '0000000';
const RE_COMPRAS = /compra/i;
const RE_TECNICO = /t[eé]cnic|mantenim|taller|seguridad|encargad|jefe de obra|produc/i;
const RE_FACTURAS = /factur|contab|administra|fras|envio/i;

const limpiar = (v) => { if (v === null || v === undefined) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; };
const fechaLocal = (v) => {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
const primerEmail = (v) => { const m = String(v || '').match(/[^\s;,<>"']+@[^\s;,<>"']+/); return m ? m[0].toLowerCase() : null; };
const cifNormalizado = (v) => { const s = limpiar(v); return s ? s.toUpperCase().replace(/[\s-]/g, '') : null; };
const zonaDe = (prov) => { const p = limpiar(prov); return p ? (ZONAS[p] || ZONAS[Number(p)] || 'otras') : null; };
const activoDe = (f) => (Number(f.inactivo) ? 0 : 1) && (f.fechaBaja ? 0 : 1);

let enCurso = false;
const estaEnCurso = () => enCurso;

class Simulacion extends Error {}

async function leerKarve(entorno) {
  const c = await karve.conectar(entorno);
  try {
    const q = async (sql) => (await karve.consultar(sql, [], { conexion: c })).filas;
    const [clientes, vendedores, facturas, contactos, maquinas] = await Promise.all([
      q('SELECT id, nif, nombre, nombreComercial, direccion, direccion2, cp, poblacion, provincia, nomProvincia, telefono, telefono2, movil, email, fechaAlta, fechaBaja, inactivo FROM CV.kv_vClientes'),
      q("SELECT NUMERO_CLI AS id, VENDEDOR AS vendedor FROM CV.CLIENTES2 WHERE VENDEDOR IS NOT NULL AND VENDEDOR <> ''"),
      q('SELECT cliente, MAX(fecha) AS ultima FROM CV.kv_vFacturas GROUP BY cliente'),
      q('SELECT numero, nombre, telefono, movil, email, nombreCargo, departamento, cliente, baja, inactivo FROM CV.kv_vClientesContactos'),
      q('SELECT id, bastidor, matricula, nomMarca, nomModelo, nomTipo, situacion, nomSituacion, cliente, clientePropie, propia, motor, descripcion, ubicacion, observaciones, fechaAlta, fechaBaja, inactivo FROM CV.kv_vMaquinas'),
    ]);
    return { clientes, vendedores, facturas, contactos, maquinas };
  } finally {
    await c.close();
  }
}

// Aplica los datos leídos a la base local. Síncrono (better-sqlite3), dentro de una transacción.
function aplicar(datos, resumen, avisar) {
  const comercialPorKarve = new Map(db.prepare(`SELECT karve_id, id FROM usuarios WHERE rol IN (${ROLES_COMERCIALES.map(() => '?').join(',')}) AND karve_id IS NOT NULL AND activo = 1`).all(...ROLES_COMERCIALES).map((u) => [limpiar(u.karve_id), u.id]));
  const vendedorDe = new Map(datos.vendedores.map((v) => [limpiar(v.id), limpiar(v.vendedor)]));
  const ultimaFactura = new Map(datos.facturas.map((f) => [limpiar(f.cliente), fechaLocal(f.ultima)]));
  const vendedoresSinUsuario = new Set();

  // --- Clientes ------------------------------------------------------------------------------------
  const selPorKarve = db.prepare('SELECT * FROM clientes WHERE karve_id = ?');
  const selPorCif = db.prepare('SELECT * FROM clientes WHERE cif = ? AND karve_id IS NULL');
  const insCliente = db.prepare(`INSERT INTO clientes (nombre, cif, telefono, email, direccion, zona, origen, karve_id, activo, creado, ultima_factura, comercial_id)
                                 VALUES (?, ?, ?, ?, ?, ?, 'karve', ?, ?, ?, ?, ?)`);
  const updCliente = db.prepare(`UPDATE clientes SET nombre = ?, cif = ?, telefono = ?, email = ?, direccion = ?, zona = ?, origen = 'karve', karve_id = ?, activo = ?, creado = ?, ultima_factura = ?, comercial_id = ?, actualizado = ? WHERE id = ?`);
  const clientePorKarve = new Map();
  for (const k of datos.clientes) {
    resumen.clientes.leidos++;
    const karveId = limpiar(k.id);
    if (!karveId) continue;
    const vendedor = vendedorDe.get(karveId);
    let comercialId = null;
    if (vendedor) {
      comercialId = comercialPorKarve.get(vendedor) ?? null;
      if (comercialId === null) vendedoresSinUsuario.add(vendedor);
    }
    const nuevo = {
      nombre: limpiar(k.nombre) || limpiar(k.nombreComercial) || `Cliente ${karveId}`,
      cif: cifNormalizado(k.nif),
      telefono: limpiar(k.telefono) || limpiar(k.movil) || limpiar(k.telefono2),
      email: primerEmail(k.email),
      direccion: [limpiar(k.direccion), limpiar(k.direccion2), [limpiar(k.cp), limpiar(k.poblacion)].filter(Boolean).join(' '), limpiar(k.nomProvincia)].filter(Boolean).join('\n') || null,
      zona: zonaDe(k.provincia),
      activo: activoDe(k),
      creado: fechaLocal(k.fechaAlta) ? `${fechaLocal(k.fechaAlta)} 00:00:00` : null,
      ultima_factura: ultimaFactura.get(karveId) || null,
      comercial_id: comercialId,
    };
    let local = selPorKarve.get(karveId) || (nuevo.cif ? selPorCif.get(nuevo.cif) : null);
    if (!local) {
      const info = insCliente.run(nuevo.nombre, nuevo.cif, nuevo.telefono, nuevo.email, nuevo.direccion, nuevo.zona, karveId, nuevo.activo, nuevo.creado || ahora(), nuevo.ultima_factura, nuevo.comercial_id);
      clientePorKarve.set(karveId, Number(info.lastInsertRowid));
      resumen.clientes.nuevos++;
      continue;
    }
    clientePorKarve.set(karveId, local.id);
    // Karve manda en lo que trae; lo que no trae se conserva. La zona manual no se pisa.
    const final = {
      nombre: nuevo.nombre,
      cif: nuevo.cif || local.cif,
      telefono: nuevo.telefono || local.telefono,
      email: nuevo.email || local.email,
      direccion: nuevo.direccion || local.direccion,
      zona: local.zona || nuevo.zona,
      activo: nuevo.activo,
      creado: nuevo.creado || local.creado,
      ultima_factura: nuevo.ultima_factura,
      comercial_id: nuevo.comercial_id,
    };
    const cambia = Object.keys(final).some((c) => (final[c] ?? null) !== (local[c] ?? null)) || local.karve_id !== karveId || local.origen !== 'karve';
    if (cambia) {
      updCliente.run(final.nombre, final.cif, final.telefono, final.email, final.direccion, final.zona, karveId, final.activo, final.creado, final.ultima_factura, final.comercial_id, ahora(), local.id);
      resumen.clientes.actualizados++;
    } else resumen.clientes.sin_cambios++;
  }
  resumen.clientes.bajas = datos.clientes.filter((k) => !activoDe(k)).length;
  resumen.comerciales.vendedores_sin_usuario = [...vendedoresSinUsuario].sort();
  if (vendedoresSinUsuario.size) avisar(`comerciales: ${vendedoresSinUsuario.size} código(s) de vendedor de Karve sin usuario comercial en la app (${[...vendedoresSinUsuario].slice(0, 6).join(', ')}${vendedoresSinUsuario.size > 6 ? '…' : ''}): esos clientes quedan sin comercial`);

  // --- Contactos -----------------------------------------------------------------------------------
  const selContacto = db.prepare('SELECT * FROM cliente_contactos WHERE karve_id = ?');
  const insContacto = db.prepare('INSERT INTO cliente_contactos (cliente_id, karve_id, nombre, telefono, email, cargo, departamento, activo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const updContacto = db.prepare('UPDATE cliente_contactos SET cliente_id = ?, nombre = ?, telefono = ?, email = ?, cargo = ?, departamento = ?, activo = ?, actualizado = ? WHERE id = ?');
  const contactosPorCliente = new Map();
  let contactosSinCliente = 0;
  for (const k of datos.contactos) {
    resumen.contactos.leidos++;
    const karveId = limpiar(k.numero);
    const clienteId = clientePorKarve.get(limpiar(k.cliente));
    if (!karveId || !clienteId) { contactosSinCliente++; continue; }
    const c = {
      cliente_id: clienteId,
      nombre: limpiar(k.nombre) || 'Sin nombre',
      telefono: limpiar(k.telefono) || limpiar(k.movil),
      email: primerEmail(k.email),
      cargo: limpiar(k.nombreCargo),
      departamento: limpiar(k.departamento),
      activo: (Number(k.baja) || Number(k.inactivo)) ? 0 : 1,
    };
    const local = selContacto.get(karveId);
    if (!local) { insContacto.run(c.cliente_id, karveId, c.nombre, c.telefono, c.email, c.cargo, c.departamento, c.activo); resumen.contactos.nuevos++; }
    else if (Object.keys(c).some((x) => (c[x] ?? null) !== (local[x] ?? null))) { updContacto.run(c.cliente_id, c.nombre, c.telefono, c.email, c.cargo, c.departamento, c.activo, ahora(), local.id); resumen.contactos.actualizados++; }
    else resumen.contactos.sin_cambios++;
    if (c.activo) (contactosPorCliente.get(clienteId) || contactosPorCliente.set(clienteId, []).get(clienteId)).push(c);
  }
  if (contactosSinCliente) avisar(`contactos: ${contactosSinCliente} sin cliente resoluble (omitidos)`);

  // Heurística para los 3 huecos de la ficha, solo donde están vacíos.
  const selHuecos = db.prepare('SELECT id, compras_nombre, tecnico_nombre, email_facturas FROM clientes WHERE id = ?');
  const updHuecos = db.prepare('UPDATE clientes SET compras_nombre = ?, compras_telefono = ?, tecnico_nombre = ?, tecnico_telefono = ?, tecnico_email = ?, email_facturas = ?, actualizado = ? WHERE id = ?');
  const texto = (c) => `${c.cargo || ''} ${c.departamento || ''}`;
  for (const [clienteId, lista] of contactosPorCliente) {
    const cl = selHuecos.get(clienteId);
    if (!cl) continue;
    const compras = cl.compras_nombre ? null : lista.find((c) => RE_COMPRAS.test(texto(c)));
    const tecnico = cl.tecnico_nombre ? null : lista.find((c) => RE_TECNICO.test(texto(c)));
    const facturas = cl.email_facturas ? null : lista.find((c) => c.email && RE_FACTURAS.test(texto(c)));
    if (!compras && !tecnico && !facturas) continue;
    const actual = db.prepare('SELECT compras_nombre, compras_telefono, tecnico_nombre, tecnico_telefono, tecnico_email, email_facturas FROM clientes WHERE id = ?').get(clienteId);
    updHuecos.run(
      compras ? compras.nombre : actual.compras_nombre, compras ? compras.telefono : actual.compras_telefono,
      tecnico ? tecnico.nombre : actual.tecnico_nombre, tecnico ? tecnico.telefono : actual.tecnico_telefono, tecnico ? tecnico.email : actual.tecnico_email,
      facturas ? facturas.email : actual.email_facturas, ahora(), clienteId);
    resumen.contactos.huecos_rellenados += [compras, tecnico, facturas].filter(Boolean).length;
  }

  // --- Máquinas ------------------------------------------------------------------------------------
  const selMaqKarve = db.prepare('SELECT * FROM maquinas WHERE karve_id = ?');
  const selMaqBastidor = db.prepare('SELECT * FROM maquinas WHERE bastidor = ? AND karve_id IS NULL');
  const insMaq = db.prepare(`INSERT INTO maquinas (cliente_id, marca, modelo, bastidor, num_flota, estado, caracteristicas, observaciones, karve_id, origen, activo, creado)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'karve', ?, ?)`);
  const updMaq = db.prepare(`UPDATE maquinas SET cliente_id = ?, marca = ?, modelo = ?, bastidor = ?, estado = ?, caracteristicas = ?, observaciones = ?, karve_id = ?, origen = 'karve', activo = ?, actualizado = ? WHERE id = ?`);
  const vibacarId = clientePorKarve.get(KARVE_VIBACAR) || null;
  const bastidores = new Map();
  for (const m of datos.maquinas) { const b = cifNormalizado(m.bastidor); if (b) bastidores.set(b, (bastidores.get(b) || 0) + 1); }
  const repetidos = [...bastidores.entries()].filter(([, n]) => n > 1);
  let sinBastidor = 0, sinCliente = 0;
  for (const k of datos.maquinas) {
    resumen.maquinas.leidos++;
    const karveId = limpiar(k.id);
    if (!karveId) continue;
    const propia = String(k.propia).trim() === '1';
    const clienteId = clientePorKarve.get(limpiar(k.cliente)) || clientePorKarve.get(limpiar(k.clientePropie)) || (propia ? vibacarId : null);
    if (!clienteId) { sinCliente++; continue; }
    const bastidor = cifNormalizado(k.bastidor);
    if (!bastidor) sinBastidor++;
    const nuevo = {
      cliente_id: clienteId,
      marca: limpiar(k.nomMarca),
      modelo: limpiar(k.nomModelo),
      bastidor,
      estado: propia ? 'propia' : 'cliente_final',
      caracteristicas: [limpiar(k.nomTipo), limpiar(k.motor) ? `Motor: ${limpiar(k.motor)}` : null, limpiar(k.descripcion)].filter(Boolean).join('\n') || null,
      observaciones: [limpiar(k.ubicacion) ? `Ubicación: ${limpiar(k.ubicacion)}` : null, limpiar(k.observaciones)].filter(Boolean).join('\n') || null,
      activo: activoDe(k),
      creado: fechaLocal(k.fechaAlta) ? `${fechaLocal(k.fechaAlta)} 00:00:00` : null,
    };
    let local = selMaqKarve.get(karveId) || (bastidor && !(bastidores.get(bastidor) > 1) ? selMaqBastidor.get(bastidor) : null);
    if (!local) {
      insMaq.run(nuevo.cliente_id, nuevo.marca, nuevo.modelo, nuevo.bastidor, siguienteNumeroFlota(), nuevo.estado, nuevo.caracteristicas, nuevo.observaciones, karveId, nuevo.activo, nuevo.creado || ahora());
      resumen.maquinas.nuevos++;
      continue;
    }
    // Estado solo si administración no lo ha reclasificado; características y observaciones solo si están vacías.
    const final = {
      cliente_id: nuevo.cliente_id,
      marca: nuevo.marca || local.marca,
      modelo: nuevo.modelo || local.modelo,
      bastidor: nuevo.bastidor || local.bastidor,
      estado: ['propia', 'cliente_final'].includes(local.estado) ? nuevo.estado : local.estado,
      caracteristicas: local.caracteristicas || nuevo.caracteristicas,
      observaciones: local.observaciones || nuevo.observaciones,
      activo: nuevo.activo,
    };
    const cambia = Object.keys(final).some((c) => (final[c] ?? null) !== (local[c] ?? null)) || local.karve_id !== karveId || local.origen !== 'karve';
    if (cambia) { updMaq.run(final.cliente_id, final.marca, final.modelo, final.bastidor, final.estado, final.caracteristicas, final.observaciones, karveId, final.activo, ahora(), local.id); resumen.maquinas.actualizados++; }
    else resumen.maquinas.sin_cambios++;
  }
  resumen.maquinas.sin_cliente = sinCliente;
  resumen.maquinas.sin_bastidor = sinBastidor;
  resumen.maquinas.bastidores_repetidos = repetidos.length;
  if (sinCliente) avisar(`máquinas: ${sinCliente} sin cliente actual ni propietario resoluble (omitidas)`);
  if (sinBastidor) avisar(`máquinas: ${sinBastidor} sin bastidor (importadas igualmente)`);
  if (repetidos.length) avisar(`máquinas: ${repetidos.length} bastidor(es) repetidos en Karve, ${repetidos.reduce((s, [, n]) => s + n, 0)} máquinas afectadas (${repetidos.slice(0, 5).map(([b]) => b).join(', ')}${repetidos.length > 5 ? '…' : ''}); se importan todas`);
}

// Punto de entrada. origen: 'manual' (botón) | 'cron' (script programado) | 'prueba'.
async function sincronizar({ entorno = 'copia', origen = 'manual', usuarioId = null, simular = false } = {}) {
  if (enCurso) { const e = new Error('Ya hay una sincronización en curso'); e.codigo = 'EN_CURSO'; throw e; }
  enCurso = true;
  const inicio = ahora();
  const t0 = Date.now();
  const resumen = {
    entorno, origen, simulado: simular, inicio, fin: null, duracion_ms: 0,
    clientes: { leidos: 0, nuevos: 0, actualizados: 0, sin_cambios: 0, bajas: 0 },
    contactos: { leidos: 0, nuevos: 0, actualizados: 0, sin_cambios: 0, huecos_rellenados: 0 },
    maquinas: { leidos: 0, nuevos: 0, actualizados: 0, sin_cambios: 0, sin_cliente: 0, sin_bastidor: 0, bastidores_repetidos: 0 },
    comerciales: { vendedores_sin_usuario: [] },
    avisos: [],
  };
  const avisar = (t) => resumen.avisos.push(t);
  try {
    const datos = await leerKarve(entorno);
    const tx = db.transaction(() => { aplicar(datos, resumen, avisar); if (simular) throw new Simulacion('simulación'); });
    try { tx(); } catch (e) { if (!(e instanceof Simulacion)) throw e; }
    resumen.fin = ahora();
    resumen.duracion_ms = Date.now() - t0;
    if (!simular) db.prepare('INSERT INTO sincronizaciones (inicio, fin, origen, usuario_id, estado, resumen) VALUES (?, ?, ?, ?, ?, ?)').run(inicio, resumen.fin, origen, usuarioId, 'ok', JSON.stringify(resumen));
    return resumen;
  } catch (e) {
    const mensaje = karve.describirError(e);
    if (!simular) db.prepare('INSERT INTO sincronizaciones (inicio, fin, origen, usuario_id, estado, resumen, mensaje) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inicio, ahora(), origen, usuarioId, 'error', JSON.stringify(resumen), mensaje);
    const err = new Error(mensaje);
    err.codigo = e.codigo || 'KARVE';
    throw err;
  } finally {
    enCurso = false;
  }
}

function ultimaSincronizacion() {
  const f = db.prepare('SELECT s.id, s.inicio, s.fin, s.origen, s.estado, s.mensaje, s.resumen, u.nombre AS usuario FROM sincronizaciones s LEFT JOIN usuarios u ON u.id = s.usuario_id ORDER BY s.id DESC LIMIT 1').get();
  if (!f) return null;
  let resumen = null; try { resumen = JSON.parse(f.resumen); } catch {}
  return { ...f, resumen };
}

module.exports = { sincronizar, ultimaSincronizacion, estaEnCurso, ZONAS, zonaDe };
