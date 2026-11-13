// Prueba HTTP de las jornadas, la O.T. comodín (F4-07) y las incidencias de fichaje (F4-08): POST /api/comodin/crono,
// GET /api/jornadas[/dia], /api/incidencias (pedir, aprobar, rechazar, retirar, corrección directa de la oficina), permisos por
// rol, solapes, y lo que cambia en GET /api/mi-dia y en el detalle de la O.T.
// Servidor en 5055 con la BD del seed recién generada (ciclo fichajes del lanzador).
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
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dia = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const HOY = dia(0);
// Los dos días laborables anteriores a hoy: D1 = el último, D2 = el anterior a ese.
const laborablesAntes = (n) => { const r = []; const d = new Date(); while (r.length < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) r.push(iso(d)); } return r; };
const [D1, D2] = laborablesAntes(2);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const H = 3600;

(async () => {
  let x, d;
  const A = await login('admin_prueba', 'clave-prueba-123');
  const R = await login('responsable1', 'prueba123');
  const G = await login('gerencia1', 'prueba123');
  const M = await login('tecnico1', 'prueba123');     // Mikel
  const AN = await login('tecnico2', 'prueba123');    // Ane
  const SAT = await login('sat1', 'prueba123');
  const RC = await login('recambista1', 'prueba123');
  const CO = await login('comercial1', 'prueba123');
  const buscar = async (q) => (await pedir(`/api/ot?abiertas=0&q=${encodeURIComponent(q)}`, { cookie: A })).j.ots[0];
  const miDia = async (cookie, q = '') => (await pedir(`/api/mi-dia${q}`, { cookie })).j;
  const comodin = (cookie, body) => pedir('/api/comodin/crono', { cookie, metodo: 'POST', body });
  const crono = (cookie, id, body) => pedir(`/api/ot/${id}/crono`, { cookie, metodo: 'POST', body });
  const incidencia = (cookie, body) => pedir('/api/incidencias', { cookie, metodo: 'POST', body });
  const resolver = (cookie, id, body) => pedir(`/api/incidencias/${id}/resolver`, { cookie, metodo: 'POST', body });
  const jornadaDe = async (cookie, tecnicoId, d0) => { const j = (await pedir(`/api/jornadas?desde=${d0}&hasta=${d0}&tecnico_id=${tecnicoId}`, { cookie })).j; return j.tecnicos[0].dias[0]; };
  const diaDe = async (cookie, d0, tecnicoId = null) => (await pedir(`/api/jornadas/dia?dia=${d0}${tecnicoId ? '&tecnico_id=' + tecnicoId : ''}`, { cookie })).j;
  const tecnicos = (await pedir('/api/tecnicos', { cookie: A })).j;
  const mikel = tecnicos.find((t) => /Mikel/.test(t.nombre)), ane = tecnicos.find((t) => /Ane/.test(t.nombre)), sat = tecnicos.find((t) => t.rol === 'sat');
  const torreta = await buscar('torreta');            // en curso, Mikel, bloque hoy 08:00
  const pluma = await buscar('pluma');                // en curso, Ane
  const rodillo = await buscar('rodillo');            // planificada, SAT
  const MES = HOY.slice(0, 7);

  // --- Permisos ---------------------------------------------------------------------------------------------------------
  x = await pedir('/api/sesion', { cookie: R });
  ok('responsable: tiene fichajes.ver y fichajes.gestionar', x.j.permisos.includes('fichajes.ver') && x.j.permisos.includes('fichajes.gestionar'));
  x = await pedir('/api/sesion', { cookie: G });
  ok('gerencia: fichajes.ver sin fichajes.gestionar', x.j.permisos.includes('fichajes.ver') && !x.j.permisos.includes('fichajes.gestionar'));
  x = await pedir('/api/sesion', { cookie: M });
  ok('técnico: ni fichajes.ver ni fichajes.gestionar (solo ve lo suyo con ot.tiempos)', !x.j.permisos.includes('fichajes.ver') && !x.j.permisos.includes('fichajes.gestionar') && x.j.permisos.includes('ot.tiempos'));
  ok('recambista y comercial: GET /jornadas → 403', (await pedir('/api/jornadas', { cookie: RC })).s === 403 && (await pedir('/api/jornadas', { cookie: CO })).s === 403);
  ok('…y GET /incidencias → 403', (await pedir('/api/incidencias', { cookie: RC })).s === 403 && (await pedir('/api/incidencias', { cookie: CO })).s === 403);
  x = await comodin(A, { accion: 'empezar', concepto: 'taller' });
  ok('oficina: POST /comodin/crono → 403 (solo fichan el técnico y el SAT)', x.s === 403, `${x.s}`);
  ok('sin sesión: GET /api/jornadas → 401', (await pedir('/api/jornadas')).s === 401);

  // --- Mi día: el comodín antes de usarlo -------------------------------------------------------------------------------
  d = await miDia(M);
  ok('mi-dia trae el comodín del mes (sin crear aún), los 4 conceptos que se fichan con cronómetro (sin las ausencias) y nada pendiente', d.comodin && d.comodin.mes === MES && d.comodin.codigo === `CM-${MES.replace('-', '')}-${String(mikel.id).padStart(3, '0')}` && d.comodin.creado === 0
    && d.comodin.conceptos.length === 4 && d.comodin.mes_seg === 0 && d.jornadas_bajas.length === 0 && d.incidencias_pendientes === 0 && d.resumen.comodin === 0, JSON.stringify(d.comodin).slice(0, 200));
  ok('…"Otros" pide nota y los demás no', d.comodin.conceptos.find((c) => c.codigo === 'otros').pide_nota === 1 && d.comodin.conceptos.find((c) => c.codigo === 'taller').pide_nota === 0);

  // --- Cronómetro del comodín ----------------------------------------------------------------------------------------------
  ok('empezar sin concepto → 400', (await comodin(M, { accion: 'empezar' })).s === 400);
  ok('concepto que no existe → 400', (await comodin(M, { accion: 'empezar', concepto: 'siesta' })).s === 400);
  ok('"otros" sin nota → 400', (await comodin(M, { accion: 'empezar', concepto: 'otros' })).s === 400);
  ok('acción desconocida → 400', (await comodin(M, { accion: 'trabajo', concepto: 'taller' })).s === 400);
  ok('parar sin nada en marcha → 400', (await comodin(M, { accion: 'parar' })).s === 400);
  x = await comodin(M, { accion: 'empezar', concepto: 'taller' });
  ok('empezar "taller" → 200: cronómetro del comodín, sin O.T., con el nombre del concepto', x.s === 200 && x.j.crono && x.j.crono.comodin === 1 && x.j.crono.ot_id === null && x.j.crono.numero === null && x.j.crono.concepto === 'taller'
    && x.j.crono.nombre === 'Trabajos de taller' && x.j.crono.tipo === 'comodin' && x.j.comodin.creado === 1, x.t.slice(0, 200));
  d = await miDia(M);
  ok('…mi-dia lo trae como cronómetro en marcha y ninguna tarea lo lleva', d.crono && d.crono.comodin === 1 && d.tareas.every((t) => t.crono === null) && d.comodin.creado === 1);
  ok('empezar el mismo concepto otra vez → 400', (await comodin(M, { accion: 'empezar', concepto: 'taller' })).s === 400);
  await dormir(1100);
  x = await comodin(M, { accion: 'empezar', concepto: 'otros', nota: 'Inventario de herramienta' });
  ok('cambiar a "otros" con nota → 200 y el cronómetro pasa al concepto nuevo', x.s === 200 && x.j.crono.concepto === 'otros' && x.j.crono.nombre === 'Otros' && x.j.comodin.mes_seg >= 1, x.t.slice(0, 160));
  x = await crono(M, torreta.id, { accion: 'trabajo' });
  ok('con el comodín en marcha, fichar en una O.T. → 409 con el comodín abierto', x.s === 409 && x.j.abierto && x.j.abierto.comodin === 1 && /comodín \(Otros\)/.test(x.j.error), x.t.slice(0, 200));
  x = await crono(M, torreta.id, { accion: 'trabajo', cerrar_otra: true });
  ok('…con cerrar_otra → 200: el cronómetro pasa a la O.T.', x.s === 200 && x.j.crono.ot_id === torreta.id && x.j.crono.comodin === 0 && x.j.crono.tipo === 'trabajo', x.t.slice(0, 160));
  x = await comodin(M, { accion: 'empezar', concepto: 'formacion' });
  ok('con una O.T. en marcha, empezar el comodín → 409 con la O.T. abierta', x.s === 409 && x.j.abierto && x.j.abierto.numero === torreta.numero && x.j.abierto.comodin === 0, x.t.slice(0, 200));
  ok('parar el comodín con el cronómetro en una O.T. → 400', (await comodin(M, { accion: 'parar' })).s === 400);
  await dormir(1100);
  x = await comodin(M, { accion: 'empezar', concepto: 'formacion', cerrar_otra: true });
  ok('…con cerrar_otra → 200', x.s === 200 && x.j.crono.concepto === 'formacion');
  x = await pedir(`/api/ot/${torreta.id}`, { cookie: A });
  ok('…la O.T. sigue en curso, con su tramo de trabajo cerrado y la anotación en el historial', x.j.estado === 'en_curso' && x.j.tiempos.length === 1 && x.j.tiempos[0].cierre === 'otra_ot' && x.j.tiempo.en_marcha === 0
    && x.j.historial.some((h) => /al pasar al comodín \(Formación\)/.test(h.nota || '')), JSON.stringify(x.j.tiempos));
  ok('…y los tramos del comodín no aparecen en la O.T.', x.j.tiempos.every((t) => t.tipo !== 'comodin'));
  await dormir(1100);
  x = await comodin(M, { accion: 'parar' });
  ok('parar el comodín → 200 sin cronómetro', x.s === 200 && x.j.crono === null && x.j.comodin.dia_seg >= 2, x.t.slice(0, 160));
  d = await miDia(M);
  ok('mi-dia: el resumen del día suma el comodín al total', d.crono === null && d.resumen.comodin >= 2 && d.resumen.trabajo >= 1 && d.resumen.total === d.resumen.comodin + d.resumen.trabajo + d.resumen.espera + d.resumen.desplazamiento, JSON.stringify(d.resumen));
  x = await comodin(SAT, { accion: 'empezar', concepto: 'taller' });
  ok('el SAT también puede imputar al comodín', x.s === 200 && x.j.crono.comodin === 1, `${x.s}`);
  await comodin(SAT, { accion: 'parar' });

  // --- Jornadas -------------------------------------------------------------------------------------------------------------
  x = await pedir('/api/jornadas', { cookie: M });
  ok('técnico: GET /jornadas → solo él, el mes en curso', x.s === 200 && x.j.tecnicos.length === 1 && x.j.tecnicos[0].id === mikel.id && x.j.desde === `${MES}-01` && x.j.hoy === HOY && x.j.horas_dia === 8 && x.j.puede_gestionar === 0, x.t.slice(0, 160));
  const hoyM = x.j.tecnicos[0].dias.find((c) => c.dia === HOY);
  ok('…hoy: estado "hoy", 4 tramos, comodín y trabajo, sin falta', hoyM && hoyM.estado === 'hoy' && hoyM.tramos === 4 && hoyM.comodin >= 2 && hoyM.trabajo >= 1 && hoyM.falta === 0 && hoyM.abierto === 0, JSON.stringify(hoyM));
  ok('…los días llevan si son laborables', x.j.dias.length >= 28 && x.j.dias.every((c) => c.laborable === (([0, 6].includes(new Date(c.dia + 'T12:00:00').getDay())) ? 0 : 1)));
  x = await pedir(`/api/jornadas?tecnico_id=${ane.id}`, { cookie: M });
  ok('técnico pidiendo las de otro → recibe las suyas', x.s === 200 && x.j.tecnicos.length === 1 && x.j.tecnicos[0].id === mikel.id);
  x = await pedir('/api/jornadas', { cookie: G });
  ok('gerencia: ve a todos los técnicos y al SAT, sin poder gestionar', x.s === 200 && x.j.tecnicos.some((t) => t.id === mikel.id) && x.j.tecnicos.some((t) => t.id === ane.id) && x.j.tecnicos.some((t) => t.rol === 'sat') && x.j.puede_gestionar === 0, `${x.j.tecnicos.length}`);
  x = await pedir('/api/jornadas', { cookie: R });
  ok('responsable: puede gestionar', x.s === 200 && x.j.puede_gestionar === 1);
  ok('mes mal escrito → 400', (await pedir('/api/jornadas?mes=2026-13', { cookie: A })).s === 400);
  ok('rango de más de 62 días → 400', (await pedir('/api/jornadas?desde=2026-01-01&hasta=2026-06-30', { cookie: A })).s === 400);
  ok('desde > hasta → 400', (await pedir(`/api/jornadas?desde=${HOY}&hasta=${D1}`, { cookie: A })).s === 400);
  d = await diaDe(M, HOY);
  ok('técnico: su día con los tramos en orden (comodín y O.T.), conceptos y O.T. imputables', d.tramos.length === 4 && d.tramos[0].concepto_nombre === 'Trabajos de taller' && d.tramos[1].nota === 'Inventario de herramienta'
    && d.tramos[2].numero === torreta.numero && d.tramos[2].cliente_nombre && d.tramos[3].concepto === 'formacion' && d.ots.some((o) => o.id === torreta.id) && d.conceptos.length === 7 && d.conceptos.filter((c) => c.ausencia).map((c) => c.codigo).join() === 'vacaciones,baja,festivo' && d.puede_gestionar === 0, JSON.stringify(d.tramos.map((t) => [t.tipo, t.concepto, t.numero])));
  ok('oficina: el día de un técnico sin decir cuál → 400', (await pedir(`/api/jornadas/dia?dia=${HOY}`, { cookie: A })).s === 400);
  ok('…de un técnico que no existe → 404', (await pedir(`/api/jornadas/dia?dia=${HOY}&tecnico_id=99999`, { cookie: A })).s === 404);
  d = await diaDe(R, HOY, mikel.id);
  ok('responsable: el día de Mikel, pudiendo gestionar', d.tramos.length === 4 && d.tecnico.id === mikel.id && d.puede_gestionar === 1);
  ok('día mal escrito → 400', (await pedir(`/api/jornadas/dia?dia=ayer&tecnico_id=${mikel.id}`, { cookie: A })).s === 400);

  // --- Corrección directa de la oficina: así se crean fichajes de días pasados --------------------------------------------
  x = await incidencia(G, { accion: 'anadir', tecnico_id: mikel.id, dia: D2, ot_id: torreta.id, tipo: 'trabajo', inicio: '08:00', fin: '12:00', motivo: 'x' });
  ok('gerencia: corregir un fichaje → 403', x.s === 403, `${x.s}`);
  x = await incidencia(A, { accion: 'anadir', dia: D2, ot_id: torreta.id, tipo: 'trabajo', inicio: '08:00', fin: '12:00', motivo: 'x' });
  ok('oficina sin decir de qué técnico → 400', x.s === 400, `${x.s}`);
  x = await incidencia(A, { accion: 'anadir', tecnico_id: mikel.id, dia: D2, ot_id: torreta.id, tipo: 'trabajo', inicio: '08:00', fin: '12:00', motivo: 'No fichó: parte en papel' });
  const dir1 = x.j && x.j.incidencia;
  ok('administrativo añade 4 h de trabajo a Mikel anteayer → 201, aprobada y aplicada en el momento', x.s === 201 && dir1.estado === 'aprobada' && dir1.directa === 1 && dir1.tramo_id > 0 && dir1.resuelto_por_nombre && dir1.ot_numero === torreta.numero
    && /trabajo .* 08:00–12:00/.test(dir1.propuesta_texto), x.t.slice(0, 240));
  let c = await jornadaDe(A, mikel.id, D2);
  ok('…ese día pasa a "bajo": 4 h fichadas, faltan 4 h', c.estado === 'bajo' && c.trabajo === 4 * H && c.total === 4 * H && c.falta === 4 * H && c.manuales === 1, JSON.stringify(c));
  c = await jornadaDe(A, mikel.id, D1);
  ok('…y el laborable siguiente, sin fichar: faltan 8 h', c.estado === 'sin_fichar' && c.falta === 8 * H, JSON.stringify(c));
  d = await miDia(M);
  ok('mi-dia avisa a Mikel de los dos días que no llegan a la jornada', d.jornadas_bajas.length === 2 && d.jornadas_bajas[0].dia === D2 && d.jornadas_bajas[0].estado === 'bajo' && d.jornadas_bajas[0].falta === 4 * H && d.jornadas_bajas[1].dia === D1 && d.jornadas_bajas[1].estado === 'sin_fichar', JSON.stringify(d.jornadas_bajas));
  x = await pedir(`/api/ot/${torreta.id}`, { cookie: A });
  ok('la O.T. recibe el tramo manual y queda anotado en su historial', x.j.tiempos.some((t) => t.origen === 'manual' && t.incidencia_id === dir1.id && t.cierre === 'manual') && x.j.historial.some((h) => /Fichaje añadido por corrección \(incidencia nº \d+\)/.test(h.nota || '') && /parte en papel/.test(h.nota)), JSON.stringify(x.j.tiempos.map((t) => t.origen)));
  x = await incidencia(A, { accion: 'anadir', tecnico_id: sat.id, dia: D2, ot_id: rodillo.id, tipo: 'trabajo', inicio: '09:00', fin: '10:00', motivo: 'Aviso del SAT por teléfono' });
  c = await jornadaDe(A, sat.id, D2);
  ok('al SAT no se le exige jornada: 1 h en un día pasado → "ok", sin falta', x.s === 201 && c.estado === 'ok' && c.falta === 0 && c.total === H, JSON.stringify(c));
  ok('…ni avisos en su mi-dia', (await miDia(SAT)).jornadas_bajas.length === 0);
  ok('Ane no ha fichado nunca: sus días pasados no cuentan como bajos', (await jornadaDe(A, ane.id, D1)).estado === 'libre' && (await miDia(AN)).jornadas_bajas.length === 0);

  // --- El técnico pide correcciones: validaciones ---------------------------------------------------------------------------
  const base = { accion: 'anadir', dia: D2, ot_id: torreta.id, tipo: 'trabajo', inicio: '13:00', fin: '14:00', motivo: 'Se me olvidó fichar' };
  ok('sin motivo → 400', (await incidencia(M, { ...base, motivo: ' ' })).s === 400);
  ok('acción desconocida → 400', (await incidencia(M, { ...base, accion: 'borrar' })).s === 400);
  ok('fin anterior al inicio → 400', (await incidencia(M, { ...base, inicio: '14:00', fin: '13:00' })).s === 400);
  ok('hora mal escrita → 400', (await incidencia(M, { ...base, inicio: '25:00' })).s === 400);
  ok('día mal escrito → 400', (await incidencia(M, { ...base, dia: '2026-02-30' })).s === 400);
  ok('tiempo que aún no ha pasado → 400', (await incidencia(M, { ...base, dia: dia(1) })).s === 400);
  ok('sin tipo → 400', (await incidencia(M, { ...base, tipo: undefined })).s === 400);
  ok('a una O.T. que no es suya → 404', (await incidencia(M, { ...base, ot_id: pluma.id })).s === 404);
  ok('al comodín sin concepto → 400', (await incidencia(M, { accion: 'anadir', dia: D2, comodin: true, inicio: '13:00', fin: '14:00', motivo: 'x' })).s === 400);
  x = await incidencia(M, { ...base, inicio: '11:00', fin: '12:30' });
  ok('solapado con otro fichaje suyo → 409 que dice con cuál', x.s === 409 && /Se solapa con otro fichaje: 08:00–12:00, O\.T\. /.test(x.j.error), x.t.slice(0, 160));
  ok('modificar un fichaje que no es suyo → 404', (await incidencia(AN, { accion: 'modificar', tramo_id: dir1.tramo_id, inicio: '08:30', motivo: 'x' })).s === 404);

  // --- Pedir, retirar, aprobar ----------------------------------------------------------------------------------------------
  x = await incidencia(M, { ...base, inicio: '12:00', fin: '13:00' });
  const borde = x.j && x.j.incidencia;
  ok('pegado al fichaje anterior (12:00–13:00) → 201 pendiente, sin aplicar', x.s === 201 && borde.estado === 'pendiente' && borde.directa === 0 && borde.tramo_id === null && borde.solicitante_id === mikel.id && (await jornadaDe(A, mikel.id, D2)).total === 4 * H, x.t.slice(0, 200));
  ok('la oficina ve 1 pendiente; Ane, ninguna', (await pedir('/api/incidencias/pendientes', { cookie: R })).j.n === 1 && (await pedir('/api/incidencias/pendientes', { cookie: AN })).j.n === 0 && (await pedir('/api/incidencias/pendientes', { cookie: M })).j.n === 1);
  ok('Ane no puede retirar la de Mikel → 404', (await pedir(`/api/incidencias/${borde.id}`, { cookie: AN, metodo: 'DELETE' })).s === 404);
  ok('el técnico no puede resolverla → 403', (await resolver(M, borde.id, { aprobar: true })).s === 403);
  x = await pedir(`/api/incidencias/${borde.id}`, { cookie: M, metodo: 'DELETE' });
  ok('Mikel la retira → anulada', x.s === 200 && x.j.incidencia.estado === 'anulada', x.t.slice(0, 120));
  ok('…retirarla otra vez → 409, y aprobarla ya no se puede → 409', (await pedir(`/api/incidencias/${borde.id}`, { cookie: M, metodo: 'DELETE' })).s === 409 && (await resolver(R, borde.id, { aprobar: true })).s === 409);

  x = await incidencia(M, { accion: 'anadir', dia: D2, comodin: true, concepto: 'formacion', inicio: '13:00', fin: '17:00', motivo: 'Curso de carretillero, no llevaba la tablet' });
  const curso = x.j && x.j.incidencia;
  ok('Mikel pide añadir 4 h de formación al comodín → 201 pendiente', x.s === 201 && curso.estado === 'pendiente' && curso.propuesta.comodin === 1 && /comodín \(Formación\) .* 13:00–17:00/.test(curso.propuesta_texto) && curso.ot_id === null, x.t.slice(0, 240));
  d = await miDia(M);
  c = await jornadaDe(A, mikel.id, D2);
  ok('…mi-dia y la jornada del día la cuentan como pendiente', d.incidencias_pendientes === 1 && c.pendientes === 1 && c.estado === 'bajo');
  x = await pedir('/api/incidencias', { cookie: R });
  ok('responsable: la lista de pendientes la trae con el técnico, el motivo y la propuesta', x.s === 200 && x.j.incidencias.length === 1 && x.j.incidencias[0].id === curso.id && x.j.incidencias[0].tecnico_nombre === mikel.nombre && /Curso/.test(x.j.incidencias[0].motivo) && x.j.pendientes === 1 && x.j.puede_gestionar === 1, x.t.slice(0, 200));
  ok('…Ane no ve la de Mikel; Mikel sí', (await pedir('/api/incidencias', { cookie: AN })).j.incidencias.length === 0 && (await pedir('/api/incidencias', { cookie: M })).j.incidencias.length === 1);
  ok('resolver sin decir si se aprueba → 400', (await resolver(R, curso.id, {})).s === 400);
  ok('gerencia no puede resolver → 403', (await resolver(G, curso.id, { aprobar: true })).s === 403);
  const etagAntes = (await pedir('/api/mi-dia', { cookie: M })).h.get('etag');
  x = await resolver(R, curso.id, { aprobar: true });
  ok('el responsable la aprueba → aprobada, con el tramo creado', x.s === 200 && x.j.incidencia.estado === 'aprobada' && x.j.incidencia.tramo_id > 0 && x.j.incidencia.resuelto_por_nombre && x.j.pendientes === 0, x.t.slice(0, 200));
  c = await jornadaDe(A, mikel.id, D2);
  ok('…el día llega a las 8 h: "ok", sin falta, con 4 h de comodín', c.estado === 'ok' && c.falta === 0 && c.comodin === 4 * H && c.total === 8 * H && c.pendientes === 0, JSON.stringify(c));
  x = await pedir('/api/mi-dia', { cookie: M, headers: { 'if-none-match': etagAntes } });
  ok('…mi-dia cambia de ETag y ya solo avisa de un día', x.s === 200 && x.j.jornadas_bajas.length === 1 && x.j.jornadas_bajas[0].dia === D1 && x.j.incidencias_pendientes === 0, `${x.s}`);
  d = await diaDe(M, D2);
  const tOT = d.tramos.find((t) => t.ot_id === torreta.id), tCom = d.tramos.find((t) => t.comodin_id);
  ok('…el día tiene el tramo de la O.T. y el del comodín, los dos manuales, y sus incidencias', d.tramos.length === 2 && tOT && tCom && tCom.origen === 'manual' && tCom.concepto_nombre === 'Formación' && tCom.segundos === 4 * H && d.incidencias.length >= 2, JSON.stringify(d.tramos.map((t) => [t.tipo, t.origen])));
  ok('aprobarla otra vez → 409', (await resolver(R, curso.id, { aprobar: true })).s === 409);

  // --- Modificar: rechazo y aprobación -----------------------------------------------------------------------------------
  ok('una corrección que no cambia nada → 400', (await incidencia(M, { accion: 'modificar', tramo_id: tOT.id, inicio: '08:00', fin: '12:00', motivo: 'x' })).s === 400);
  ok('modificar hasta solaparse con el comodín → 409', (await incidencia(M, { accion: 'modificar', tramo_id: tOT.id, fin: '13:30', motivo: 'x' })).s === 409);
  x = await incidencia(M, { accion: 'modificar', tramo_id: tOT.id, inicio: '08:30', motivo: 'Empecé más tarde' });
  const mod1 = x.j && x.j.incidencia;
  ok('Mikel pide mover el inicio a las 08:30 → 201 pendiente, con el antes y la propuesta', x.s === 201 && mod1.estado === 'pendiente' && mod1.tramo_id === tOT.id && mod1.antes.inicio === `${D2} 08:00:00` && mod1.propuesta.inicio === `${D2} 08:30:00` && mod1.propuesta.fin === `${D2} 12:00:00` && mod1.ot_id === torreta.id, x.t.slice(0, 240));
  ok('otra incidencia sobre el mismo fichaje → 409', (await incidencia(M, { accion: 'quitar', tramo_id: tOT.id, motivo: 'x' })).s === 409);
  ok('…tampoco la oficina puede corregirlo mientras esté pendiente → 409', (await incidencia(R, { accion: 'quitar', tecnico_id: mikel.id, tramo_id: tOT.id, motivo: 'x' })).s === 409);
  ok('rechazar sin respuesta → 400', (await resolver(R, mod1.id, { aprobar: false })).s === 400);
  x = await resolver(R, mod1.id, { aprobar: false, respuesta: 'El parte del cliente dice 08:00' });
  d = await diaDe(M, D2);
  ok('rechazada con respuesta: el fichaje no cambia', x.s === 200 && x.j.incidencia.estado === 'rechazada' && x.j.incidencia.respuesta === 'El parte del cliente dice 08:00' && d.tramos.find((t) => t.id === tOT.id).inicio === `${D2} 08:00:00` && d.tramos.find((t) => t.id === tOT.id).incidencia_pendiente === null, x.t.slice(0, 200));
  x = await incidencia(M, { accion: 'modificar', tramo_id: tOT.id, fin: '11:00', tipo: 'espera', motivo: 'En realidad estuve esperando al encargado' });
  const mod2 = x.j && x.j.incidencia;
  x = await resolver(A, mod2.id, { aprobar: true });
  d = await diaDe(M, D2);
  c = await jornadaDe(A, mikel.id, D2);
  const tras = d.tramos.find((t) => t.id === tOT.id);
  ok('aprobada: el tramo pasa a espera 08:00–11:00 y el día baja a 7 h (falta 1 h)', x.s === 200 && tras.tipo === 'espera' && tras.fin === `${D2} 11:00:00` && tras.origen === 'manual' && tras.incidencia_id === mod2.id && c.espera === 3 * H && c.trabajo === 0 && c.estado === 'bajo' && c.falta === H, JSON.stringify(tras));
  x = await pedir(`/api/ot/${torreta.id}`, { cookie: A });
  ok('…el historial de la O.T. guarda el antes y el después', x.j.historial.some((h) => /Fichaje corregido \(incidencia nº \d+\): trabajo \d\d\/\d\d 08:00–12:00 → espera de acceso \d\d\/\d\d 08:00–11:00/.test(h.nota || '')), JSON.stringify(x.j.historial.map((h) => h.nota)).slice(0, 300));

  // --- Quitar -----------------------------------------------------------------------------------------------------------
  x = await incidencia(M, { accion: 'quitar', tramo_id: tCom.id, motivo: 'El curso fue otro día' });
  const quita = x.j && x.j.incidencia;
  x = await resolver(R, quita.id, { aprobar: true });
  d = await diaDe(R, D2, mikel.id);
  ok('quitar el tramo del comodín, aprobado: desaparece y la incidencia guarda cómo era', x.s === 200 && x.j.incidencia.estado === 'aprobada' && d.tramos.length === 1 && x.j.incidencia.antes.concepto === 'formacion' && /13:00–17:00/.test(x.j.incidencia.antes_texto), x.t.slice(0, 200));

  // --- Un fichaje en marcha no se corrige -----------------------------------------------------------------------------------
  await crono(M, torreta.id, { accion: 'trabajo' });
  d = await diaDe(M, HOY);
  const enMarcha = d.tramos.find((t) => !t.fin);
  ok('con el cronómetro en marcha, pedir corregir ese tramo → 400', enMarcha && (await incidencia(M, { accion: 'modificar', tramo_id: enMarcha.id, inicio: '07:00', motivo: 'x' })).s === 400);
  ok('…y la jornada de hoy lo marca como abierto', (await jornadaDe(A, mikel.id, HOY)).abierto === 1);
  await crono(M, torreta.id, { accion: 'parar' });

  // --- Corrección directa de la oficina sobre un tramo existente, por número de O.T. -----------------------------------------
  x = await incidencia(R, { accion: 'anadir', tecnico_id: ane.id, dia: D1, ot_numero: pluma.numero, tipo: 'desplazamiento', inicio: '07:30', fin: '08:15', motivo: 'Desplazamiento sin fichar' });
  ok('responsable añade un desplazamiento a Ane indicando el número de la O.T. → 201 aprobada', x.s === 201 && x.j.incidencia.estado === 'aprobada' && x.j.incidencia.ot_id === pluma.id, x.t.slice(0, 160));
  const tAne = x.j.incidencia.tramo_id;
  x = await incidencia(R, { accion: 'modificar', tecnico_id: ane.id, tramo_id: tAne, fin: '08:30', motivo: 'Llegó más tarde' });
  c = await jornadaDe(A, ane.id, D1);
  ok('…y lo corrige directamente: 1 h de desplazamiento; ahora a Ane sí le cuenta la jornada', x.s === 201 && x.j.incidencia.estado === 'aprobada' && c.desplazamiento === H && c.estado === 'bajo' && c.falta === 7 * H, JSON.stringify(c));
  ok('número de O.T. que no existe → 404', (await incidencia(R, { accion: 'anadir', tecnico_id: ane.id, dia: D1, ot_numero: '9999999999', tipo: 'trabajo', inicio: '10:00', fin: '11:00', motivo: 'x' })).s === 404);
  ok('tramo de otro técnico → 404', (await incidencia(R, { accion: 'quitar', tecnico_id: mikel.id, tramo_id: tAne, motivo: 'x' })).s === 404);

  // --- Listados ---------------------------------------------------------------------------------------------------------
  x = await pedir('/api/incidencias?estado=resueltas', { cookie: A });
  ok('resueltas: aprobadas, rechazada y anulada, ninguna pendiente', x.s === 200 && x.j.incidencias.length === 9 && x.j.incidencias.every((i) => i.estado !== 'pendiente') && ['aprobada', 'rechazada', 'anulada'].every((e) => x.j.incidencias.some((i) => i.estado === e)), `${x.j.incidencias.length}: ${x.j.incidencias.map((i) => i.estado).join(',')}`);
  x = await pedir(`/api/incidencias?estado=todas&tecnico_id=${ane.id}`, { cookie: A });
  ok('filtradas por técnico: las 2 de Ane', x.s === 200 && x.j.incidencias.length === 2 && x.j.incidencias.every((i) => i.tecnico_id === ane.id));
  ok('estado desconocido → 400', (await pedir('/api/incidencias?estado=abiertas', { cookie: A })).s === 400);
  x = await pedir(`/api/jornadas?desde=${D2}&hasta=${HOY}`, { cookie: A });
  const tm = x.j.tecnicos.find((t) => t.id === mikel.id);
  ok('totales del rango para Mikel: días bajos, falta y espera', tm.totales.dias_bajos === 2 && tm.totales.falta === 13 * H && tm.totales.espera === 3 * H && tm.primer_fichaje === D2, JSON.stringify(tm.totales));

  // --- Ausencias: vacaciones, baja y festivo se imputan al día, no con el cronómetro ----------------------------------------
  x = await comodin(M, { accion: 'empezar', concepto: 'vacaciones' });
  ok('una ausencia no se ficha con el cronómetro → 400', x.s === 400 && /es una ausencia/.test(x.j.error), x.t.slice(0, 160));
  x = await incidencia(R, { accion: 'anadir', tecnico_id: mikel.id, dia: D1, comodin: true, concepto: 'vacaciones', inicio: '08:00', fin: '16:00', motivo: 'Día de vacaciones' });
  c = await jornadaDe(A, mikel.id, D1);
  ok('la oficina imputa 8 h de vacaciones al día sin fichar → el día cuadra ("ok", sin falta)', x.s === 201 && x.j.incidencia.estado === 'aprobada' && /comodín \(Vacaciones\)/.test(x.j.incidencia.propuesta_texto) && c.estado === 'ok' && c.falta === 0 && c.comodin === 8 * H, JSON.stringify(c));
  ok('…y Mikel deja de tener ese día en el aviso', !(await miDia(M)).jornadas_bajas.some((b) => b.dia === D1));
  x = await incidencia(M, { accion: 'anadir', dia: dia(1), comodin: true, concepto: 'festivo', inicio: '08:00', fin: '16:00', motivo: 'Festivo local' });
  ok('una ausencia sí se puede pedir para un día que aún no ha llegado → 201 pendiente', x.s === 201 && x.j.incidencia.estado === 'pendiente' && x.j.incidencia.propuesta.concepto === 'festivo', x.t.slice(0, 160));
  ok('…pero un concepto de trabajo, no → 400', (await incidencia(M, { accion: 'anadir', dia: dia(1), comodin: true, concepto: 'formacion', inicio: '08:00', fin: '16:00', motivo: 'x' })).s === 400);
  x = await resolver(R, x.j.incidencia.id, { aprobar: true });
  ok('…aprobada: el día futuro ya lleva sus 8 h de festivo', x.s === 200 && (await jornadaDe(A, mikel.id, dia(1))).comodin === 8 * H && (await jornadaDe(A, mikel.id, dia(1))).estado === 'futuro');

  // --- El resto de la app sigue en pie con tramos sin O.T. ---------------------------------------------------------------
  ok('Tablero y Planificador responden con tramos del comodín en la base', (await pedir('/api/kanban', { cookie: A })).s === 200 && (await pedir(`/api/planificador?desde=${HOY}&hasta=${HOY}`, { cookie: A })).s === 200);

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
