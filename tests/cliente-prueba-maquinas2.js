// Prueba HTTP de Máquinas v2 (F3-04) y Roles v2 (F3-05) contra server.js en 5055 con BD temporal (prueba-maquinas2.db).
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
const YY = String(new Date().getFullYear()).slice(-2);
const RE_FLOTA = new RegExp(`^F-${YY}-\\d{4}$`);

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');
  const R = await login('responsable1', 'prueba123');
  const G = await login('gerencia1', 'prueba123');
  const GS = await login('gestorsat1', 'prueba123');
  const F = await login('finanzas1', 'prueba123');
  const T = await login('tecnico1', 'prueba123');

  // --- Roles v2 --------------------------------------------------------------------------------------
  x = await pedir('/api/sesion', { cookie: A });
  ok('admin inicial: rol administrativo con usuarios.gestionar y alcance todo', x.j.usuario.rol === 'administrativo' && x.j.permisos.includes('usuarios.gestionar') && x.j.alcance === 'todo', x.j.usuario.rol);
  x = await pedir('/api/sesion', { cookie: R });
  ok('responsable_st: todo menos usuarios.gestionar', x.j.usuario.rol === 'responsable_st' && !x.j.permisos.includes('usuarios.gestionar') && x.j.permisos.includes('ot.asignar') && x.j.permisos.includes('maquinas.gestionar') && x.j.alcance === 'todo');
  x = await pedir('/api/sesion', { cookie: G });
  ok('gerencia: solo lectura (5 permisos de ver)', x.j.usuario.rol === 'gerencia' && JSON.stringify([...x.j.permisos].sort()) === JSON.stringify(['clientes.ver', 'informes.ver', 'kanban.ver', 'maquinas.ver', 'ot.ver']), JSON.stringify(x.j.permisos));
  x = await pedir('/api/sesion', { cookie: GS });
  ok('gestor_sat: alcance sat, con asignar/aprobar y sin maestros', x.j.usuario.rol === 'gestor_sat' && x.j.alcance === 'sat' && x.j.permisos.includes('ot.aprobar_asignacion') && !x.j.permisos.includes('clientes.gestionar'));
  x = await pedir('/api/sesion', { cookie: F });
  ok('finanzas1 (antes financiero) → administrativo', x.j.usuario.rol === 'administrativo');
  x = await pedir('/api/usuarios', { cookie: A });
  ok('GET /usuarios → 9 roles, ninguno antiguo', x.s === 200 && x.j.roles.length === 9 && !x.j.roles.some((r) => /admontaller|financiero/.test(r.codigo)), x.j.roles.map((r) => r.codigo).join(','));
  for (const [c, nombre] of [[R, 'responsable_st'], [G, 'gerencia'], [GS, 'gestor_sat']]) {
    x = await pedir('/api/usuarios', { cookie: c });
    ok(`${nombre}: GET /usuarios → 403`, x.s === 403, `${x.s}`);
  }
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: G, body: { nombre: 'No' } });
  ok('gerencia: POST /clientes → 403', x.s === 403);
  x = await pedir('/api/kanban', { cookie: G });
  ok('gerencia: Kanban completo', x.s === 200 && x.j.total > 10, `total=${x.j.total}`);
  x = await pedir('/api/clientes', { metodo: 'POST', cookie: R, body: { nombre: 'Cliente del responsable SL' } });
  ok('responsable_st: POST /clientes → 201', x.s === 201, x.t);
  const clienteResp = x.j;
  x = await pedir('/api/estados', { cookie: R });
  ok('responsable_st: tiene transiciones (migradas de admontaller)', x.s === 200 && x.j.transiciones.length >= 10, `${x.j.transiciones.length}`);
  x = await pedir('/api/estados', { cookie: G });
  ok('gerencia: sin transiciones', x.s === 200 && x.j.transiciones.length === 0, `${x.j.transiciones.length}`);
  // gestor_sat: alcance = O.T. de SAT o sin técnico
  x = await pedir('/api/ot?abiertas=0&limite=100', { cookie: A });
  const todasOT = x.j.ots;
  x = await pedir('/api/tecnicos', { cookie: A });
  const satIds = new Set(x.j.filter((t) => t.rol === 'sat').map((t) => t.id));
  const esperadas = todasOT.filter((o) => o.tecnico_id === null || satIds.has(o.tecnico_id));
  x = await pedir('/api/ot?abiertas=0&limite=100', { cookie: GS });
  ok(`gestor_sat: GET /ot → solo O.T. de SAT o sin técnico (${esperadas.length} de ${todasOT.length})`, x.s === 200 && x.j.total === esperadas.length && x.j.ots.every((o) => o.tecnico_id === null || satIds.has(o.tecnico_id)), `total=${x.j.total}`);
  const otTecnico = todasOT.find((o) => o.tecnico_id && !satIds.has(o.tecnico_id));
  x = await pedir(`/api/ot/${otTecnico.id}`, { cookie: GS });
  ok('gestor_sat: O.T. de un técnico interno → 404', x.s === 404, `${x.s}`);
  const otSat = todasOT.find((o) => satIds.has(o.tecnico_id));
  x = await pedir(`/api/ot/${otSat.id}`, { cookie: GS });
  ok('gestor_sat: O.T. de un SAT → 200', x.s === 200, `${x.s}`);
  x = await pedir('/api/kanban', { cookie: GS });
  ok('gestor_sat: Kanban solo con sus O.T.', x.s === 200 && x.j.fases.flatMap((f) => f.ots).every((o) => o.tecnico_id === null || satIds.has(o.tecnico_id)));

  // --- Máquinas v2 ------------------------------------------------------------------------------------
  x = await pedir('/api/maquinas', { cookie: A });
  const maquinas = x.j;
  ok('GET /maquinas → estado, num_contrato y caracteristicas en todas (migración); todas con nº de flota', x.s === 200 && maquinas.every((m) => 'estado' in m && 'num_contrato' in m && 'caracteristicas' in m && m.num_flota), `n=${maquinas.length}`);
  ok('seed: las que no tenían nº de flota llevan uno generado F-YY-XXXX; las de Karve conservan el suyo (IB-12)', maquinas.filter((m) => RE_FLOTA.test(m.num_flota)).length >= 5 && maquinas.some((m) => m.num_flota === 'IB-12'), `${maquinas.filter((m) => RE_FLOTA.test(m.num_flota)).map((m) => m.num_flota).join(',')}`);
  ok('seed: estados variados y contratos solo fuera de cliente_final', maquinas.some((m) => m.estado === 'rent_to_rent' && m.num_contrato) && maquinas.some((m) => m.estado === 'propia') && maquinas.filter((m) => m.estado === 'cliente_final').every((m) => m.num_contrato === null));
  const generadas = maquinas.filter((m) => RE_FLOTA.test(m.num_flota)).map((m) => Number(m.num_flota.slice(-4)));
  const ultima = Math.max(...generadas);
  x = await pedir('/api/clientes', { cookie: A });
  const lezama = x.j.find((c) => c.nombre === 'Grúas Lezama');

  // Alta: nº de flota automático y robusto
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: R, body: { cliente_id: lezama.id, marca: 'Terex', modelo: 'AC 55', bastidor: 'w09-f304-001', num_flota: 'QUIERO-ESTE', estado: 'rent_to_rent', num_contrato: 'RR-2026-099', caracteristicas: 'Grúa 55 t' } });
  ok(`POST (responsable_st) → 201 con nº de flota generado F-${YY}-${String(ultima + 1).padStart(4, '0')}, ignorando el enviado; estado y contrato guardados`, x.s === 201 && x.j.num_flota === `F-${YY}-${String(ultima + 1).padStart(4, '0')}` && x.j.estado === 'rent_to_rent' && x.j.num_contrato === 'RR-2026-099' && x.j.caracteristicas === 'Grúa 55 t' && x.j.bastidor === 'W09-F304-001', x.t);
  const m1 = x.j;
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: R, body: { cliente_id: lezama.id, marca: 'Terex', modelo: 'AC 100', num_contrato: 'NO-DEBE-QUEDAR' } });
  ok('POST sin estado → cliente_final y el contrato se descarta; flota correlativa', x.s === 201 && x.j.estado === 'cliente_final' && x.j.num_contrato === null && x.j.num_flota === `F-${YY}-${String(ultima + 2).padStart(4, '0')}`, x.t);
  const m2 = x.j;
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: R, body: { cliente_id: lezama.id, marca: 'X', estado: 'alquilada' } });
  ok('POST estado inválido → 400', x.s === 400 && /estado/.test(x.j.error), x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: R, body: { cliente_id: lezama.id } });
  ok('POST sin marca/modelo/bastidor → 400', x.s === 400, x.t);
  // Colisión: el administrativo pone a mano el siguiente número a una máquina; el generador lo salta
  const siguiente = `F-${YY}-${String(ultima + 3).padStart(4, '0')}`;
  x = await pedir(`/api/maquinas/${m2.id}`, { metodo: 'PUT', cookie: A, body: { num_flota: siguiente } });
  ok('administrativo: PUT num_flota a mano → 200', x.s === 200 && x.j.num_flota === siguiente, x.t);
  x = await pedir('/api/maquinas', { metodo: 'POST', cookie: A, body: { cliente_id: lezama.id, marca: 'Terex', modelo: 'AC 160' } });
  ok(`POST tras la colisión → salta al siguiente libre F-${YY}-${String(ultima + 4).padStart(4, '0')}`, x.s === 201 && x.j.num_flota === `F-${YY}-${String(ultima + 4).padStart(4, '0')}`, x.t);
  const m3 = x.j;

  // Edición restringida
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: R, body: { horometro_ultimo: 120.5, observaciones: 'Revisada' } });
  ok('responsable_st: PUT horas y observaciones → 200', x.s === 200 && x.j.horometro_ultimo === 120.5 && x.j.observaciones === 'Revisada', x.t);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: R, body: { marca: 'Otra' } });
  ok('responsable_st: PUT marca → 403 con la lista de bloqueados', x.s === 403 && x.j.bloqueados && x.j.bloqueados.includes('marca') && /administrativo/.test(x.j.error), x.t);
  for (const campo of [['modelo', 'Y'], ['bastidor', 'ZZZ'], ['num_flota', 'F-99-0001'], ['estado', 'propia'], ['num_contrato', 'C'], ['caracteristicas', 'c'], ['cliente_id', lezama.id]]) {
    x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: R, body: { [campo[0]]: campo[1], horometro_ultimo: 1 } });
    ok(`responsable_st: PUT ${campo[0]} → 403 (aunque venga con horas)`, x.s === 403, `${x.s}`);
  }
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: R, body: { activo: false } });
  ok('responsable_st: desactivar → 200 (la baja no es una edición)', x.s === 200 && x.j.activo === 0, x.t);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: R, body: { activo: true } });
  ok('responsable_st: reactivar → 200', x.s === 200 && x.j.activo === 1);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: F, body: { marca: 'Terex corregida', estado: 'propia', num_contrato: 'AL-2026-001' } });
  ok('administrativo (finanzas1): PUT campos bloqueados → 200', x.s === 200 && x.j.marca === 'Terex corregida' && x.j.estado === 'propia' && x.j.num_contrato === 'AL-2026-001', x.t);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: A, body: { estado: 'cliente_final' } });
  ok('administrativo: pasar a cliente_final → el contrato se vacía', x.s === 200 && x.j.estado === 'cliente_final' && x.j.num_contrato === null, x.t);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: A, body: { num_contrato: 'Z' } });
  ok('administrativo: contrato sobre cliente_final → sigue null', x.s === 200 && x.j.num_contrato === null, x.t);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: A, body: { estado: 'subalquilada', num_contrato: 'SUB-1' } });
  ok('administrativo: subalquilada con contrato → guardado', x.s === 200 && x.j.num_contrato === 'SUB-1');
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: T, body: { horometro_ultimo: 5 } });
  ok('técnico: PUT máquinas → 403 (sin maquinas.gestionar)', x.s === 403);
  x = await pedir(`/api/maquinas/${m1.id}`, { metodo: 'PUT', cookie: G, body: { horometro_ultimo: 5 } });
  ok('gerencia: PUT máquinas → 403', x.s === 403);
  x = await pedir(`/api/maquinas/${m1.id}`, { cookie: G });
  ok('gerencia: GET máquina → 200 con estado y características', x.s === 200 && x.j.caracteristicas === 'Grúa 55 t');
  x = await pedir('/api/maquinas?q=SUB-1', { cookie: A });
  ok('GET ?q= por nº de contrato (SUB-1) → 1', x.s === 200 && x.j.length === 1 && x.j[0].id === m1.id, `n=${x.j.length}`);

  // Dejar la BD previsible para el navegador: las máquinas creadas aquí se desactivan; el cliente del responsable queda
  for (const m of [m1, m2, m3]) await pedir(`/api/maquinas/${m.id}`, { metodo: 'PUT', cookie: A, body: { activo: false } });

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
