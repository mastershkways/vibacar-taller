// Prueba HTTP del maestro de clientes (F2-02) contra server.js en 5055 con BD temporal.
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

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');

  // Migración: columnas nuevas presentes en los clientes existentes
  x = await pedir('/api/clientes', { cookie: A });
  ok('GET /api/clientes → lista con origen=manual y direccion (migración)', x.s === 200 && x.j.length >= 3 && x.j.every((c) => c.origen === 'manual' && 'direccion' in c), `n=${x.j && x.j.length}`);
  const existente = x.j[0];

  // Validación
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { cif: 'A1' } });
  ok('POST sin nombre → 400', x.s === 400, x.t);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'Mal Email SL', email: 'no-es-un-email' } });
  ok('POST email inválido → 400', x.s === 400 && /email/i.test(x.j.error), x.t);

  // Alta
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'Grúas Norte SL', cif: ' b-98765432 ', email: 'admin@gruasnorte.es', telefono: '944 000 111', direccion: 'Polígono Erletxe, 4\n48960 Galdakao', exige_pedido: true } });
  ok('POST alta → 201, origen manual, activo 1, CIF normalizado', x.s === 201 && x.j.origen === 'manual' && x.j.activo === 1 && x.j.cif === 'B98765432' && x.j.direccion.includes('Galdakao') && x.j.exige_pedido === 1, x.t);
  const nuevo = x.j;
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'Otro con el mismo CIF', cif: 'B98765432' } });
  ok('POST CIF repetido → 409 con cliente_id', x.s === 409 && x.j.cliente_id === nuevo.id, x.t);

  // Edición parcial
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { telefono: '944 222 333', direccion: null } });
  ok('PUT parcial → teléfono cambiado, dirección borrada, resto intacto', x.s === 200 && x.j.telefono === '944 222 333' && x.j.direccion === null && x.j.email === 'admin@gruasnorte.es' && x.j.actualizado, x.t);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { cif: existente.cif || 'B12345678' } });
  ok('PUT con el CIF de otro cliente → 409', x.s === 409, x.t);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { cif: 'B98765432' } });
  ok('PUT con su propio CIF → 200', x.s === 200, x.t);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { origen: 'karve', karve_id: 'K-1' } });
  ok('PUT origen no es editable (sigue manual), karve_id sí (hasta la Fase 5)', x.s === 200 && x.j.origen === 'manual' && x.j.karve_id === 'K-1', x.t);
  x = await pedir('/api/clientes/999999', { metodo: 'PUT', cookie: A, body: { nombre: 'X' } });
  ok('PUT id inexistente → 404', x.s === 404, x.t);

  // Búsqueda
  x = await pedir('/api/clientes?q=gruasnorte', { cookie: A });
  ok('GET ?q= busca por email', x.s === 200 && x.j.length === 1 && x.j[0].id === nuevo.id, `n=${x.j && x.j.length}`);
  x = await pedir('/api/clientes?q=222%20333', { cookie: A });
  ok('GET ?q= busca por teléfono', x.s === 200 && x.j.length === 1, `n=${x.j && x.j.length}`);
  x = await pedir('/api/clientes?q=K-1', { cookie: A });
  ok('GET ?q= busca por código Karve', x.s === 200 && x.j.length === 1, `n=${x.j && x.j.length}`);

  // Baja lógica
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  ok('PUT activo=false → desactivado', x.s === 200 && x.j.activo === 0, x.t);
  x = await pedir('/api/clientes', { cookie: A });
  ok('GET por defecto no lista al desactivado', x.s === 200 && !x.j.some((c) => c.id === nuevo.id));
  x = await pedir('/api/clientes?todos=1', { cookie: A });
  ok('GET ?todos=1 sí lo lista, al final (activos primero)', x.s === 200 && x.j.some((c) => c.id === nuevo.id) && x.j[x.j.length - 1].id === nuevo.id);
  x = await pedir(`/api/clientes/${nuevo.id}`, { cookie: A });
  ok('GET /clientes/:id del desactivado sigue accesible (nunca se borra)', x.s === 200 && x.j.activo === 0 && Array.isArray(x.j.maquinas));
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: nuevo.id, marca: 'Liebherr', modelo: 'LTM' } });
  ok('POST máquina a cliente desactivado → rechazado', x.s === 400 || x.s === 409 || x.s === 404, `${x.s} ${x.t}`);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: true } });
  ok('PUT activo=true → reactivado', x.s === 200 && x.j.activo === 1, x.t);

  // Permisos
  const T = await login('tec1', 'tecnico123');
  x = await pedir('/api/clientes', { cookie: T });
  ok('técnico: GET clientes → 200 (clientes.ver)', x.s === 200);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: T, body: { nombre: 'No debería' } });
  ok('técnico: POST clientes → 403', x.s === 403, x.t);
  x = await pedir(`/api/clientes/${nuevo.id}`, { metodo: 'PUT', cookie: T, body: { activo: false } });
  ok('técnico: PUT clientes → 403', x.s === 403, x.t);

  // Usuario comercial para la prueba de navegador (solo lectura del maestro)
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { usuario: 'com1', nombre: 'Comercial Uno', clave: 'comercial123', rol: 'comercial' } });
  ok('alta usuario comercial de prueba (o ya existía)', x.s === 201 || x.s === 409, x.t);
  const C = await login('com1', 'comercial123');
  x = await pedir('/api/clientes', { cookie: C });
  ok('comercial: GET clientes → 200', x.s === 200);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: C, body: { nombre: 'No debería' } });
  ok('comercial: POST clientes → 403', x.s === 403, x.t);

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
