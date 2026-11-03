// Prueba HTTP del maestro de usuarios (F2-04) contra server.js en 5055 con BD temporal llena por generar-datos-prueba.js.
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
async function intentarLogin(usuario, clave) {
  const r = await fetch(BASE + '/acceso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  return { s: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(usuario, clave) {
  const r = await intentarLogin(usuario, clave);
  if (r.s !== 200) throw new Error(`login ${usuario} → ${r.s}`);
  return r.cookie;
}

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');
  x = await pedir('/api/sesion', { cookie: A });
  const adminId = x.j.usuario.id;

  // Listado y roles
  x = await pedir('/api/usuarios', { cookie: A });
  ok('GET /api/usuarios → 200 con roles (6, con grupo) y 7 usuarios activos con num_ot y karve_id',
    x.s === 200 && x.j.roles.length === 6 && x.j.roles.every((r) => r.codigo && r.nombre && ['tecnico', 'sat', 'oficina'].includes(r.grupo)) && x.j.usuarios.length === 7 && x.j.usuarios.every((u) => 'num_ot' in u && 'karve_id' in u && !('clave_hash' in u)),
    `roles=${x.j.roles && x.j.roles.length} usuarios=${x.j.usuarios && x.j.usuarios.length}`);
  ok('roles: tecnico → grupo tecnico, sat → sat, admontaller/recambista/financiero/comercial → oficina',
    x.j.roles.find((r) => r.codigo === 'tecnico').grupo === 'tecnico' && x.j.roles.find((r) => r.codigo === 'sat').grupo === 'sat' && ['admontaller', 'recambista', 'financiero', 'comercial'].every((c) => x.j.roles.find((r) => r.codigo === c).grupo === 'oficina'));
  const tecnico1 = x.j.usuarios.find((u) => u.usuario === 'tecnico1');
  ok('seed: tecnico1 con código Karve OP012 y O.T. asignadas contadas', tecnico1 && tecnico1.karve_id === 'OP012' && tecnico1.num_ot > 0, `karve=${tecnico1 && tecnico1.karve_id} num_ot=${tecnico1 && tecnico1.num_ot}`);
  x = await pedir('/api/usuarios?todos=1', { cookie: A });
  ok('GET ?todos=1 → 8, el desactivado (tecnico3, seed) al final', x.s === 200 && x.j.usuarios.length === 8 && x.j.usuarios[7].usuario === 'tecnico3' && x.j.usuarios[7].activo === 0, `n=${x.j.usuarios.length}`);
  x = await pedir('/api/usuarios?q=mikel', { cookie: A });
  ok('GET ?q=mikel → 1 (por nombre)', x.s === 200 && x.j.usuarios.length === 1 && x.j.usuarios[0].usuario === 'tecnico1');
  x = await pedir('/api/usuarios?q=OP0', { cookie: A });
  ok('GET ?q=OP0 → 3 activos (por código Karve)', x.s === 200 && x.j.usuarios.length === 3, `n=${x.j.usuarios.length}`);
  x = await pedir('/api/usuarios?q=vibacar-pruebas', { cookie: A });
  ok('GET ?q=vibacar-pruebas → 6 (por email)', x.s === 200 && x.j.usuarios.length === 6, `n=${x.j.usuarios.length}`);
  x = await pedir('/api/usuarios?q=comercial1', { cookie: A });
  ok('GET ?q=comercial1 → 1 (por login)', x.s === 200 && x.j.usuarios.length === 1);

  // Ficha
  x = await pedir(`/api/usuarios/${tecnico1.id}`, { cookie: A });
  ok('GET /usuarios/:id → ficha sin clave_hash, con num_ot, origen local', x.s === 200 && x.j.usuario === 'tecnico1' && !('clave_hash' in x.j) && typeof x.j.num_ot === 'number' && x.j.origen === 'local');
  x = await pedir('/api/usuarios/999999', { cookie: A });
  ok('GET /usuarios/:id inexistente → 404', x.s === 404, x.t);

  // Validación del alta
  const base = { usuario: 'prueba.http', nombre: 'Prueba HTTP', rol: 'tecnico', email: 'ph@vibacar-pruebas.local', karve_id: 'OP077', clave: 'clave-http-1' };
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, usuario: undefined } });
  ok('POST sin usuario → 400', x.s === 400, x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, usuario: 'ab' } });
  ok('POST login de 2 caracteres → 400', x.s === 400 && /3-40/.test(x.j.error), x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, usuario: 'con espacio' } });
  ok('POST login con espacio → 400', x.s === 400, x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, nombre: '' } });
  ok('POST sin nombre → 400', x.s === 400, x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, clave: '12345' } });
  ok('POST clave de 5 → 400', x.s === 400 && /6 caracteres/.test(x.j.error), x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, clave: undefined } });
  ok('POST sin clave → 400 (obligatoria al crear)', x.s === 400, x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, rol: 'jefe' } });
  ok('POST rol inválido → 400', x.s === 400 && /Rol no válido/.test(x.j.error), x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, email: 'sin-arroba' } });
  ok('POST email inválido → 400', x.s === 400 && /email/.test(x.j.error), x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, usuario: 'tecnico1' } });
  ok('POST login repetido → 409 con usuario_id y nombre del otro', x.s === 409 && x.j.usuario_id === tecnico1.id && /Mikel/.test(x.j.error), x.t);
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, usuario: 'TECNICO1' } });
  ok('POST login repetido en mayúsculas → 409 (sin distinguir mayúsculas)', x.s === 409, x.t);

  // Alta correcta y login
  x = await pedir('/api/usuarios', { metodo: 'POST', cookie: A, body: { ...base, email: '  ph@vibacar-pruebas.local ' } });
  ok('POST alta → 201: activo, origen local, karve_id, email recortado, num_ot 0, sin clave_hash',
    x.s === 201 && x.j.activo === 1 && x.j.origen === 'local' && x.j.karve_id === 'OP077' && x.j.email === 'ph@vibacar-pruebas.local' && x.j.num_ot === 0 && !('clave_hash' in x.j), x.t);
  const nuevo = x.j;
  let l = await intentarLogin('prueba.http', 'clave-http-1');
  ok('login del nuevo usuario con su contraseña → 200', l.s === 200);
  const P = l.cookie;
  x = await pedir('/api/sesion', { cookie: P });
  ok('el nuevo usuario tiene rol tecnico con alcance asignadas', x.s === 200 && x.j.usuario.rol === 'tecnico' && x.j.alcance === 'asignadas');

  // Edición parcial
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { nombre: 'Prueba HTTP 2' } });
  ok('PUT parcial nombre → 200, el resto intacto', x.s === 200 && x.j.nombre === 'Prueba HTTP 2' && x.j.karve_id === 'OP077' && x.j.email === 'ph@vibacar-pruebas.local' && x.j.rol === 'tecnico', x.t);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: {} });
  ok('PUT sin campos → 400', x.s === 400, x.t);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { nombre: 'Prueba HTTP 2', clave: '' } });
  ok('PUT con clave vacía → 200 y NO cambia la contraseña', x.s === 200 && (await intentarLogin('prueba.http', 'clave-http-1')).s === 200);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { clave: '123' } });
  ok('PUT clave corta → 400', x.s === 400, x.t);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { clave: 'nueva-clave-2' } });
  ok('PUT clave nueva → 200; la antigua deja de valer y la nueva entra', x.s === 200 && (await intentarLogin('prueba.http', 'clave-http-1')).s === 401 && (await intentarLogin('prueba.http', 'nueva-clave-2')).s === 200);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { email: '', karve_id: '' } });
  ok('PUT email y karve_id vacíos → quedan a null', x.s === 200 && x.j.email === null && x.j.karve_id === null, x.t);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { karve_id: 'OP078', email: 'nuevo@vibacar-pruebas.local' } });
  ok('PUT vuelve a poner karve_id y email', x.s === 200 && x.j.karve_id === 'OP078' && x.j.email === 'nuevo@vibacar-pruebas.local');
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { usuario: 'tecnico2' } });
  ok('PUT cambiar login a uno ocupado → 409', x.s === 409, x.t);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { usuario: 'prueba.http2' } });
  ok('PUT cambiar login a uno libre → 200 y entra con el nuevo login', x.s === 200 && x.j.usuario === 'prueba.http2' && (await intentarLogin('prueba.http2', 'nueva-clave-2')).s === 200);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { rol: 'sat' } });
  ok('PUT cambiar rol a sat → 200', x.s === 200 && x.j.rol === 'sat');
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { rol: 'director' } });
  ok('PUT rol inválido → 400', x.s === 400, x.t);
  x = await pedir('/api/usuarios/999999', { metodo: 'PUT', cookie: A, body: { nombre: 'X' } });
  ok('PUT inexistente → 404', x.s === 404, x.t);
  x = await pedir('/api/tecnicos', { cookie: A });
  ok('GET /tecnicos incluye al nuevo (sat activo)', x.s === 200 && x.j.some((t) => t.id === nuevo.id));

  // Baja lógica: expulsa la sesión abierta y bloquea el login
  x = await pedir('/api/sesion', { cookie: P });
  ok('antes de la baja: su sesión sigue viva', x.s === 200);
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  ok('PUT activo=false → 200 con activo 0', x.s === 200 && x.j.activo === 0, x.t);
  x = await pedir('/api/sesion', { cookie: P });
  ok('tras la baja: su sesión abierta queda expulsada (401)', x.s === 401, `${x.s}`);
  l = await intentarLogin('prueba.http2', 'nueva-clave-2');
  ok('tras la baja: el login con contraseña correcta → 401', l.s === 401, `${l.s}`);
  x = await pedir('/api/tecnicos', { cookie: A });
  ok('tras la baja: desaparece de /tecnicos', x.s === 200 && !x.j.some((t) => t.id === nuevo.id));
  x = await pedir('/api/usuarios', { cookie: A });
  ok('tras la baja: no sale en Activos', !x.j.usuarios.some((u) => u.id === nuevo.id));
  x = await pedir('/api/usuarios?todos=1', { cookie: A });
  ok('tras la baja: sí sale en Todos, entre los desactivados del final (orden por nombre), y conserva sus datos', (() => { const i = x.j.usuarios.findIndex((u) => u.id === nuevo.id); return i >= 0 && x.j.usuarios.slice(i).every((u) => u.activo === 0) && x.j.usuarios[i].karve_id === 'OP078'; })());
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { nombre: 'Prueba HTTP 3' } });
  ok('un usuario de baja se puede seguir editando', x.s === 200 && x.j.nombre === 'Prueba HTTP 3');
  x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: true } });
  ok('reactivar → 200 y vuelve a poder entrar', x.s === 200 && x.j.activo === 1 && (await intentarLogin('prueba.http2', 'nueva-clave-2')).s === 200);
  l = await intentarLogin('tecnico3', 'prueba123');
  ok('tecnico3 (desactivado por el seed) no puede entrar → 401', l.s === 401, `${l.s}`);

  // Autoprotección del administrador
  x = await pedir(`/api/usuarios/${adminId}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  ok('admin: desactivarse a sí mismo → 400', x.s === 400 && /propio usuario/.test(x.j.error), x.t);
  x = await pedir(`/api/usuarios/${adminId}`, { metodo: 'PUT', cookie: A, body: { rol: 'tecnico' } });
  ok('admin: cambiarse el rol → 400', x.s === 400 && /propio rol/.test(x.j.error), x.t);
  x = await pedir(`/api/usuarios/${adminId}`, { metodo: 'PUT', cookie: A, body: { rol: 'admontaller', nombre: 'Administrador' } });
  ok('admin: enviar su mismo rol con otro campo → 200', x.s === 200, x.t);

  // Permisos: solo usuarios.gestionar (admontaller)
  for (const [u, nombre] of [['tecnico1', 'técnico'], ['sat1', 'SAT'], ['recambista1', 'recambista'], ['finanzas1', 'financiero'], ['comercial1', 'comercial']]) {
    const C = await login(u, 'prueba123');
    x = await pedir('/api/usuarios', { cookie: C });
    const g = x.s;
    x = await pedir('/api/usuarios', { metodo: 'POST', cookie: C, body: base });
    const p = x.s;
    x = await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: C, body: { activo: false } });
    ok(`${nombre}: GET/POST/PUT usuarios → 403`, g === 403 && p === 403 && x.s === 403, `${g}/${p}/${x.s}`);
  }

  // Dejar la BD previsible para el arnés de navegador: 7 activos, 2 desactivados (tecnico3 y prueba.http2)
  await pedir(`/api/usuarios/${nuevo.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
