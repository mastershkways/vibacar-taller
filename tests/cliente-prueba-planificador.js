// Prueba HTTP del Planificador (F4-02 + F4-03): GET /api/planificador (técnicos, bloques, bandeja, avisos, ETag), alta / movimiento /
// borrado de bloques, estado pendiente ↔ planificada, técnico derivado del próximo bloque, propuestas de la bandeja (repuesto recibido),
// preplanificación de pausadas, avisos de zonas / horas / solape, alcance del operativo y permisos.
// Servidor en 5055 con la BD del seed recién generada (ciclo planificador del lanzador).
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
const HOY = dia(0), MANANA = dia(1), PASADO = dia(2), AYER = dia(-1);
const tipos = (avisos, tecnicoId, d) => avisos.filter((a) => a.tecnico_id === tecnicoId && a.dia === d).map((a) => a.tipo).sort().join(',');

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');
  const R = await login('responsable1', 'prueba123');
  const OP = await login('operativo1', 'prueba123');
  const G = await login('gerencia1', 'prueba123');
  const T = await login('tecnico1', 'prueba123');
  const RC = await login('recambista1', 'prueba123');
  const plan = async (cookie, q = '') => (await pedir(`/api/planificador${q}`, { cookie })).j;
  const enBandeja = (p, re) => p.bandeja.find((o) => re.test(`${o.cliente_nombre} ${o.sintoma || ''}`));

  // --- Permisos ------------------------------------------------------------------------------------------------------
  x = await pedir('/api/sesion', { cookie: R });
  ok('responsable_st: planificador.ver y planificador.editar', x.j.permisos.includes('planificador.ver') && x.j.permisos.includes('planificador.editar'));
  x = await pedir('/api/sesion', { cookie: G });
  ok('gerencia: planificador.ver sin editar', x.j.permisos.includes('planificador.ver') && !x.j.permisos.includes('planificador.editar'));
  x = await pedir('/api/planificador', { cookie: T });
  ok('técnico: GET /planificador → 403', x.s === 403, `${x.s}`);
  x = await pedir('/api/planificador', { cookie: RC });
  ok('recambista: GET /planificador → 403', x.s === 403, `${x.s}`);

  // --- GET por defecto: hoy --------------------------------------------------------------------------------------------
  x = await pedir('/api/planificador', { cookie: R });
  const p0 = x.j;
  const etag = x.h.get('etag');
  ok('GET /planificador: hoy por defecto, jornada 07:00–19:00 de 8 h y duración por defecto 120', x.s === 200 && p0.desde === HOY && p0.hasta === HOY && p0.hoy === HOY && p0.jornada.inicio === '07:00' && p0.jornada.fin === '19:00' && p0.jornada.horas_dia === 8 && p0.duracion_defecto === 120, JSON.stringify(p0.jornada));
  ok('técnicos: internos primero y luego SAT (Ane, Mikel, SAT Bizkaia), sin el desactivado', p0.tecnicos.map((t) => t.nombre).join('|') === 'Ane Zubiaurre|Mikel Etxeberria|SAT Bizkaia (ext.)', p0.tecnicos.map((t) => t.nombre).join('|'));
  const [ane, mikel, sat] = p0.tecnicos;
  ok('bloques de hoy: los 3 del seed (O.T. en curso), 08:00 y 2 h, con datos de la O.T. y zona', p0.bloques.length === 3 && p0.bloques.every((b) => b.dia === HOY && b.hora_inicio === '08:00' && b.duracion_min === 120 && b.estado === 'en_curso' && b.numero && b.cliente_nombre && b.cliente_zona === 'Bizkaia' && b.fuera_alcance === 0), `${p0.bloques.length}`);
  ok('bandeja: las 6 pendientes de planificar del seed, urgentes primero, sin avisos', p0.bandeja_total === 6 && p0.bandeja.length === 6 && p0.bandeja.every((o) => o.estado === 'pendiente_planificar' && !o.propuesta && !o.bloque_vencido) && p0.bandeja.every((o, i) => i === 0 || o.prioridad >= p0.bandeja[i - 1].prioridad) && p0.avisos.length === 0, `total=${p0.bandeja_total}`);
  x = await pedir('/api/planificador', { cookie: R, headers: { 'if-none-match': etag } });
  ok('GET con If-None-Match → 304', x.s === 304, `${x.s}`);
  x = await pedir(`/api/planificador?desde=${HOY}&hasta=${MANANA}`, { cookie: R });
  ok('rango hoy–mañana: 6 bloques (3 en curso hoy + 3 planificadas mañana)', x.s === 200 && x.j.bloques.length === 6 && x.j.bloques.filter((b) => b.dia === MANANA).every((b) => b.estado === 'planificada'), `${x.j.bloques.length}`);
  x = await pedir(`/api/planificador?desde=${MANANA}&hasta=${HOY}`, { cookie: R });
  ok('hasta anterior a desde → 400', x.s === 400, `${x.s}`);
  x = await pedir(`/api/planificador?desde=${HOY}&hasta=${dia(40)}`, { cookie: R });
  ok('rango de más de 31 días → 400', x.s === 400, `${x.s}`);
  x = await pedir('/api/planificador?desde=2026-02-31', { cookie: R });
  ok('fecha imposible → 400', x.s === 400, `${x.s}`);

  // --- Crear bloques: estado, técnico derivado, historial, avisos ------------------------------------------------------
  const garaio = enBandeja(p0, /Garaio/);
  x = await pedir(`/api/ot/${garaio.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: MANANA, hora_inicio: '10:30' } });
  ok('POST bloque (sin duración → 2 h): 201, la O.T. pasa a planificada con el técnico del bloque', x.s === 201 && x.j.bloque.duracion_min === 120 && x.j.bloque.hora_inicio === '10:30' && x.j.ot.estado === 'planificada' && x.j.ot.tecnico_id === mikel.id && x.j.ot.bloques.length === 1, x.t.slice(0, 160));
  ok('…historial "Planificada: día dd/mm 10:30 · 2 h · Mikel Etxeberria"', /^Planificada: \S+ \d\d\/\d\d 10:30 · 2 h · Mikel Etxeberria$/.test(x.j.ot.historial.at(-1).nota) && x.j.ot.historial.at(-1).estado_anterior === 'pendiente_planificar' && x.j.ot.historial.at(-1).estado_nuevo === 'planificada', x.j.ot.historial.at(-1).nota);
  ok('…aviso de zonas: Mikel mañana tiene Araba (Lautada, del seed) y Bizkaia', tipos(x.j.avisos, mikel.id, MANANA) === 'zonas' && /2 zonas/.test(x.j.avisos[0].texto), JSON.stringify(x.j.avisos.map((a) => a.texto)));
  const bGaraio = x.j.bloque;
  let p = await plan(R, `?desde=${MANANA}`);
  ok('GET mañana: 4 bloques, aviso de zonas en el índice, la O.T. ya no está en la bandeja (5)', p.bloques.length === 4 && tipos(p.avisos, mikel.id, MANANA) === 'zonas' && p.avisos[0].bloques.length === 2 && p.bandeja_total === 5 && !p.bandeja.some((o) => o.id === garaio.id), `bandeja=${p.bandeja_total}`);
  x = await pedir('/api/kanban', { cookie: A });
  const tarjeta = x.j.fases.flatMap((f) => f.ots).find((o) => o.id === garaio.id);
  ok('Tablero: la tarjeta lleva el próximo bloque, su técnico y bloques_futuros = 1', tarjeta && tarjeta.fase === 'planificada' && tarjeta.proximo_bloque === `${MANANA} 10:30` && tarjeta.proximo_tecnico === 'Mikel Etxeberria' && tarjeta.bloques_futuros === 1, JSON.stringify(tarjeta && [tarjeta.proximo_bloque, tarjeta.proximo_tecnico, tarjeta.bloques_futuros]));

  const lezama = enBandeja(p0, /Lezama/);
  x = await pedir(`/api/ot/${lezama.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: MANANA, hora_inicio: '11:00', duracion_min: 60, nota: 'Llevar mando de repuesto' } });
  ok('segundo bloque solapado (11:00–12:00 sobre 10:30–12:30) → avisos solape + zonas; nota guardada', x.s === 201 && tipos(x.j.avisos, mikel.id, MANANA) === 'solape,zonas' && x.j.bloque.nota === 'Llevar mando de repuesto', JSON.stringify(x.j.avisos.map((a) => a.tipo)));
  const bLezama = x.j.bloque;
  x = await pedir(`/api/ot/${lezama.id}/bloques/${bLezama.id}`, { cookie: R, metodo: 'PUT', body: { duracion_min: 480 } });
  ok('alargar a 8 h → aviso de horas (12 h previstas para una jornada de 8)', x.s === 200 && x.j.bloque.duracion_min === 480 && tipos(x.j.avisos, mikel.id, MANANA) === 'horas,solape,zonas' && /12 h previstas/.test(x.j.avisos.find((a) => a.tipo === 'horas').texto), JSON.stringify(x.j.avisos.map((a) => a.texto)));

  // --- Validaciones -----------------------------------------------------------------------------------------------------
  const put = (body) => pedir(`/api/ot/${lezama.id}/bloques/${bLezama.id}`, { cookie: R, metodo: 'PUT', body });
  ok('duración que no va en tramos de 15 min → 400', (await put({ duracion_min: 20 })).s === 400);
  ok('hora no válida → 400', (await put({ hora_inicio: '25:00' })).s === 400);
  ok('fecha no válida → 400', (await put({ dia: '2026-13-01' })).s === 400);
  ok('bloque que pasa de medianoche → 400', (await put({ hora_inicio: '23:00' })).s === 400);
  const comercial = (await pedir('/api/usuarios', { cookie: A })).j.usuarios.find((u) => u.rol === 'comercial');
  ok('técnico que no es técnico/SAT → 400', (await put({ tecnico_id: comercial.id })).s === 400);
  ok('sin cambios → 400', (await put({ duracion_min: 480 })).s === 400);
  x = await pedir(`/api/ot/${garaio.id}/bloques/${bLezama.id}`, { cookie: R, metodo: 'PUT', body: { duracion_min: 60 } });
  ok('bloque de otra O.T. → 404', x.s === 404, `${x.s}`);
  x = await pedir(`/api/ot/${lezama.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: ane.id, dia: PASADO, version: 1 } });
  ok('POST con versión vieja de la O.T. → 409', x.s === 409, `${x.s}`);

  // --- Mover y quitar ---------------------------------------------------------------------------------------------------
  x = await put({ tecnico_id: ane.id, dia: HOY, hora_inicio: '15:00', duracion_min: 120 });
  ok('mover a otro técnico, día y hora → técnico de la O.T. = el del bloque; historial "Bloque movido: … (antes …)"', x.s === 200 && x.j.bloque.tecnico_id === ane.id && x.j.bloque.dia === HOY && x.j.ot.tecnico_id === ane.id && x.j.ot.estado === 'planificada' && /^Bloque movido: .* 15:00 · 2 h · Ane Zubiaurre \(antes .* 11:00 · 8 h\)$/.test(x.j.ot.historial.at(-1).nota), x.j.ot.historial.at(-1).nota);
  p = await plan(R, `?desde=${MANANA}`);
  ok('mañana, sin el bloque movido, Mikel solo conserva el aviso de zonas', tipos(p.avisos, mikel.id, MANANA) === 'zonas');
  x = await pedir(`/api/ot/${lezama.id}/bloques/${bLezama.id}`, { cookie: R, metodo: 'DELETE' });
  ok('quitar su único bloque → vuelve a pendiente de planificar, sin técnico, con nota "vuelve a la bandeja"', x.s === 200 && x.j.bloque === null && x.j.ot.estado === 'pendiente_planificar' && x.j.ot.tecnico_id === null && x.j.ot.bloques.length === 0 && /Bloque quitado: .* · sin bloques futuros: vuelve a la bandeja$/.test(x.j.ot.historial.at(-1).nota), x.j.ot.historial.at(-1).nota);
  p = await plan(R);
  ok('…y está otra vez en la bandeja', p.bandeja.some((o) => o.id === lezama.id) && p.bandeja_total === 5);

  // --- Varios bloques por O.T.: el técnico es el del próximo ---------------------------------------------------------
  x = await pedir(`/api/ot/${garaio.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: ane.id, dia: PASADO, hora_inicio: '09:00', duracion_min: 180 } });
  ok('segundo bloque de la misma O.T. (otro día, otro técnico): 2 bloques y el técnico sigue siendo el del próximo (Mikel)', x.s === 201 && x.j.ot.bloques.length === 2 && x.j.ot.tecnico_id === mikel.id && x.j.ot.estado === 'planificada', `${x.j.ot && x.j.ot.tecnico_id}`);
  x = await pedir('/api/kanban', { cookie: A });
  ok('Tablero: bloques_futuros = 2', x.j.fases.flatMap((f) => f.ots).find((o) => o.id === garaio.id).bloques_futuros === 2);
  x = await pedir(`/api/ot/${garaio.id}/bloques/${bGaraio.id}`, { cookie: R, metodo: 'DELETE' });
  ok('quitar el primero: sigue planificada y el técnico pasa a ser el del bloque que queda (Ane)', x.s === 200 && x.j.ot.estado === 'planificada' && x.j.ot.tecnico_id === ane.id && x.j.ot.bloques.length === 1, `${x.j.ot && x.j.ot.estado}`);

  // --- Propuesta de la bandeja: repuesto recibido -------------------------------------------------------------------------
  const urkiola = enBandeja(p0, /Urkiola/);
  x = await pedir(`/api/ot/${urkiola.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'pausada', etiqueta: 'repuesto', nota: 'Falta el latiguillo' } });
  x = await pedir(`/api/ot/${urkiola.id}/estado`, { cookie: RC, metodo: 'POST', body: { estado: 'pendiente_planificar', nota: 'Repuesto recibido' } });
  ok('recambista: pausada/repuesto → pendiente de planificar', x.s === 200 && x.j.ot.estado === 'pendiente_planificar' && x.j.ot.propuesta === 'repuesto' && String(x.j.ot.propuesta_fecha).startsWith(HOY), x.t.slice(0, 120));
  p = await plan(R);
  ok('bandeja: la propuesta va la primera, con propuesta = repuesto', p.bandeja[0].id === urkiola.id && p.bandeja[0].propuesta === 'repuesto' && p.bandeja.filter((o) => o.propuesta).length === 1, `${p.bandeja[0].numero} ${p.bandeja[0].propuesta}`);
  x = await pedir(`/api/ot/${urkiola.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: sat.id, dia: PASADO } });
  ok('al planificarla se limpia la propuesta', x.s === 201 && x.j.ot.estado === 'planificada' && x.j.ot.propuesta === null && x.j.ot.propuesta_fecha === null, `${x.j.ot && x.j.ot.propuesta}`);

  // --- Preplanificar una pausada: no cambia de estado; al llegar el repuesto queda planificada -----------------------------
  p = await plan(R, '?pausadas=1');
  const cadena = enBandeja(p, /Cadena destensada/);
  ok('?pausadas=1: la bandeja incluye las pausadas sin bloque futuro', p.bandeja_total > 5 && cadena && cadena.estado === 'pausada' && cadena.etiqueta === 'repuesto', `total=${p.bandeja_total}`);
  x = await pedir(`/api/ot/${cadena.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: ane.id, dia: dia(3), hora_inicio: '08:00' } });
  ok('bloque en una pausada: sigue pausada con su etiqueta, técnico derivado, historial sin cambio de estado', x.s === 201 && x.j.ot.estado === 'pausada' && x.j.ot.etiqueta === 'repuesto' && x.j.ot.tecnico_id === ane.id && x.j.ot.historial.at(-1).estado_anterior === 'pausada' && x.j.ot.historial.at(-1).estado_nuevo === 'pausada', `${x.j.ot && x.j.ot.estado}`);
  x = await pedir(`/api/ot/${cadena.id}/estado`, { cookie: RC, metodo: 'POST', body: { estado: 'pendiente_planificar', nota: 'Ha llegado el cilindro' } });
  ok('recambista la manda a pendiente de planificar teniendo plan → queda planificada ("conserva su planificación"), sin propuesta', x.s === 200 && x.j.cambio.nuevo === 'planificada' && x.j.ot.estado === 'planificada' && x.j.ot.propuesta === null && /conserva su planificación$/.test(x.j.ot.historial.at(-1).nota), x.j.ot && x.j.ot.historial.at(-1).nota);

  // --- Bloque en el pasado: lo previsto se conserva, pero no cuenta como plan ---------------------------------------------
  const nerbioi = enBandeja(p0, /Nerbioi/);
  x = await pedir(`/api/ot/${nerbioi.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: AYER, hora_inicio: '09:00' } });
  ok('bloque con fecha de ayer: se guarda, la O.T. sigue pendiente de planificar', x.s === 201 && x.j.ot.estado === 'pendiente_planificar' && x.j.ot.bloques.length === 1, `${x.j.ot && x.j.ot.estado}`);
  p = await plan(R);
  ok('…y en la bandeja sale marcada como bloque vencido', p.bandeja.find((o) => o.id === nerbioi.id)?.bloque_vencido === 1);

  // --- O.T. cerrada, gerencia, operativo ---------------------------------------------------------------------------------
  const cerrada = (await pedir('/api/ot?abiertas=0&estado=cerrada&limite=1', { cookie: A })).j.ots[0];
  x = await pedir(`/api/ot/${cerrada.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: MANANA } });
  ok('O.T. cerrada: POST bloque → 400', x.s === 400, `${x.s}`);
  x = await pedir('/api/planificador', { cookie: G });
  ok('gerencia: GET → 200 con los mismos bloques', x.s === 200 && x.j.bloques.length >= 3, `${x.s}`);
  x = await pedir(`/api/ot/${lezama.id}/bloques`, { cookie: G, metodo: 'POST', body: { tecnico_id: mikel.id, dia: MANANA } });
  ok('gerencia: POST bloque → 403', x.s === 403, `${x.s}`);
  p = await plan(OP);
  const ajeno = p.bloques.find((b) => b.tecnico_id === mikel.id || b.tecnico_id === ane.id);
  const propio = p.bloques.find((b) => b.tecnico_id === sat.id);
  ok('operativo: ve la ocupación de todos; los bloques de O.T. de técnicos internos van como fuera_alcance y los de SAT no', ajeno && ajeno.fuera_alcance === 1 && propio && propio.fuera_alcance === 0 && p.bandeja.every((o) => o.estado === 'pendiente_planificar'), JSON.stringify([ajeno && ajeno.fuera_alcance, propio && propio.fuera_alcance]));
  x = await pedir(`/api/ot/${ajeno.ot_id}/bloques/${ajeno.id}`, { cookie: OP, metodo: 'PUT', body: { hora_inicio: '12:00' } });
  ok('operativo: mover un bloque de una O.T. fuera de su alcance → 404', x.s === 404, `${x.s}`);
  x = await pedir(`/api/ot/${propio.ot_id}/bloques/${propio.id}`, { cookie: OP, metodo: 'PUT', body: { hora_inicio: '12:00' } });
  ok('operativo: mover un bloque de una O.T. de SAT → 200', x.s === 200 && x.j.bloque.hora_inicio === '12:00', `${x.s}`);

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
