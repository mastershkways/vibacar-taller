// Prueba HTTP del backend del técnico (F4-05 + F4-06): GET /api/mi-dia, cronómetro por tramos (POST /api/ot/:id/crono), checklist
// (PUT /api/ot/:id/checklist/:pid), requisitos para finalizar (tiempo de trabajo + checklist; la oficina puede forzar), cierre de
// tramos al pausar o finalizar, alcance del técnico con varios técnicos en una O.T. y datos de cronómetro en Tablero y Planificador.
// Servidor en 5055 con la BD del seed recién generada (ciclo tecnico del lanzador).
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
const HOY = dia(0), MANANA = dia(1);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let x;
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
  const crono = (cookie, id, body) => pedir(`/api/ot/${id}/crono`, { cookie, metodo: 'POST', body });
  const estado = (cookie, id, body) => pedir(`/api/ot/${id}/estado`, { cookie, metodo: 'POST', body });
  const tecnicos = (await pedir('/api/tecnicos', { cookie: A })).j;
  const mikel = tecnicos.find((t) => /Mikel/.test(t.nombre)), ane = tecnicos.find((t) => /Ane/.test(t.nombre));

  const torreta = await buscar('torreta');            // en curso, Mikel, bloque hoy 08:00
  const pluma = await buscar('pluma');                // en curso, Ane, bloque hoy
  const freno = await buscar('Freno de estacionamiento'); // planificada, Mikel, bloque mañana
  const rodillo = await buscar('rodillo');            // planificada, preventivo, SAT, bloque mañana
  const garaio = await buscar('No arranca en fr');    // pendiente de planificar, correctivo
  const rev500 = await buscar('Revisión 500 h');      // pendiente de planificar, preventivo
  const luces = await buscar('Luces de trabajo');     // pendiente de planificar
  const cerrada = (await pedir('/api/ot?abiertas=0&estado=cerrada&limite=1', { cookie: A })).j.ots[0];

  // --- Permisos y forma de GET /mi-dia -------------------------------------------------------------------------------
  x = await pedir('/api/mi-dia', { cookie: M });
  const d0 = x.j;
  const etag = x.h.get('etag');
  ok('técnico: GET /mi-dia → 200 con hoy, su nombre y la jornada', x.s === 200 && d0.hoy === HOY && d0.dia === HOY && d0.tecnico.id === mikel.id && d0.jornada.horas_dia === 8, x.t.slice(0, 120));
  ok('…una tarea: la O.T. en curso con su bloque de hoy a las 08:00 (2 h), sin cronómetro', d0.tareas.length === 1 && d0.tareas[0].id === torreta.id && d0.tareas[0].grupo === 'en_curso' && d0.tareas[0].bloque && d0.tareas[0].bloque.hora_inicio === '08:00' && d0.tareas[0].bloque.duracion_min === 120 && d0.tareas[0].crono === null && d0.crono === null, JSON.stringify(d0.tareas.map((t) => [t.numero, t.grupo])));
  ok('…la tarea trae cliente, zona, máquina, tiempos a cero y checklist vacío (correctivo)', d0.tareas[0].cliente_nombre && d0.tareas[0].cliente_zona === 'Bizkaia' && d0.tareas[0].maquina_marca && d0.tareas[0].tiempo.total === 0 && d0.tareas[0].tiempo.previsto_min === 120 && d0.tareas[0].checklist.total === 0, JSON.stringify(d0.tareas[0].tiempo));
  ok('…próximos días: su planificada de mañana; resumen del día a cero con 120 min previstos', d0.proximos.length === 1 && d0.proximos[0].id === freno.id && d0.proximos[0].dia === MANANA && d0.resumen.total === 0 && d0.resumen.previsto_min === 120 && d0.resumen.horas_dia === 8, JSON.stringify(d0.resumen));
  x = await pedir('/api/mi-dia', { cookie: M, headers: { 'if-none-match': etag } });
  ok('GET /mi-dia con If-None-Match → 304', x.s === 304, `${x.s}`);
  ok('recambista: GET /mi-dia → 403', (await pedir('/api/mi-dia', { cookie: RC })).s === 403);
  ok('comercial: GET /mi-dia → 403', (await pedir('/api/mi-dia', { cookie: CO })).s === 403);
  ok('gerencia sin tecnico_id → 400', (await pedir('/api/mi-dia', { cookie: G })).s === 400);
  x = await pedir(`/api/mi-dia?tecnico_id=${ane.id}`, { cookie: G });
  ok('gerencia con tecnico_id → 200 con el día de Ane', x.s === 200 && x.j.tecnico.id === ane.id && x.j.tareas.length === 1 && x.j.tareas[0].id === pluma.id, `${x.s}`);
  ok('tecnico_id que no es técnico → 404', (await pedir('/api/mi-dia?tecnico_id=1', { cookie: R })).s === 404);
  ok('dia no válido → 400', (await pedir('/api/mi-dia?dia=2026-02-31', { cookie: M })).s === 400);
  x = await pedir(`/api/mi-dia?dia=${MANANA}`, { cookie: M });
  ok('?dia=mañana: la planificada de mañana sale como tarea de ese día', x.s === 200 && x.j.dia === MANANA && x.j.tareas.some((t) => t.id === freno.id && t.grupo === 'hoy'), JSON.stringify(x.j.tareas.map((t) => [t.numero, t.grupo])));

  // --- La oficina planifica dos O.T. para hoy: aparecen en su día, por hora ------------------------------------------------
  x = await pedir(`/api/ot/${rev500.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: HOY, hora_inicio: '10:00', duracion_min: 60 } });
  const bRev = x.j.bloque;
  x = await pedir(`/api/ot/${garaio.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: HOY, hora_inicio: '12:00' } });
  const bGaraio = x.j.bloque;
  let d = await miDia(M);
  ok('tras planificar: 3 tareas (en curso primero, luego las de hoy por hora)', d.tareas.length === 3 && d.tareas.map((t) => t.id).join() === [torreta.id, rev500.id, garaio.id].join() && d.tareas[1].grupo === 'hoy' && d.tareas[1].bloque.hora_inicio === '10:00', JSON.stringify(d.tareas.map((t) => [t.numero, t.grupo, t.bloque && t.bloque.hora_inicio])));
  ok('el preventivo trae su checklist (plantilla genérica de 4 puntos, 0 respondidos)', d.tareas[1].tipo === 'preventivo' && d.tareas[1].checklist.total === 4 && d.tareas[1].checklist.respondidos === 0, JSON.stringify(d.tareas[1].checklist));
  ok('resumen: 300 min previstos (120 + 60 + 120)', d.resumen.previsto_min === 300, `${d.resumen.previsto_min}`);

  // --- Cronómetro: desplazamiento → espera → trabajo ---------------------------------------------------------------------
  x = await crono(M, garaio.id, { accion: 'desplazamiento' });
  ok('crono desplazamiento en una planificada → 200, la O.T. pasa a en curso', x.s === 200 && x.j.ot.estado === 'en_curso' && x.j.crono.tipo === 'desplazamiento' && x.j.crono.ot_id === garaio.id && x.j.crono.numero === garaio.numero && x.j.crono.otro_dia === 0, x.t.slice(0, 160));
  ok('…historial "Cronómetro: desplazamiento" (planificada → en curso)', x.j.ot.historial.at(-1).nota === 'Cronómetro: desplazamiento' && x.j.ot.historial.at(-1).estado_anterior === 'planificada' && x.j.ot.historial.at(-1).estado_nuevo === 'en_curso', x.j.ot.historial.at(-1).nota);
  ok('…un tramo abierto, enlazado con su bloque de hoy, y tiempo en marcha', x.j.ot.tiempos.length === 1 && x.j.ot.tiempos[0].fin === null && x.j.ot.tiempos[0].tipo === 'desplazamiento' && x.j.ot.tiempos[0].bloque_id === bGaraio.id && x.j.ot.tiempos[0].tecnico_id === mikel.id && x.j.ot.tiempo.en_marcha === 1 && String(x.j.ot.tiempos[0].inicio).startsWith(HOY), JSON.stringify(x.j.ot.tiempos[0]));
  x = await crono(M, garaio.id, { accion: 'desplazamiento' });
  ok('misma fase otra vez → 400', x.s === 400, `${x.s}`);
  ok('accion desconocida → 400 y sin accion → 400', (await crono(M, garaio.id, { accion: 'siesta' })).s === 400 && (await crono(M, garaio.id, {})).s === 400);
  await dormir(1100);
  x = await crono(M, garaio.id, { accion: 'espera', nota: 'Portón cerrado' });
  ok('cambio a espera: cierra el desplazamiento (cierre = cambio, ≥ 1 s) y abre la espera en el mismo instante', x.s === 200 && x.j.ot.tiempos.length === 2 && x.j.ot.tiempos[0].cierre === 'cambio' && x.j.ot.tiempos[0].segundos >= 1 && x.j.ot.tiempos[0].fin === x.j.ot.tiempos[1].inicio && x.j.ot.tiempos[1].tipo === 'espera' && x.j.ot.tiempos[1].nota === 'Portón cerrado' && x.j.crono.nombre === 'Espera de acceso', JSON.stringify(x.j.ot.tiempos.map((t) => [t.tipo, t.cierre, t.segundos])));
  x = await crono(M, garaio.id, { accion: 'trabajo' });
  ok('cambio a trabajo: 3 tramos, el total suma el desplazamiento', x.s === 200 && x.j.ot.tiempos.length === 3 && x.j.ot.tiempo.desplazamiento >= 1 && x.j.ot.tiempo.total >= x.j.ot.tiempo.desplazamiento && x.j.ot.requisitos.trabajo === true && x.j.ot.requisitos.completo === 1, JSON.stringify(x.j.ot.tiempo));
  d = await miDia(M);
  ok('mi-dia: cronómetro abierto en esa O.T. (grupo en curso) y resumen del día con el desplazamiento', d.crono && d.crono.ot_id === garaio.id && d.crono.tipo === 'trabajo' && d.tareas.find((t) => t.id === garaio.id).grupo === 'en_curso' && d.tareas.find((t) => t.id === garaio.id).crono.tipo === 'trabajo' && d.resumen.desplazamiento >= 1, JSON.stringify(d.resumen));
  x = await pedir('/api/kanban', { cookie: A });
  const tarjeta = x.j.fases.flatMap((f) => f.ots).find((o) => o.id === garaio.id);
  ok('Tablero: la tarjeta lleva crono_tipo = trabajo y crono_inicio', tarjeta && tarjeta.fase === 'en_curso' && tarjeta.crono_tipo === 'trabajo' && String(tarjeta.crono_inicio).startsWith(HOY), JSON.stringify(tarjeta && [tarjeta.crono_tipo, tarjeta.crono_inicio]));
  const etagK = x.h.get('etag');
  x = await pedir('/api/planificador', { cookie: R });
  const bPlan = x.j.bloques.find((b) => b.id === bGaraio.id);
  ok('Planificador: el bloque lleva origen manual, crono_tipo y real_seg (segundos fichados contra el bloque)', bPlan && bPlan.origen === 'manual' && bPlan.crono_tipo === 'trabajo' && bPlan.real_seg >= 1, JSON.stringify(bPlan && [bPlan.origen, bPlan.crono_tipo, bPlan.real_seg]));

  // --- Un solo cronómetro por técnico ----------------------------------------------------------------------------------
  x = await crono(M, torreta.id, { accion: 'trabajo' });
  ok('empezar en otra O.T. con el cronómetro en marcha → 409 con la O.T. abierta', x.s === 409 && x.j.abierto && x.j.abierto.ot_id === garaio.id && x.j.abierto.numero === garaio.numero && /cronómetro en marcha/.test(x.j.error), x.t.slice(0, 160));
  x = await crono(M, torreta.id, { accion: 'trabajo', cerrar_otra: true });
  ok('…con cerrar_otra → 200: cronómetro en la nueva', x.s === 200 && x.j.crono.ot_id === torreta.id && x.j.ot.tiempos.length === 1 && x.j.ot.estado === 'en_curso', x.t.slice(0, 120));
  x = await pedir(`/api/ot/${garaio.id}`, { cookie: M });
  ok('…y el tramo de la otra queda cerrado (cierre = otra_ot) con línea en su historial', x.j.tiempos.at(-1).cierre === 'otra_ot' && x.j.tiempos.at(-1).fin && x.j.tiempo.en_marcha === 0 && new RegExp(`Cronómetro parado al empezar la O\\.T\\. ${torreta.numero}`).test(x.j.historial.at(-1).nota), x.j.historial.at(-1).nota);
  x = await pedir('/api/kanban', { cookie: A, headers: { 'if-none-match': etagK } });
  ok('Tablero: el ETag cambia con el cronómetro (no 304)', x.s === 200, `${x.s}`);

  // --- Parar por hoy: la O.T. sigue en curso y en su tablero -----------------------------------------------------------------
  x = await crono(M, torreta.id, { accion: 'parar', nota: 'Sigo mañana' });
  ok('parar por hoy → 200: sin cronómetro, la O.T. sigue en curso', x.s === 200 && x.j.crono === null && x.j.ot.estado === 'en_curso' && x.j.ot.tiempos.at(-1).cierre === 'parar' && x.j.ot.tiempo.en_marcha === 0, x.t.slice(0, 120));
  ok('…historial "Paro por hoy (trabajo acumulado: …) · Sigo mañana" sin cambio de estado', /^Paro por hoy \(trabajo acumulado: \d+ min\) · Sigo mañana$/.test(x.j.ot.historial.at(-1).nota) && x.j.ot.historial.at(-1).estado_anterior === 'en_curso' && x.j.ot.historial.at(-1).estado_nuevo === 'en_curso', x.j.ot.historial.at(-1).nota);
  ok('parar sin cronómetro en marcha → 400', (await crono(M, torreta.id, { accion: 'parar' })).s === 400);
  d = await miDia(M);
  ok('mi-dia: la O.T. parada sigue entre sus tareas, sin cronómetro', d.crono === null && d.tareas.some((t) => t.id === torreta.id && t.grupo === 'en_curso'));

  // --- Requisitos para finalizar: tiempo de trabajo ------------------------------------------------------------------------
  x = await estado(AN, pluma.id, { estado: 'finalizada', nota: 'Terminado' });
  ok('técnico finaliza sin tiempo de trabajo → 422 con faltan = [trabajo], sin poder forzar', x.s === 422 && x.j.faltan.join() === 'trabajo' && x.j.puede_forzar === false && /no hay tiempo de trabajo imputado/.test(x.j.error), x.t.slice(0, 160));
  x = await estado(AN, pluma.id, { estado: 'finalizada', nota: 'Terminado', forzar: true });
  ok('…y con forzar el técnico sigue sin poder → 422', x.s === 422, `${x.s}`);
  x = await estado(RC, pluma.id, { estado: 'finalizada' });
  ok('recambista (no puede cerrar) → 422 sin poder forzar', x.s === 422 && x.j.puede_forzar === false, `${x.s}`);
  x = await estado(R, pluma.id, { estado: 'finalizada', nota: 'Lo hizo sin fichar' });
  ok('responsable sin forzar → 422 con puede_forzar', x.s === 422 && x.j.puede_forzar === true && x.j.faltan.join() === 'trabajo', x.t.slice(0, 160));
  x = await estado(R, pluma.id, { estado: 'finalizada', nota: 'Lo hizo sin fichar', forzar: true });
  ok('responsable con forzar → 200, anotado en el historial', x.s === 200 && x.j.ot.estado === 'finalizada' && /^Lo hizo sin fichar · forzado por oficina: no hay tiempo de trabajo imputado$/.test(x.j.ot.historial.at(-1).nota), x.j.ot && x.j.ot.historial.at(-1).nota);
  x = await estado(M, torreta.id, { estado: 'finalizada', nota: 'Rodamiento cambiado' });
  ok('técnico con tiempo de trabajo y sin checklist (correctivo) → finaliza', x.s === 200 && x.j.ot.estado === 'finalizada' && x.j.ot.historial.at(-1).nota === 'Rodamiento cambiado', x.t.slice(0, 160));
  x = await estado(A, cerrada.id, { estado: 'finalizada' });
  ok('reabrir una cerrada a finalizada no exige los requisitos', x.s === 200 && x.j.ot.estado === 'finalizada', `${x.s} ${x.t.slice(0, 100)}`);

  // --- Checklist del preventivo ----------------------------------------------------------------------------------------
  x = await crono(M, rev500.id, { accion: 'trabajo' });
  ok('preventivo: empieza a trabajar (tramo enlazado con su bloque de las 10:00)', x.s === 200 && x.j.ot.estado === 'en_curso' && x.j.ot.tiempos[0].bloque_id === bRev.id && x.j.ot.checklist.length === 4 && x.j.ot.checklist.map((p) => p.texto).join('|') === 'Revisión visual|Niveles|Engrase|Pruebas de funcionamiento', JSON.stringify(x.j.ot.checklist.map((p) => p.texto)));
  const puntos = x.j.ot.checklist;
  ok('requisitos del detalle: trabajo sí, checklist 0 de 4, falta checklist', x.j.ot.requisitos.trabajo === true && x.j.ot.requisitos.checklist.total === 4 && x.j.ot.requisitos.checklist.respondidos === 0 && x.j.ot.requisitos.completo === 0 && x.j.ot.requisitos.faltan[0].codigo === 'checklist', JSON.stringify(x.j.ot.requisitos));
  x = await estado(M, rev500.id, { estado: 'finalizada', nota: 'Hecho' });
  ok('finalizar con el checklist sin responder → 422 faltan = [checklist] (0 de 4)', x.s === 422 && x.j.faltan.join() === 'checklist' && /checklist sin terminar \(0 de 4\)/.test(x.j.error), x.t.slice(0, 160));
  const punto = (cookie, pid, body) => pedir(`/api/ot/${rev500.id}/checklist/${pid}`, { cookie, metodo: 'PUT', body });
  x = await punto(M, puntos[0].id, { resultado: 'hecho' });
  ok('punto 1 hecho → 200 con quién y cuándo', x.s === 200 && x.j.punto.resultado === 'hecho' && x.j.punto.usuario_id === mikel.id && String(x.j.punto.fecha).startsWith(HOY) && x.j.requisitos.checklist.respondidos === 1 && x.j.checklist.length === 4, x.t.slice(0, 160));
  x = await punto(M, puntos[1].id, { resultado: 'no_aplica' });
  ok('punto 2 no aplica → 200', x.s === 200 && x.j.punto.resultado === 'no_aplica');
  ok('incidencia sin nota → 400', (await punto(M, puntos[2].id, { resultado: 'incidencia' })).s === 400);
  x = await punto(M, puntos[2].id, { resultado: 'incidencia', nota: 'Engrasador del bulón roto' });
  ok('incidencia con nota → 200', x.s === 200 && x.j.punto.resultado === 'incidencia' && x.j.punto.nota === 'Engrasador del bulón roto');
  ok('resultado no válido → 400; sin resultado → 400; punto de otra O.T. → 404', (await punto(M, puntos[3].id, { resultado: 'regular' })).s === 400 && (await punto(M, puntos[3].id, {})).s === 400 && (await pedir(`/api/ot/${garaio.id}/checklist/${puntos[3].id}`, { cookie: M, metodo: 'PUT', body: { resultado: 'hecho' } })).s === 404);
  x = await punto(M, puntos[3].id, { resultado: 'hecho' });
  ok('punto 4 hecho → checklist completo (4 de 4)', x.s === 200 && x.j.requisitos.checklist.completo === 1 && x.j.requisitos.completo === 1, JSON.stringify(x.j.requisitos));
  x = await punto(M, puntos[3].id, { resultado: null });
  ok('resultado null lo deja sin responder (3 de 4)', x.s === 200 && x.j.punto.resultado === null && x.j.punto.usuario_id === null && x.j.requisitos.checklist.respondidos === 3);
  ok('gerencia no puede responder el checklist → 403', (await punto(G, puntos[3].id, { resultado: 'hecho' })).s === 403);
  ok('otro técnico (fuera de su alcance) → 404', (await punto(AN, puntos[3].id, { resultado: 'hecho' })).s === 404);
  x = await punto(R, puntos[3].id, { resultado: 'hecho' });
  ok('el responsable también puede responder un punto', x.s === 200 && x.j.requisitos.completo === 1);
  d = await miDia(M);
  ok('mi-dia: el preventivo va con checklist 4 de 4', d.tareas.find((t) => t.id === rev500.id).checklist.respondidos === 4);
  x = await estado(M, rev500.id, { estado: 'finalizada', nota: 'Revisión hecha' });
  ok('finalizar con trabajo y checklist → 200; el tramo abierto se cierra (cierre = fin) y no queda cronómetro', x.s === 200 && x.j.ot.estado === 'finalizada' && x.j.ot.tiempos.at(-1).cierre === 'fin' && x.j.ot.tiempos.at(-1).fin && x.j.ot.tiempo.en_marcha === 0, x.t.slice(0, 160));
  d = await miDia(M);
  ok('…y la finalizada sale de su tablero', d.crono === null && !d.tareas.some((t) => t.id === rev500.id));
  x = await pedir(`/api/ot/${cerrada.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'cerrada', etiqueta: 'facturada' } });
  x = await pedir(`/api/ot/${cerrada.id}/checklist/1`, { cookie: A, metodo: 'PUT', body: { resultado: 'hecho' } });
  ok('checklist de una O.T. cerrada → 400', x.s === 400, `${x.s}`);

  // --- Pausar: cierra el tramo y la O.T. sale del tablero del técnico -----------------------------------------------------
  x = await crono(M, garaio.id, { accion: 'trabajo' });
  x = await estado(M, garaio.id, { estado: 'pausada', etiqueta: 'repuesto', nota: 'Falta la batería' });
  ok('pausar con el cronómetro en marcha → 200; tramo cerrado con cierre = pausa', x.s === 200 && x.j.ot.estado === 'pausada' && x.j.ot.tiempos.at(-1).cierre === 'pausa' && x.j.ot.tiempo.en_marcha === 0, x.t.slice(0, 160));
  d = await miDia(M);
  ok('…la pausada sale de su tablero (se queda sin tareas hoy) y no tiene cronómetro', d.crono === null && d.tareas.length === 0, JSON.stringify(d.tareas.map((t) => [t.numero, t.grupo])));
  ok('…resumen del día con tiempo de trabajo y desplazamiento', d.resumen.total >= 1 && d.resumen.desplazamiento >= 1, JSON.stringify(d.resumen));
  x = await crono(M, garaio.id, { accion: 'trabajo' });
  ok('fichar en una pausada → 400', x.s === 400 && x.j.estado === 'pausada', `${x.s}`);

  // --- Quién puede fichar ---------------------------------------------------------------------------------------------
  x = await crono(R, freno.id, { accion: 'trabajo' });
  ok('la oficina no ficha → 403', x.s === 403, `${x.s}`);
  ok('recambista (sin ot.tiempos) → 403', (await crono(RC, freno.id, { accion: 'trabajo' })).s === 403);
  ok('un técnico no ficha en la O.T. de otro → 404', (await crono(AN, freno.id, { accion: 'trabajo' })).s === 404);
  x = await crono(SAT, rodillo.id, { accion: 'desplazamiento' });
  ok('el SAT ficha en su planificada → 200 y pasa a en curso', x.s === 200 && x.j.ot.estado === 'en_curso' && x.j.crono.tipo === 'desplazamiento', `${x.s}`);
  x = await pedir(`/api/ot/${rodillo.id}/tiempos`, { cookie: A });
  ok('GET /ot/:id/tiempos → tramos y totales', x.s === 200 && x.j.tramos.length === 1 && x.j.tramos[0].tecnico_nombre && x.j.tiempo.en_marcha === 1 && x.j.tiempo.previsto_min === 120, x.t.slice(0, 160));

  // --- Varios técnicos en una O.T.: el que tiene un bloque futuro también la ve --------------------------------------------
  x = await pedir(`/api/ot/${freno.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: ane.id, dia: HOY, hora_inicio: '16:00', duracion_min: 60 } });
  ok('bloque de hoy para Ane en la O.T. de Mikel: el técnico de la O.T. pasa a ser Ane (próximo bloque)', x.s === 201 && x.j.ot.tecnico_id === ane.id && x.j.ot.bloques.length === 2, `${x.s}`);
  x = await pedir(`/api/ot/${freno.id}`, { cookie: M });
  ok('Mikel la sigue viendo: tiene un bloque mañana', x.s === 200 && x.j.id === freno.id, `${x.s}`);
  d = await miDia(AN);
  ok('Ane la tiene hoy a las 16:00', d.tareas.some((t) => t.id === freno.id && t.grupo === 'hoy' && t.bloque.hora_inicio === '16:00'), JSON.stringify(d.tareas.map((t) => [t.numero, t.grupo])));
  d = await miDia(M);
  ok('Mikel no la tiene hoy pero sí en próximos días', !d.tareas.some((t) => t.id === freno.id) && d.proximos.some((p) => p.id === freno.id && p.dia === MANANA));
  x = await crono(AN, freno.id, { accion: 'trabajo' });
  ok('Ane ficha en ella → 200', x.s === 200 && x.j.ot.estado === 'en_curso', `${x.s}`);

  // --- Atrasada: planificada suya sin bloque de hoy en adelante -------------------------------------------------------------
  x = await pedir(`/api/ot/${luces.id}/asignar`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, aprobar: true } });
  d = await miDia(M);
  ok('planificada suya sin bloque → tarea del grupo "atrasada", sin bloque', x.s === 201 && d.tareas.some((t) => t.id === luces.id && t.grupo === 'atrasada' && t.bloque === null), JSON.stringify(d.tareas.map((t) => [t.numero, t.grupo])));

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
