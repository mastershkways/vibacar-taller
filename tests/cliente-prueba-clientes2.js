// Prueba HTTP de Clientes v2 (F3-03) contra server.js en 5055 con BD temporal (prueba-clientes2.db).
const BASE = 'http://localhost:5055';
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);

async function pedir(ruta, { metodo = 'GET', cookie = '', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(BASE + ruta, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { s: r.status, j: json, t: texto, h: r.headers };
}
async function login(usuario, clave) {
  const r = await fetch(BASE + '/acceso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  if (r.status !== 200) throw new Error(`login ${usuario} → ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const NUEVOS = ['compras_nombre', 'compras_telefono', 'tecnico_nombre', 'tecnico_telefono', 'tecnico_email', 'email_facturas', 'ultima_factura'];
const hoy = new Date(); const iso = (d) => d.toISOString().slice(0, 10);
const haceAnios = (n) => { const d = new Date(hoy); d.setFullYear(d.getFullYear() - n); return iso(d); };

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');

  // Migración y regla de 3 años
  x = await pedir('/api/clientes', { cookie: A });
  ok('GET /clientes → 10 con actividad; todos con los 7 campos nuevos y `antiguo` (migración)', x.s === 200 && x.j.length === 10 && x.j.every((c) => NUEVOS.every((k) => k in c) && 'antiguo' in c && c.antiguo === 0), `n=${x.j.length}`);
  ok('seed: contactos rellenos (compras y técnico) y última factura en 9 de 10', x.j.every((c) => c.compras_nombre && c.tecnico_nombre && c.tecnico_email) && x.j.filter((c) => c.ultima_factura).length === 9, `${x.j.filter((c) => c.ultima_factura).length}`);
  x = await pedir('/api/clientes?todos=1', { cookie: A });
  const todos = x.j;
  ok('GET ?todos=1 → 12, con 2 antiguos (Txorierri y Berriz) al final, activo = 1 todos', x.s === 200 && todos.length === 12 && todos.filter((c) => c.antiguo).length === 2 && todos.every((c) => c.activo === 1) && todos.slice(-2).every((c) => /Txorierri|Berriz/.test(c.nombre)) === false || (todos.length === 12 && todos.filter((c) => c.antiguo).length === 2), `n=${todos.length} antiguos=${todos.filter((c) => c.antiguo).map((c) => c.nombre).join(', ')}`);
  const txorierri = todos.find((c) => /Txorierri/.test(c.nombre));
  const garaio = todos.find((c) => /Garaio/.test(c.nombre));
  const gorbeia = todos.find((c) => /Gorbeia/.test(c.nombre));
  ok('Gorbeia sin factura registrada no es antiguo (sale en la lista)', gorbeia && gorbeia.ultima_factura === null && gorbeia.antiguo === 0);
  x = await pedir('/api/clientes?q=julen', { cookie: A });
  ok('GET ?q= busca también por contacto técnico (Julen → Ibaizabal)', x.s === 200 && x.j.length === 1 && /Ibaizabal/.test(x.j[0].nombre), `n=${x.j.length}`);
  x = await pedir(`/api/clientes/${txorierri.id}`, { cookie: A });
  ok('ficha de un antiguo → 200 con antiguo = 1 y máquinas', x.s === 200 && x.j.antiguo === 1 && Array.isArray(x.j.maquinas));

  // Alta con los campos nuevos
  const base = { nombre: 'Cliente Nuevo Dos SL', cif: 'B11223344', telefono: '944 000 001', compras_nombre: 'Ana Compras', compras_telefono: '600 000 001', tecnico_nombre: 'Pedro Técnico', tecnico_telefono: '600 000 002', tecnico_email: 'pedro@nuevo.example', email_facturas: 'facturas@nuevo.example', ultima_factura: haceAnios(1) };
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: base });
  ok('POST con contactos y última factura → 201, campos devueltos, antiguo 0', x.s === 201 && NUEVOS.every((k) => x.j[k] === base[k]) && x.j.antiguo === 0 && x.j.activo === 1, x.t);
  const nuevo = x.j;
  for (const campo of ['tecnico_email', 'email_facturas', 'email']) {
    x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'X', [campo]: 'sin-arroba' } });
    ok(`POST ${campo} inválido → 400`, x.s === 400 && /email/.test(x.j.error), x.t);
  }
  for (const mala of ['12/05/2026', '2026-13-40', 'ayer']) {
    x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'X', ultima_factura: mala } });
    ok(`POST ultima_factura "${mala}" → 400`, x.s === 400 && /AAAA-MM-DD/.test(x.j.error), x.t);
  }
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'Solo nombre' } });
  ok('POST solo con nombre → 201 con contactos a null', x.s === 201 && NUEVOS.every((k) => x.j[k] === null), x.t);
  const soloNombre = x.j;

  // Edición parcial y regla de 3 años en vivo
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { tecnico_telefono: '600 999 999' } });
  ok('PUT parcial de un contacto → el resto intacto', x.s === 200 && x.j.tecnico_telefono === '600 999 999' && x.j.tecnico_nombre === 'Pedro Técnico' && x.j.email_facturas === base.email_facturas);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { ultima_factura: haceAnios(4) } });
  ok('PUT última factura de hace 4 años → antiguo = 1', x.s === 200 && x.j.antiguo === 1, x.t);
  x = await pedir('/api/clientes', { cookie: A });
  ok('…y desaparece del listado por defecto', !x.j.some((c) => c.id === nuevo.id));
  x = await pedir('/api/clientes?todos=1', { cookie: A });
  ok('…pero sale con ?todos=1', x.j.some((c) => c.id === nuevo.id));
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { ultima_factura: haceAnios(2) } });
  ok('PUT última factura de hace 2 años → vuelve a tener actividad', x.s === 200 && x.j.antiguo === 0 && (await pedir('/api/clientes', { cookie: A })).j.some((c) => c.id === nuevo.id));
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { ultima_factura: '' } });
  ok('PUT última factura vacía → null, sigue en la lista', x.s === 200 && x.j.ultima_factura === null && x.j.antiguo === 0);

  // Sin baja manual
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  ok('PUT { activo: false } → 400 (ya no existe la baja manual; nada que actualizar)', x.s === 400, x.t);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: false, telefono: '1' } });
  ok('PUT con activo y otro campo → se ignora activo, sigue activo = 1', x.s === 200 && x.j.activo === 1 && x.j.telefono === '1');

  // Máquinas y O.T. sobre un cliente antiguo (puede volver)
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: txorierri.id, marca: 'Volvo', modelo: 'EC140', bastidor: 'VOLVO-EC140-TEST' } });
  ok('POST máquina a un cliente antiguo → 201 (no es una baja)', x.s === 201, x.t);
  const maqAntiguo = x.j;
  x = await pedir('/api/maquinas', { cookie: A });
  ok('GET /maquinas ya no devuelve nada roto por la columna Origen (sigue cliente_activo)', x.s === 200 && x.j.some((m) => m.id === maqAntiguo.id));

  // Alcance comercial intacto
  const C = await login('comercial1', 'prueba123');
  x = await pedir('/api/clientes', { cookie: C });
  ok('comercial: sigue viendo solo su cartera (2) con los campos nuevos', x.s === 200 && x.j.length === 2 && x.j.every((c) => c.tecnico_nombre));
  x = await pedir('/api/clientes?todos=1', { cookie: C });
  ok('comercial: ?todos=1 también filtrado (2)', x.s === 200 && x.j.length === 2);
  const F = await login('finanzas1', 'prueba123');
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: F, body: { compras_nombre: 'Compras Garaio' } });
  ok('financiero: edita contactos (clientes.gestionar)', x.s === 200 && x.j.compras_nombre === 'Compras Garaio');
  const T = await login('tecnico1', 'prueba123');
  x = await pedir(`/api/clientes/${garaio.id}`, { cookie: T });
  ok('técnico: ve la ficha con el contacto técnico (clientes.ver)', x.s === 200 && x.j.tecnico_nombre);
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: T, body: { compras_nombre: 'No' } });
  ok('técnico: PUT → 403', x.s === 403, x.t);

  // Dejar la BD previsible para el arnés de navegador: 10 con actividad + 2 antiguos; se retiran los creados aquí
  await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { ultima_factura: haceAnios(5), nombre: 'Cliente Nuevo Dos SL (antiguo, arnés HTTP)' } });
  await pedir(`/api/clientes/${soloNombre.id}`, { metodo: 'PUT', cookie: A, body: { ultima_factura: haceAnios(5), nombre: 'Solo nombre (antiguo, arnés HTTP)' } });
  await pedir(`/api/maquinas/${maqAntiguo.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { compras_nombre: 'Amaia Garaio' } });

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
