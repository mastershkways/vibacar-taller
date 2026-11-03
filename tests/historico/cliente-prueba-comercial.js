// Prueba HTTP de la relación vendedor ↔ cliente (F2-05) contra server.js en 5055 con BD temporal (prueba-comercial.db).
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
  const C = await login('comercial1', 'prueba123');
  x = await pedir('/api/sesion', { cookie: C });
  const comercialId = x.j.usuario.id;
  ok('comercial1: alcance clientes_propios', x.j.alcance === 'clientes_propios');

  // --- Admin: migración, cartera del seed y lista de comerciales ---------------------------------------
  x = await pedir('/api/clientes?todos=1', { cookie: A });
  const todos = x.j;
  ok('admin: GET /clientes → 12 con comercial_id y comercial_nombre (migración + join)', x.s === 200 && todos.length === 12 && todos.every((c) => 'comercial_id' in c && 'comercial_nombre' in c), `n=${todos.length}`);
  const ibaizabal = todos.find((c) => /Ibaizabal/.test(c.nombre));
  const lezama = todos.find((c) => c.nombre === 'Grúas Lezama');
  const garaio = todos.find((c) => /Garaio/.test(c.nombre));
  const txorierri = todos.find((c) => /Txorierri/.test(c.nombre));
  ok('seed: Ibaizabal y Lezama en la cartera de comercial1 (Iker Goikoetxea), el resto sin comercial',
    ibaizabal.comercial_id === comercialId && lezama.comercial_id === comercialId && ibaizabal.comercial_nombre === 'Iker Goikoetxea' && todos.filter((c) => c.comercial_id).length === 2);
  x = await pedir('/api/comerciales', { cookie: A });
  ok('GET /comerciales → usuarios activos con rol comercial o jefe comercial (2: Iker y Nerea)', x.s === 200 && x.j.length === 2 && x.j.some((c) => c.id === comercialId && c.nombre === 'Iker Goikoetxea') && x.j.some((c) => c.nombre === 'Nerea Olabarria'), x.t);
  x = await pedir(`/api/clientes/${ibaizabal.id}`, { cookie: A });
  ok('admin: ficha de cliente con comercial_nombre y máquinas', x.s === 200 && x.j.comercial_nombre === 'Iker Goikoetxea' && Array.isArray(x.j.maquinas));

  // --- Comercial: solo su cartera ----------------------------------------------------------------------
  x = await pedir('/api/clientes', { cookie: C });
  ok('comercial: GET /clientes → 2 (su cartera)', x.s === 200 && x.j.length === 2 && x.j.every((c) => c.comercial_id === comercialId), `n=${x.j.length}`);
  x = await pedir('/api/clientes?todos=1&q=a', { cookie: C });
  ok('comercial: ?todos=1&q= sigue filtrado por cartera', x.s === 200 && x.j.every((c) => c.comercial_id === comercialId) && x.j.length <= 2, `n=${x.j.length}`);
  x = await pedir(`/api/clientes/${lezama.id}`, { cookie: C });
  ok('comercial: ficha de un cliente suyo → 200 con sus máquinas', x.s === 200 && x.j.id === lezama.id && x.j.maquinas.length === 2);
  x = await pedir(`/api/clientes/${garaio.id}`, { cookie: C });
  ok('comercial: ficha de un cliente ajeno → 404', x.s === 404, x.t);
  x = await pedir('/api/maquinas', { cookie: C });
  ok('comercial: GET /maquinas → 5 (3 Ibaizabal + 2 Lezama), todas de su cartera', x.s === 200 && x.j.length === 5 && x.j.every((m) => [ibaizabal.id, lezama.id].includes(m.cliente_id)), `n=${x.j.length}`);
  x = await pedir(`/api/maquinas?cliente_id=${garaio.id}`, { cookie: C });
  ok('comercial: GET /maquinas?cliente_id= ajeno → vacío', x.s === 200 && x.j.length === 0, `n=${x.j.length}`);
  x = await pedir(`/api/maquinas?cliente_id=${garaio.id}`, { cookie: A });
  const maqGaraio = x.j[0];
  x = await pedir(`/api/maquinas/${maqGaraio.id}`, { cookie: C });
  ok('comercial: GET /maquinas/:id de un cliente ajeno → 404', x.s === 404, x.t);
  x = await pedir(`/api/maquinas?cliente_id=${lezama.id}`, { cookie: A });
  x = await pedir(`/api/maquinas/${x.j[0].id}`, { cookie: C });
  ok('comercial: GET /maquinas/:id de su cartera → 200', x.s === 200);
  x = await pedir('/api/ot?abiertas=0&limite=100', { cookie: C });
  ok('comercial: GET /ot (todas) → 5, solo de su cartera', x.s === 200 && x.j.total === 5 && x.j.ots.every((o) => [ibaizabal.id, lezama.id].includes(o.cliente_id)), `total=${x.j.total}`);
  x = await pedir('/api/ot', { cookie: C });
  ok('comercial: GET /ot (abiertas) → 4', x.s === 200 && x.j.total === 4, `total=${x.j.total}`);
  x = await pedir(`/api/ot?cliente_id=${garaio.id}&abiertas=0`, { cookie: C });
  ok('comercial: GET /ot?cliente_id= ajeno → 0 aunque lo pida', x.s === 200 && x.j.total === 0, `total=${x.j.total}`);
  x = await pedir(`/api/ot?cliente_id=${garaio.id}&abiertas=0`, { cookie: A });
  const otAjena = x.j.ots[0];
  x = await pedir(`/api/ot/${otAjena.id}`, { cookie: C });
  ok('comercial: GET /ot/:id de un cliente ajeno → 404', x.s === 404, x.t);
  x = await pedir(`/api/ot?cliente_id=${lezama.id}&abiertas=0`, { cookie: A });
  x = await pedir(`/api/ot/${x.j.ots[0].id}`, { cookie: C });
  ok('comercial: GET /ot/:id de su cartera → 200', x.s === 200);
  x = await pedir('/api/kanban', { cookie: C });
  const kanbanC = x.j;
  const tarjetasC = kanbanC.fases.flatMap((f) => f.ots);
  ok('comercial: GET /kanban → 4 tarjetas, todas de su cartera', x.s === 200 && kanbanC.total === 4 && tarjetasC.length === 4 && tarjetasC.every((o) => [ibaizabal.id, lezama.id].includes(o.cliente_id)), `total=${kanbanC.total}`);
  const etagC = x.h.get('etag');
  x = await pedir('/api/kanban', { cookie: C, headers: { 'if-none-match': etagC } });
  ok('comercial: Kanban con If-None-Match → 304', x.s === 304);
  x = await pedir('/api/kanban', { cookie: A });
  ok('admin: Kanban completo (> 4) y ETag distinto al del comercial', x.s === 200 && x.j.total > 4 && x.h.get('etag') !== etagC, `total=${x.j.total}`);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: C, body: { nombre: 'No debería' } });
  ok('comercial: POST /clientes → 403 (sin clientes.gestionar)', x.s === 403, x.t);
  x = await pedir(`/api/clientes/${lezama.id}`, { metodo: 'PUT', cookie: C, body: { comercial_id: null } });
  ok('comercial: PUT /clientes → 403', x.s === 403, x.t);
  x = await pedir('/api/comerciales', { cookie: C });
  ok('comercial: GET /comerciales → 403', x.s === 403, x.t);

  // --- Admin: asignar y validar comercial_id -------------------------------------------------------------
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: comercialId } });
  ok('admin: PUT comercial_id válido → 200 con comercial_nombre', x.s === 200 && x.j.comercial_id === comercialId && x.j.comercial_nombre === 'Iker Goikoetxea', x.t);
  x = await pedir('/api/clientes', { cookie: C });
  ok('comercial: tras la asignación ve 3 clientes', x.s === 200 && x.j.length === 3, `n=${x.j.length}`);
  x = await pedir('/api/ot', { cookie: C });
  ok('comercial: y sus O.T. abiertas suben (Garaio tiene 2 abiertas) → 6', x.s === 200 && x.j.total === 6, `total=${x.j.total}`);
  x = await pedir('/api/kanban', { cookie: C });
  ok('comercial: el Kanban cambia de ETag y pasa a 6', x.s === 200 && x.j.total === 6 && x.h.get('etag') !== etagC, `total=${x.j.total}`);
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { nombre: 'Excavaciones Garaio SL' } });
  ok('admin: PUT sin comercial_id no lo toca', x.s === 200 && x.j.comercial_id === comercialId);
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: '' } });
  ok('admin: PUT comercial_id vacío → queda sin comercial', x.s === 200 && x.j.comercial_id === null && x.j.comercial_nombre === null, x.t);
  x = await pedir('/api/clientes', { cookie: C });
  ok('comercial: vuelve a ver 2', x.s === 200 && x.j.length === 2, `n=${x.j.length}`);
  x = await pedir('/api/usuarios?q=tecnico1', { cookie: A });
  const tecnico1 = x.j.usuarios[0];
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: tecnico1.id } });
  ok('admin: PUT comercial_id de un técnico → 400', x.s === 400 && /rol comercial/.test(x.j.error), x.t);
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: 999999 } });
  ok('admin: PUT comercial_id inexistente → 400', x.s === 400, x.t);
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: 'abc' } });
  ok('admin: PUT comercial_id no numérico → 400', x.s === 400, x.t);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: A, body: { nombre: 'Cliente con comercial SL', cif: 'B99000111', comercial_id: comercialId } });
  ok('admin: POST con comercial_id → 201 con comercial_nombre', x.s === 201 && x.j.comercial_id === comercialId && x.j.comercial_nombre === 'Iker Goikoetxea', x.t);
  const nuevoCliente = x.j;

  // --- Comercial desactivado: no se puede asignar, pero el cliente conserva el dato ---------------------
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { usuario: 'comercial2', nombre: 'Comercial Dos', rol: 'comercial', clave: 'clave-c2-123' } });
  const comercial2 = x.j;
  ok('admin: alta de comercial2', x.s === 201);
  x = await pedir('/api/comerciales', { cookie: A });
  ok('GET /comerciales → ahora 3', x.s === 200 && x.j.length === 3, `n=${x.j.length}`);
  x = await pedir(`/api/clientes/${txorierri.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: comercial2.id } });
  ok('admin: Txorierri (de baja) a comercial2 → 200', x.s === 200 && x.j.comercial_id === comercial2.id, x.t);
  x = await pedir(`/api/usuarios/${comercial2.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  ok('admin: desactivar comercial2', x.s === 200 && x.j.activo === 0);
  x = await pedir('/api/comerciales', { cookie: A });
  ok('GET /comerciales → vuelve a 2 (sin el desactivado)', x.s === 200 && x.j.length === 2, `n=${x.j.length}`);
  x = await pedir(`/api/clientes/${txorierri.id}`, { cookie: A });
  ok('el cliente conserva comercial_id y comercial_nombre del desactivado', x.s === 200 && x.j.comercial_id === comercial2.id && x.j.comercial_nombre === 'Comercial Dos');
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: comercial2.id } });
  ok('admin: asignar un comercial desactivado → 400', x.s === 400 && /desactivado/.test(x.j.error), x.t);

  // --- Jefe comercial: mismos permisos que comercial, alcance total ------------------------------------
  const J = await login('jefeventas1', 'prueba123');
  x = await pedir('/api/sesion', { cookie: J });
  ok('jefe comercial: rol comercial_jefe con alcance todo y los mismos 4 permisos que comercial', x.s === 200 && x.j.usuario.rol === 'comercial_jefe' && x.j.alcance === 'todo' && JSON.stringify(x.j.permisos) === JSON.stringify(['ot.ver', 'clientes.ver', 'maquinas.ver', 'kanban.ver']), JSON.stringify(x.j.permisos));
  x = await pedir('/api/clientes', { cookie: J });
  ok('jefe comercial: ve todos los clientes activos (11, incluidos los sin comercial)', x.s === 200 && x.j.length === 11, `n=${x.j.length}`);
  x = await pedir(`/api/clientes/${garaio.id}`, { cookie: J });
  ok('jefe comercial: ficha de un cliente sin comercial → 200', x.s === 200);
  x = await pedir('/api/maquinas', { cookie: J });
  const maqAdmin = (await pedir('/api/maquinas', { cookie: A })).j.length;
  ok('jefe comercial: ve las mismas máquinas que el admin', x.s === 200 && x.j.length === maqAdmin, `${x.j.length}/${maqAdmin}`);
  x = await pedir('/api/ot', { cookie: J });
  const otAdmin = (await pedir('/api/ot', { cookie: A })).j.total;
  ok('jefe comercial: ve las mismas O.T. abiertas que el admin', x.s === 200 && x.j.total === otAdmin, `${x.j.total}/${otAdmin}`);
  x = await pedir(`/api/ot/${otAjena.id}`, { cookie: J });
  ok('jefe comercial: detalle de una O.T. de un cliente sin comercial → 200', x.s === 200);
  x = await pedir('/api/kanban', { cookie: J });
  const kanbanAdmin = (await pedir('/api/kanban', { cookie: A })).j.total;
  ok('jefe comercial: Kanban completo, igual que el admin', x.s === 200 && x.j.total === kanbanAdmin, `${x.j.total}/${kanbanAdmin}`);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: J, body: { nombre: 'No debería' } });
  ok('jefe comercial: POST /clientes → 403 (solo lectura)', x.s === 403, x.t);
  x = await pedir('/api/comerciales', { cookie: J });
  ok('jefe comercial: GET /comerciales → 403', x.s === 403, x.t);
  x = await pedir('/api/usuarios', { cookie: J });
  ok('jefe comercial: GET /usuarios → 403', x.s === 403, x.t);
  x = await pedir(`/api/ot/${otAjena.id}/estado`, { metodo: 'POST', cookie: J, body: { estado: 'en_curso', version: 1 } });
  ok('jefe comercial: cambiar estado → 403', x.s === 403, x.t);
  x = await pedir('/api/comerciales', { cookie: A });
  ok('admin: GET /comerciales incluye al jefe comercial (2 con Iker; comercial2 sigue de baja)', x.s === 200 && x.j.length === 2 && x.j.some((c) => c.nombre === 'Nerea Olabarria'), x.t);
  const jefeId = x.j.find((c) => c.nombre === 'Nerea Olabarria').id;
  x = await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: jefeId } });
  ok('admin: el jefe comercial también puede ser comercial responsable de un cliente', x.s === 200 && x.j.comercial_nombre === 'Nerea Olabarria', x.t);
  await pedir(`/api/clientes/${garaio.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: null } });

  // --- Otros roles --------------------------------------------------------------------------------------
  const F = await login('finanzas1', 'prueba123');
  x = await pedir('/api/comerciales', { cookie: F });
  ok('financiero: GET /comerciales → 200 (clientes.gestionar)', x.s === 200);
  x = await pedir('/api/clientes', { cookie: F });
  ok('financiero: ve todos los clientes activos (alcance todo)', x.s === 200 && x.j.length === 11, `n=${x.j.length}`);
  const T = await login('tecnico1', 'prueba123');
  x = await pedir('/api/comerciales', { cookie: T });
  ok('técnico: GET /comerciales → 403', x.s === 403, x.t);
  x = await pedir('/api/clientes', { cookie: T });
  ok('técnico: ve todos los clientes activos (su alcance es por O.T., no por cliente)', x.s === 200 && x.j.length === 11, `n=${x.j.length}`);

  // Dejar la BD previsible para el arnés de navegador: cartera de comercial1 = Ibaizabal y Lezama; Txorierri sin comercial
  await pedir(`/api/clientes/${nuevoCliente.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: null, activo: false } });
  await pedir(`/api/clientes/${txorierri.id}`, { metodo: 'PUT', cookie: A, body: { comercial_id: null } });

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
