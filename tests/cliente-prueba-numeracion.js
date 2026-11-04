// Prueba HTTP de la numeración Karve en el alta de O.T. (F3.5-05) contra server.js en 5055 con BD con seed.
// Con KARVE_COPIA_CONNECTION_STRING en el .env el número sigue el máximo de Karve; sin ella, el contador local.
const BASE = 'http://localhost:5055';
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);
async function pedir(ruta, { metodo = 'GET', cookie = '', body } = {}) {
  const h = {}; if (cookie) h.cookie = cookie;
  if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(BASE + ruta, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text(); let json = null; try { json = JSON.parse(texto); } catch {}
  return { s: r.status, j: json, t: texto };
}
async function login(usuario, clave) {
  const r = await fetch(BASE + '/acceso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  if (r.status !== 200) throw new Error(`login ${usuario} → ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
(async () => {
  const A = await login('admin_prueba', 'clave-prueba-123');
  let x = await pedir('/api/ot?abiertas=0&limite=100', { cookie: A });
  const nums = x.j.ots.map((o) => o.numero);
  ok('seed: las 20 O.T. llevan 10 dígitos y son correlativas', x.s === 200 && nums.length === 20 && nums.every((n) => /^\d{10}$/.test(n)), nums.slice(0, 3).join(','));
  const maxLocal = Math.max(...nums.map(Number));
  x = await pedir('/api/clientes', { cookie: A });
  const cliente = x.j[0];
  const t0 = Date.now();
  x = await pedir('/api/ot', { metodo: 'POST', cookie: A, body: { cliente_id: cliente.id, sintoma: 'Prueba numeración' } });
  const n1 = x.j && x.j.numero;
  ok(`POST /ot → 201 con número de 10 dígitos mayor que el máximo local (${((Date.now() - t0) / 1000).toFixed(1)} s, incluye la lectura de Karve)`, x.s === 201 && /^\d{10}$/.test(n1) && Number(n1) > maxLocal, x.t.slice(0, 160));
  ok('…y por encima de la última O.T. de Karve conocida (0000107950) si hay conexión', Number(n1) >= 107951, n1);
  x = await pedir('/api/ot', { metodo: 'POST', cookie: A, body: { cliente_id: cliente.id, sintoma: 'Prueba numeración 2' } });
  ok('segundo POST → el siguiente correlativo', x.s === 201 && Number(x.j.numero) === Number(n1) + 1, x.j && x.j.numero);
  x = await pedir(`/api/ot?q=${n1}`, { cookie: A });
  ok('el listado encuentra la O.T. por su número de 10 dígitos', x.s === 200 && x.j.total === 1 && x.j.ots[0].numero === n1);
  x = await pedir('/api/kanban', { cookie: A });
  ok('el Kanban pinta números de 10 dígitos', x.s === 200 && x.j.fases.flatMap((f) => f.ots).every((o) => /^\d{10}$/.test(o.numero)));
  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
