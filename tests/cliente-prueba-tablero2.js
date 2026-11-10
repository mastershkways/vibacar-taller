// Prueba HTTP del Tablero v2 (F4-01 + F4-04): verticales + etiquetas, flujo libre con límites por rol, modal de dos preguntas
// (en la API: etiqueta/técnico + nota), cierre con ot.cerrar, etiqueta dentro de la vertical, rol operativo, filtros del listado.
// Servidor en 5055 con la BD del seed recién generada (ciclo tablero2 del lanzador).
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
const hoy = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const todas = (kb) => kb.fases.flatMap((f) => f.ots);
const VERTICALES = ['pendiente_planificar', 'planificada', 'en_curso', 'pausada', 'finalizada'];

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');
  const T = await login('tecnico1', 'prueba123');
  const RC = await login('recambista1', 'prueba123');
  const OP = await login('operativo1', 'prueba123');
  const G = await login('gerencia1', 'prueba123');

  // --- /api/estados: verticales, etiquetas, flujo ----------------------------------------------------
  x = await pedir('/api/estados', { cookie: A });
  const est = x.j;
  ok('GET /estados: 6 fases (5 abiertas + cerrada) en orden', x.s === 200 && est.fases.map((f) => f.codigo).join(',') === [...VERTICALES, 'cerrada'].join(',') && est.fases.filter((f) => f.abierta).length === 5, est.fases.map((f) => f.codigo).join(','));
  ok('GET /estados: estados con responsables (pausada → recambista, administrativo, operativo) y cerrada final', est.estados.length === 6 && est.estados.find((e) => e.codigo === 'pausada').responsables.includes('recambista') && est.estados.find((e) => e.codigo === 'cerrada').es_final === 1 && est.estados.find((e) => e.codigo === 'pendiente_planificar').es_inicial === 1);
  ok('GET /estados: 11 etiquetas con su vertical (repuesto → pausada, sat_externo → en_curso, vb_factura → finalizada, facturada → cerrada)', est.etiquetas.length === 11 && est.etiquetas.find((t) => t.codigo === 'repuesto').estado === 'pausada' && est.etiquetas.find((t) => t.codigo === 'sat_externo').estado === 'en_curso' && est.etiquetas.find((t) => t.codigo === 'vb_factura').estado === 'finalizada' && est.etiquetas.find((t) => t.codigo === 'facturada').estado === 'cerrada', `${est.etiquetas.length}`);
  ok('GET /estados: flujo libre, admin puede cerrar, transiciones vacías', est.flujo.libre === true && est.flujo.puede_cerrar === true && Array.isArray(est.transiciones) && est.transiciones.length === 0, JSON.stringify(est.flujo));
  x = await pedir('/api/estados', { cookie: T });
  ok('técnico: no puede cerrar; destinos limitados a en_curso, pausada, finalizada', x.s === 200 && x.j.flujo.puede_cerrar === false && x.j.flujo.destinos_asignadas.join(',') === 'en_curso,pausada,finalizada');
  x = await pedir('/api/estados', { cookie: RC });
  ok('recambista: tampoco cierra', x.s === 200 && x.j.flujo.puede_cerrar === false);

  // --- Tablero por defecto: sin cerradas, urgentes arriba, etiquetas y zona en las tarjetas -----------------
  x = await pedir('/api/kanban', { cookie: A });
  const kb = x.j;
  const n = Object.fromEntries(kb.fases.map((f) => [f.codigo, f.ots.length]));
  ok('Tablero: 5 verticales, dias_cerradas 0, sin columna cerrada', x.s === 200 && kb.dias_cerradas === 0 && kb.fases.map((f) => f.codigo).join(',') === VERTICALES.join(','), kb.fases.map((f) => f.codigo).join(','));
  ok(`Tablero: reparto del seed (pendiente 6 · planificada 3 · en curso 3 · pausada 4 · finalizada 2 = 18)`, n.pendiente_planificar === 6 && n.planificada === 3 && n.en_curso === 3 && n.pausada === 4 && n.finalizada === 2 && kb.total === 18, JSON.stringify(n));
  ok('Tablero: urgentes (prioridad 1) arriba en cada vertical', kb.fases.every((f) => f.ots.every((o, i) => i === 0 || o.prioridad >= f.ots[i - 1].prioridad)));
  const conEtiqueta = todas(kb).filter((o) => o.etiqueta);
  ok('Tablero: tarjetas con etiqueta, nombre y color; coherentes con su vertical (repuesto/presupuesto/num_pedido en pausada, sat_externo en en_curso, vb_factura en finalizada)', conEtiqueta.length === 6 && conEtiqueta.every((o) => o.etiqueta_nombre && o.etiqueta_color) && conEtiqueta.filter((o) => ['repuesto', 'presupuesto', 'num_pedido'].includes(o.etiqueta)).every((o) => o.fase === 'pausada') && conEtiqueta.find((o) => o.etiqueta === 'sat_externo').fase === 'en_curso' && conEtiqueta.find((o) => o.etiqueta === 'vb_factura').fase === 'finalizada', `n=${conEtiqueta.length}`);
  ok('Tablero: las tarjetas llevan cliente_zona y fecha_prevista (claves presentes)', todas(kb).every((o) => 'cliente_zona' in o && 'fecha_prevista' in o));
  x = await pedir('/api/kanban?cerradas=90', { cookie: A });
  ok('Tablero ?cerradas=90: columna cerrada con las 2 del seed (etiqueta facturada y fecha_cierre)', x.s === 200 && x.j.fases.find((f) => f.codigo === 'cerrada').ots.length === 2 && x.j.fases.find((f) => f.codigo === 'cerrada').ots.every((o) => o.etiqueta === 'facturada' && o.fecha_cierre));

  // --- Detalle: destinos por rol, bloques vacíos --------------------------------------------------------
  const pend = kb.fases.find((f) => f.codigo === 'pendiente_planificar').ots;
  const planT = kb.fases.find((f) => f.codigo === 'planificada').ots.find((o) => o.tecnico_nombre === 'Mikel Etxeberria');
  x = await pedir(`/api/ot/${pend[0].id}`, { cookie: A });
  ok('detalle (admin): 5 destinos (todas las demás verticales, cerrada incluida), bloques = [] y sin transiciones antiguas', x.s === 200 && x.j.destinos.map((d) => d.codigo).join(',') === 'planificada,en_curso,pausada,finalizada,cerrada' && Array.isArray(x.j.bloques) && x.j.bloques.length === 0 && x.j.transiciones === undefined, x.j.destinos && x.j.destinos.map((d) => d.codigo).join(','));
  x = await pedir(`/api/ot/${planT.id}`, { cookie: T });
  ok('detalle (técnico, su O.T. planificada): destinos en_curso, pausada, finalizada', x.s === 200 && x.j.destinos.map((d) => d.codigo).join(',') === 'en_curso,pausada,finalizada', x.j.destinos && x.j.destinos.map((d) => d.codigo).join(','));
  x = await pedir(`/api/ot/${pend[0].id}`, { cookie: G });
  ok('detalle (gerencia): sin destinos', x.s === 200 && x.j.destinos.length === 0);
  x = await pedir(`/api/ot/${pend[0].id}/estado`, { cookie: G, metodo: 'POST', body: { estado: 'planificada', version: pend[0].version } });
  ok('gerencia: POST /estado → 403', x.s === 403, `${x.s}`);

  // --- Técnico: en curso → pausada con etiqueta y nota; límites ------------------------------------------
  let ot = planT;
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'en_curso', nota: 'Empiezo', version: ot.version } });
  ok('técnico: planificada → en_curso', x.s === 200 && x.j.ot.estado === 'en_curso' && x.j.ot.etiqueta === null && x.j.cambio.anterior === 'planificada', x.t.slice(0, 120));
  ot = x.j.ot;
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'pausada', etiqueta: 'vb_factura', nota: 'x', version: ot.version } });
  ok('técnico: etiqueta de otra vertical (vb_factura en pausada) → 400', x.s === 400 && /vertical/.test(x.j.error), `${x.s} ${x.j && x.j.error}`);
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'pausada', etiqueta: 'repuesto', nota: 'Falta el cilindro tensor', version: ot.version } });
  ok('técnico: en_curso → pausada + etiqueta repuesto + nota → 200; historial "[Pendiente de repuesto] · nota"', x.s === 200 && x.j.ot.estado === 'pausada' && x.j.ot.etiqueta === 'repuesto' && x.j.ot.etiqueta_nombre === 'Pendiente de repuesto' && /^\[Pendiente de repuesto\] · Falta el cilindro tensor$/.test(x.j.ot.historial.at(-1).nota), x.j && x.j.ot && x.j.ot.historial.at(-1).nota);
  ot = x.j.ot;
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'cerrada', version: ot.version } });
  ok('técnico: → cerrada → 403 (no puede cerrar)', x.s === 403, `${x.s}`);
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'pendiente_planificar', version: ot.version } });
  ok('técnico: → pendiente_planificar → 403 (fuera de sus destinos)', x.s === 403 && /solo puede/.test(x.j.error), `${x.s}`);
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'en_curso', version: ot.version - 1 } });
  ok('técnico: versión vieja → 409', x.s === 409 && x.j.version === ot.version, `${x.s}`);
  x = await pedir('/api/kanban', { cookie: A });
  ok('Tablero: la O.T. pausada por el técnico aparece en Pausada con su etiqueta', x.j.fases.find((f) => f.codigo === 'pausada').ots.some((o) => o.id === ot.id && o.etiqueta === 'repuesto'));

  // --- Recambista: cambia la etiqueta sin mover (PUT) y devuelve a pendiente de planificar; no edita ni cierra ---
  x = await pedir(`/api/ot/${ot.id}`, { cookie: RC, metodo: 'PUT', body: { version: ot.version, etiqueta: 'espera_cliente' } });
  ok('recambista: PUT solo etiqueta (pausada: repuesto → espera_cliente) → 200 con historial "Etiqueta: Espera del cliente"', x.s === 200 && x.j.etiqueta === 'espera_cliente' && x.j.version === ot.version + 1 && x.j.historial.at(-1).nota === 'Etiqueta: Espera del cliente' && x.j.historial.at(-1).estado_anterior === 'pausada', x.t.slice(0, 160));
  ot = x.j;
  x = await pedir(`/api/ot/${ot.id}`, { cookie: RC, metodo: 'PUT', body: { version: ot.version, sintoma: 'no' } });
  ok('recambista: PUT con otros campos → 403', x.s === 403, `${x.s}`);
  x = await pedir(`/api/ot/${ot.id}`, { cookie: RC, metodo: 'PUT', body: { version: ot.version, etiqueta: 'albaran' } });
  ok('recambista: etiqueta de otra vertical → 400', x.s === 400, `${x.s}`);
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: RC, metodo: 'POST', body: { estado: 'cerrada', etiqueta: 'facturada', version: ot.version } });
  ok('recambista: → cerrada → 403', x.s === 403, `${x.s}`);
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: RC, metodo: 'POST', body: { estado: 'pendiente_planificar', nota: 'Repuesto recibido', version: ot.version } });
  ok('recambista: pausada → pendiente_planificar (repuesto recibido) → 200 y etiqueta a null', x.s === 200 && x.j.ot.estado === 'pendiente_planificar' && x.j.ot.etiqueta === null, x.t.slice(0, 120));
  ot = x.j.ot;
  x = await pedir('/api/tecnicos', { cookie: RC });
  ok('recambista: GET /tecnicos → 200 (filtro por operario del Tablero)', x.s === 200 && Array.isArray(x.j) && x.j.length >= 3, `${x.s}`);

  // --- Admin: planificada con técnico desde el modal, asignar ahora, cerrar con etiqueta, reabrir ------------
  const tecnicos = (await pedir('/api/tecnicos', { cookie: A })).j;
  const ane = tecnicos.find((t) => t.nombre === 'Ane Zubiaurre');
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'planificada', tecnico_id: ane.id, nota: 'Mañana a primera hora', version: ot.version } });
  ok('admin: → planificada con tecnico_id → técnico asignado y nota "Técnico: Ane … · nota"', x.s === 200 && x.j.ot.estado === 'planificada' && x.j.ot.tecnico_id === ane.id && /^Técnico: Ane Zubiaurre · Mañana a primera hora$/.test(x.j.ot.historial.at(-1).nota), x.j && x.j.ot && x.j.ot.historial.at(-1).nota);
  x = await pedir(`/api/ot/${ot.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'planificada', tecnico_id: 999999, version: x.j.ot.version } });
  ok('admin: mismo estado → 400', x.s === 400, `${x.s}`);
  const pend2 = pend[3]; // sin propuesta pendiente (pend[1] es la de Lezama, que ya la tiene)
  x = await pedir(`/api/ot/${pend2.id}/asignar`, { cookie: A, metodo: 'POST', body: { tecnico_id: ane.id, aprobar: true } });
  ok('admin: "Asignar ahora" sobre pendiente_planificar → planificada con técnico', x.s === 201 && x.j.ot.estado === 'planificada' && x.j.ot.tecnico_id === ane.id, x.t.slice(0, 120));
  x = await pedir('/api/ot?estado=finalizada&etiqueta=vb_factura&limite=5', { cookie: A });
  const vb = x.j.ots[0];
  ok('listado ?estado=finalizada&etiqueta=vb_factura → 1 del seed', x.s === 200 && x.j.total === 1 && vb.etiqueta === 'vb_factura');
  x = await pedir(`/api/ot/${vb.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'cerrada', etiqueta: 'facturada', nota: 'Factura 2026/0412', version: vb.version } });
  ok('admin: finalizada → cerrada + facturada → fecha_cierre de hoy, es_final, sin destinos para el técnico', x.s === 200 && x.j.ot.estado === 'cerrada' && x.j.ot.etiqueta === 'facturada' && String(x.j.ot.fecha_cierre).startsWith(hoy()) && x.j.ot.es_final === 1, x.t.slice(0, 120));
  const cerrada = x.j.ot;
  x = await pedir('/api/kanban', { cookie: A });
  ok('…y desaparece del Tablero', !todas(x.j).some((o) => o.id === cerrada.id));
  x = await pedir(`/api/ot/${cerrada.id}`, { cookie: A, metodo: 'PUT', body: { version: cerrada.version, sintoma: 'no' } });
  ok('cerrada: PUT → 400 (estado final)', x.s === 400, `${x.s}`);
  x = await pedir(`/api/ot/${cerrada.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'finalizada', etiqueta: 'albaran', nota: 'Reabierta: falta el albarán', version: cerrada.version } });
  ok('admin: reabrir cerrada → finalizada/albaran, fecha_cierre a null', x.s === 200 && x.j.ot.estado === 'finalizada' && x.j.ot.etiqueta === 'albaran' && x.j.ot.fecha_cierre === null, x.t.slice(0, 120));
  const cerradaSeed = (await pedir('/api/ot?abiertas=0&estado=cerrada&limite=5', { cookie: T })).j.ots[0];
  x = await pedir(`/api/ot/${cerradaSeed.id}/estado`, { cookie: T, metodo: 'POST', body: { estado: 'en_curso', version: cerradaSeed.version } });
  ok('técnico: reabrir una cerrada suya → 403', x.s === 403 && /cerrada/.test(x.j.error), `${x.s}`);
  x = await pedir(`/api/ot/${pend[2].id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'pausada', nota: 'sin motivo', version: pend[2].version } });
  ok('admin: → pausada sin etiqueta → 200 (el motivo lo exige la interfaz, no la API)', x.s === 200 && x.j.ot.etiqueta === null, `${x.s}`);
  x = await pedir(`/api/ot/${pend[2].id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'en_curso', etiqueta: 'noexiste', version: x.j.ot.version } });
  ok('etiqueta inexistente → 400', x.s === 400 && /no existe/.test(x.j.error), `${x.s}`);

  // --- Listado: filtros por vertical y etiqueta ---------------------------------------------------------------
  x = await pedir('/api/ot?fase=pausada&limite=50', { cookie: A });
  ok('listado ?fase=pausada: todas pausadas', x.s === 200 && x.j.total >= 3 && x.j.ots.every((o) => o.estado === 'pausada'), `total=${x.j.total}`);
  x = await pedir('/api/ot?etiqueta=-&limite=50', { cookie: A });
  ok('listado ?etiqueta=- : solo sin etiqueta', x.s === 200 && x.j.total > 5 && x.j.ots.every((o) => o.etiqueta === null), `total=${x.j.total}`);
  x = await pedir('/api/ot?etiqueta=num_pedido&limite=50', { cookie: A });
  ok('listado ?etiqueta=num_pedido: 1 del seed, en pausada, con etiqueta_nombre', x.s === 200 && x.j.total === 1 && x.j.ots[0].estado === 'pausada' && x.j.ots[0].etiqueta_nombre === 'Pendiente de nº de pedido');

  // --- Operativo: alcance = las que abre él + SAT + sin técnico; puede cerrar --------------------------------
  x = await pedir('/api/sesion', { cookie: OP });
  ok('operativo: rol operativo, alcance operativo, con ot.cerrar y kanban.ver', x.s === 200 && x.j.usuario.rol === 'operativo' && x.j.alcance === 'operativo' && x.j.permisos.includes('ot.cerrar') && x.j.permisos.includes('kanban.ver'));
  const satIds = new Set(tecnicos.filter((t) => t.rol === 'sat').map((t) => t.id));
  x = await pedir('/api/ot?abiertas=0&limite=100', { cookie: OP });
  ok('operativo: GET /ot → solo sin técnico o de SAT (ninguna abierta por él todavía)', x.s === 200 && x.j.total > 0 && x.j.ots.every((o) => o.tecnico_id === null || satIds.has(o.tecnico_id)), `total=${x.j.total}`);
  const listaClientes = (await pedir('/api/clientes?todos=1', { cookie: OP })).j;
  const cliente = Array.isArray(listaClientes) ? listaClientes[0] : listaClientes.filas[0];
  x = await pedir('/api/ot', { cookie: OP, metodo: 'POST', body: { cliente_id: cliente.id, sintoma: 'Abierta por el operativo', fecha_prevista: '2026-12-01' } });
  ok('operativo: POST /ot → 201 en pendiente_planificar con fecha_prevista', x.s === 201 && x.j.estado === 'pendiente_planificar' && x.j.fecha_prevista === '2026-12-01' && x.j.creado_por_nombre === 'Oihane Zabala', x.t.slice(0, 160));
  const otOp = x.j;
  x = await pedir(`/api/ot/${otOp.id}/asignar`, { cookie: OP, metodo: 'POST', body: { tecnico_id: ane.id, aprobar: true } });
  ok('operativo: asigna un técnico interno a su O.T. → planificada', x.s === 201 && x.j.ot.estado === 'planificada' && x.j.ot.tecnico_id === ane.id, `${x.s}`);
  x = await pedir(`/api/ot/${otOp.id}`, { cookie: OP });
  ok('operativo: sigue viendo su O.T. aunque la haga un técnico interno (la abrió él)', x.s === 200 && x.j.id === otOp.id, `${x.s}`);
  x = await pedir('/api/kanban', { cookie: OP });
  ok('operativo: su Tablero incluye la suya y ninguna de técnicos internos ajena', x.s === 200 && todas(x.j).some((o) => o.id === otOp.id) && todas(x.j).every((o) => o.id === otOp.id || o.tecnico_id === null || satIds.has(o.tecnico_id)));
  x = await pedir(`/api/ot/${otOp.id}/estado`, { cookie: OP, metodo: 'POST', body: { estado: 'cerrada', etiqueta: 'anulada', nota: 'Duplicada', version: x.j && (await pedir(`/api/ot/${otOp.id}`, { cookie: OP })).j.version } });
  ok('operativo: cierra su O.T. como anulada', x.s === 200 && x.j.ot.estado === 'cerrada' && x.j.ot.etiqueta === 'anulada', x.t.slice(0, 120));

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
