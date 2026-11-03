// Prueba HTTP del maestro de máquinas (F2-03) contra server.js en 5055 con BD temporal llena por generar-datos-prueba.js.
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

  // Migración y listado
  x = await pedir('/api/maquinas', { cookie: A });
  ok('GET /api/maquinas → 23 activas con cliente_nombre, cliente_activo, num_ot, origen y observaciones (migración)',
    x.s === 200 && x.j.length === 23 && x.j.every((m) => m.cliente_nombre && 'cliente_activo' in m && 'num_ot' in m && ['manual', 'karve'].includes(m.origen) && 'observaciones' in m), `n=${x.j && x.j.length}`);
  const activas = x.j;
  ok('listado: 13 máquinas de Karve con código y 10 manuales', activas.filter((m) => m.origen === 'karve' && m.karve_id).length === 13 && activas.filter((m) => m.origen === 'manual').length === 10, `karve=${activas.filter((m) => m.origen === 'karve').length}`);
  ok('listado: alguna máquina con O.T. contadas y alguna con observaciones', activas.some((m) => m.num_ot > 0) && activas.some((m) => m.observaciones));
  x = await pedir('/api/maquinas?todos=1', { cookie: A });
  ok('GET ?todos=1 → 24, la desactivada (Kubota) al final', x.s === 200 && x.j.length === 24 && x.j[23].activo === 0 && x.j[23].marca === 'Kubota', `n=${x.j && x.j.length}`);
  const kubota = x.j[23];

  // Clientes de apoyo
  x = await pedir('/api/clientes?todos=1', { cookie: A });
  const clientes = x.j;
  const lezama = clientes.find((c) => c.nombre === 'Grúas Lezama');
  const inactivo = clientes.find((c) => !c.activo);
  ok('clientes de apoyo: Grúas Lezama y un cliente desactivado', !!lezama && !!inactivo, inactivo && inactivo.nombre);
  x = await pedir(`/api/maquinas?cliente_id=${lezama.id}`, { cookie: A });
  const deLezama = x.j;
  ok('GET ?cliente_id= → solo máquinas de ese cliente (2)', x.s === 200 && deLezama.length === 2 && deLezama.every((m) => m.cliente_id === lezama.id));
  x = await pedir(`/api/maquinas?cliente_id=${inactivo.id}&todos=1`, { cookie: A });
  ok('máquinas de un cliente desactivado llevan cliente_activo = 0', x.s === 200 && x.j.every((m) => m.cliente_activo === 0), `n=${x.j.length}`);
  const deInactivo = x.j;

  // Ficha
  x = await pedir(`/api/maquinas/${deLezama[0].id}`, { cookie: A });
  ok('GET /maquinas/:id → ficha con cliente_nombre y num_ot', x.s === 200 && x.j.cliente_nombre === 'Grúas Lezama' && typeof x.j.num_ot === 'number');
  x = await pedir('/api/maquinas/999999', { cookie: A });
  ok('GET /maquinas/:id inexistente → 404', x.s === 404, x.t);

  // Validación
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { marca: 'Sin cliente' } });
  ok('POST sin cliente_id → 400', x.s === 400, x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id } });
  ok('POST sin ningún dato de máquina → 400', x.s === 400 && /al menos/.test(x.j.error), x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: 999999, marca: 'X' } });
  ok('POST cliente inexistente → 400', x.s === 400 && /no existe/.test(x.j.error), x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: inactivo.id, marca: 'X' } });
  ok('POST a cliente desactivado → 400 "desactivado"', x.s === 400 && /desactivado/.test(x.j.error), x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id, marca: 'X', horometro_ultimo: -5 } });
  ok('POST horómetro negativo → 400', x.s === 400, x.t);

  // Alta
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id, marca: 'Liebherr', modelo: 'LTM 1090', bastidor: ' w09ltm1090-test ', num_flota: 'GL-9', horometro_ultimo: '123.5', observaciones: 'Grúa de prueba' } });
  ok('POST alta → 201 con bastidor en mayúsculas, origen manual, activa, cliente_nombre, num_ot 0 y observaciones',
    x.s === 201 && x.j.bastidor === 'W09LTM1090-TEST' && x.j.origen === 'manual' && x.j.activo === 1 && x.j.cliente_nombre === 'Grúas Lezama' && x.j.num_ot === 0 && x.j.horometro_ultimo === 123.5 && x.j.observaciones === 'Grúa de prueba', x.t);
  const nueva = x.j;
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id, marca: 'Otra', bastidor: 'w09ltm1090-TEST' } });
  ok('POST bastidor repetido (otra caja) → 409 con maquina_id', x.s === 409 && x.j.maquina_id === nueva.id && /Grúas Lezama/.test(x.j.error), x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id, marca: 'Rápida', modelo: '', bastidor: '' } });
  ok('POST alta rápida (desde Nueva O.T.) con bastidor vacío → 201 y bastidor null', x.s === 201 && x.j.bastidor === null, x.t);
  const rapida = x.j;
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id, marca: 'Rápida 2', bastidor: '' } });
  ok('POST otra sin bastidor → 201 (los bastidores vacíos no chocan)', x.s === 201, x.t);
  const rapida2 = x.j;

  // Edición parcial
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { num_flota: 'GL-10' } });
  ok('PUT parcial → flota cambiada, resto intacto, actualizado', x.s === 200 && x.j.num_flota === 'GL-10' && x.j.modelo === 'LTM 1090' && x.j.observaciones === 'Grúa de prueba' && x.j.cliente_id === lezama.id && x.j.actualizado, x.t);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { bastidor: deLezama[0].bastidor.toLowerCase() } });
  ok('PUT con el bastidor de otra máquina → 409', x.s === 409 && x.j.maquina_id === deLezama[0].id, x.t);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { bastidor: 'W09LTM1090-TEST' } });
  ok('PUT con su propio bastidor → 200', x.s === 200, x.t);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { origen: 'karve', karve_id: 'M-TEST' } });
  ok('PUT origen no editable (sigue manual), karve_id sí (hasta la Fase 5)', x.s === 200 && x.j.origen === 'manual' && x.j.karve_id === 'M-TEST', x.t);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { horometro_ultimo: 'abc' } });
  ok('PUT horómetro no numérico → 400', x.s === 400, x.t);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { cliente_id: inactivo.id } });
  ok('PUT cambiar a cliente desactivado → 400', x.s === 400 && /desactivado/.test(x.j.error), x.t);
  x = await pedir('/api/maquinas/999999', { metodo: 'PUT', cookie: A, body: { marca: 'X' } });
  ok('PUT id inexistente → 404', x.s === 404, x.t);
  if (deInactivo.length) {
    x = await pedir(`/api/maquinas/${deInactivo[0].id}`, { metodo: 'PUT', cookie: A, body: { observaciones: 'Editada aunque su cliente esté de baja' } });
    ok('PUT sin cliente_id en máquina de cliente desactivado → 200 (se puede seguir editando)', x.s === 200 && x.j.cliente_activo === 0, x.t);
  } else {
    ok('PUT en máquina de cliente desactivado: el cliente de baja no tiene máquinas en los datos de prueba (comprobación omitida)', true);
  }

  // Búsqueda
  x = await pedir('/api/maquinas?q=1090-test', { cookie: A });
  ok('GET ?q= busca por bastidor (sin distinguir mayúsculas)', x.s === 200 && x.j.length === 1 && x.j[0].id === nueva.id, `n=${x.j.length}`);
  x = await pedir('/api/maquinas?q=lezama', { cookie: A });
  ok('GET ?q= busca por nombre de cliente → las 5 de Grúas Lezama', x.s === 200 && x.j.length === 5 && x.j.every((m) => m.cliente_id === lezama.id), `n=${x.j.length}`);
  x = await pedir('/api/maquinas?q=GL-10', { cookie: A });
  ok('GET ?q= busca por nº de flota', x.s === 200 && x.j.length === 1, `n=${x.j.length}`);
  x = await pedir('/api/maquinas?q=M0001', { cookie: A });
  ok('GET ?q= busca por código Karve', x.s === 200 && x.j.length >= 1 && x.j.every((m) => m.origen === 'karve'), `n=${x.j.length}`);
  x = await pedir('/api/maquinas?q=zzzzzz', { cookie: A });
  ok('GET ?q= sin resultados → []', x.s === 200 && x.j.length === 0);

  // Baja lógica
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });
  ok('PUT activo=false → desactivada', x.s === 200 && x.j.activo === 0, x.t);
  x = await pedir('/api/maquinas', { cookie: A });
  ok('GET por defecto no lista la desactivada', x.s === 200 && !x.j.some((m) => m.id === nueva.id));
  x = await pedir('/api/maquinas?todos=1', { cookie: A });
  ok('GET ?todos=1 sí la lista, entre las de baja al final', x.s === 200 && x.j.some((m) => m.id === nueva.id) && x.j.slice(-2).every((m) => m.activo === 0));
  x = await pedir(`/api/maquinas/${nueva.id}`, { cookie: A });
  ok('GET /maquinas/:id de la desactivada sigue accesible', x.s === 200 && x.j.activo === 0);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: A, body: { activo: true } });
  ok('PUT activo=true → reactivada', x.s === 200 && x.j.activo === 1, x.t);
  x = await pedir(`/api/clientes/${lezama.id}`, { cookie: A });
  ok('GET /clientes/:id devuelve sus máquinas con origen (5)', x.s === 200 && x.j.maquinas.length === 5 && x.j.maquinas.every((m) => m.origen), `n=${x.j.maquinas.length}`);

  // Permisos
  const T = await login('tecnico1', 'prueba123');
  x = await pedir('/api/maquinas', { cookie: T });
  ok('técnico: GET máquinas → 200 (maquinas.ver)', x.s === 200);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: T, body: { cliente_id: lezama.id, marca: 'No' } });
  ok('técnico: POST máquinas → 403', x.s === 403, x.t);
  x = await pedir(`/api/maquinas/${nueva.id}`, { metodo: 'PUT', cookie: T, body: { activo: false } });
  ok('técnico: PUT máquinas → 403', x.s === 403, x.t);
  const SAT = await login('sat1', 'prueba123');
  x = await pedir('/api/maquinas', { cookie: SAT });
  ok('SAT: GET máquinas → 200', x.s === 200);
  const C = await login('comercial1', 'prueba123');
  x = await pedir('/api/maquinas', { cookie: C });
  ok('comercial: GET máquinas → 200', x.s === 200);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: C, body: { cliente_id: lezama.id, marca: 'No' } });
  ok('comercial: POST máquinas → 403', x.s === 403, x.t);
  const F = await login('finanzas1', 'prueba123');
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: F, body: { cliente_id: lezama.id, marca: 'No' } });
  ok('financiero: POST máquinas → 403 (solo maquinas.ver)', x.s === 403, x.t);

  // Limpieza de las máquinas rápidas para dejar la BD previsible al arnés de navegador (quedan 25: 24 + la Liebherr)
  for (const m of [rapida, rapida2]) await pedir(`/api/maquinas/${m.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
