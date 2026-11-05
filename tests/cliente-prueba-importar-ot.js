// Prueba de la importación de O.T. vivas desde Karve (F3.6-01) y del filtro de cerradas del Kanban (F3.6-02).
// Corre en el ciclo karve, después de cliente-prueba-karve.js (clientes y máquinas ya sincronizados en la misma base).
// Lanza scripts/karve-importar-ot.js contra la misma RUTA_BD que el servidor (lectura real en la copia de Karve, ~10 s).
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = 'http://localhost:5055';
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);

async function pedir(ruta, { metodo = 'GET', cookie = '', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  // Tras el script hijo (~5 s bloqueado) la conexión keep-alive ya está cerrada por el servidor: un reintento.
  let r;
  try { r = await fetch(BASE + ruta, { method: metodo, headers: h, body, redirect: 'manual' }); }
  catch (e) { await new Promise((ok2) => setTimeout(ok2, 300)); r = await fetch(BASE + ruta, { method: metodo, headers: h, body, redirect: 'manual' }); }
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { s: r.status, j: json, t: texto, h: r.headers };
}
async function login(usuario, clave) {
  const r = await fetch(BASE + '/acceso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  if (r.status !== 200) throw new Error(`login ${usuario} → ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
function importar(args = []) {
  const salida = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'karve-importar-ot.js'), ...args], { encoding: 'utf8', env: process.env, timeout: 180000 });
  const num = (re) => { const m = salida.match(re); return m ? Number(m[1]) : null; };
  return {
    salida,
    vivas: { leidas: num(/Vivas: (\d+) leídas/), nuevas: num(/Vivas: \d+ leídas · (\d+) nuevas/), actualizadas: num(/Vivas: \d+ leídas · \d+ nuevas · (\d+) actualizadas/), sin_cambios: num(/Vivas: [^\n]* · (\d+) sin cambios/), conservadas: num(/Vivas: [^\n]* · (\d+) conservadas/) },
    cerradas: { leidas: num(/Cerradas: (\d+) leídas/), nuevas: num(/Cerradas: \d+ leídas · (\d+) nuevas/), sin_cambios: num(/Cerradas: [^\n]* · (\d+) sin cambios/) },
  };
}
const hoyMenos = (dias) => { const d = new Date(); d.setDate(d.getDate() - dias); return d.toISOString().slice(0, 10); };
const todasLasOT = (kanban) => kanban.fases.flatMap((f) => f.ots);

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');
  const GS = await login('gestorsat1', 'prueba123');

  // Antes: el Kanban del seed ya tiene cerradas recientes (actualizado de estos días) → columna de cerradas solo con ellas
  x = await pedir('/api/kanban', { cookie: A });
  const antes = x.j;
  const faseCerrada = antes.fases.find((f) => f.codigo === 'cerrada');
  ok('Kanban: devuelve la fase cerrada con dias_cerradas = 7 y solo O.T. cerradas en los últimos 7 días', x.s === 200 && antes.dias_cerradas === 7 && faseCerrada && faseCerrada.abierta === 0 && faseCerrada.ots.length > 0 && faseCerrada.ots.every((o) => (o.fecha_cierre || o.actualizado || o.creado) >= hoyMenos(7)), `cerradas=${faseCerrada && faseCerrada.ots.length}`);
  x = await pedir('/api/kanban?cerradas=0', { cookie: A });
  ok('Kanban ?cerradas=0: sin fase cerrada y total solo abiertas', x.s === 200 && !x.j.fases.some((f) => f.codigo === 'cerrada') && x.j.total === antes.total - faseCerrada.ots.length, `total=${x.j.total}`);
  x = await pedir('/api/kanban?cerradas=200', { cookie: A });
  ok('Kanban ?cerradas=200 → se recorta a 90 días', x.s === 200 && x.j.dias_cerradas === 90);
  const seedAbiertas = antes.total - faseCerrada.ots.length;

  // Simulación: informa y no escribe
  let r = importar(['--simular', '--cerradas=20']);
  ok(`simulación: ≥ 800 vivas leídas y nuevas, 20 cerradas, sin escribir (${r.salida.split('\n')[1].trim()})`, r.vivas.leidas >= 800 && r.vivas.nuevas >= 800 && r.cerradas.leidas === 20 && r.cerradas.nuevas === 20);
  x = await pedir('/api/ot?abiertas=0&limite=1', { cookie: A });
  const totalAntes = x.j.total;
  ok('tras la simulación no hay O.T. nuevas', x.s === 200 && totalAntes < 200, `total=${totalAntes}`);

  // Importación real
  r = importar(['--cerradas=20']);
  ok(`importación: ≥ 800 vivas nuevas y 20 cerradas nuevas (${r.salida.split('\n')[1].trim()})`, r.vivas.nuevas >= 800 && r.cerradas.nuevas === 20 && r.vivas.conservadas === 0);
  ok('informe: nuevas por estado local y sin estados desconocidos', /Nuevas por estado local: asignada \d+/.test(r.salida) && !/sin mapeo/.test(r.salida), r.salida.split('\n').filter((l) => /estado local|sin mapeo/.test(l)).join(' | '));
  x = await pedir('/api/ot?abiertas=0&limite=1', { cookie: A });
  ok('el listado completo suma las importadas', x.s === 200 && x.j.total === totalAntes + r.vivas.nuevas + r.cerradas.nuevas, `total=${x.j.total}`);

  // Una O.T. viva concreta (HACER, 0000107949: 2026-10-02, cliente 0001604, máquina 0002186, operario TALLER)
  x = await pedir('/api/ot?abiertas=0&q=0000107949', { cookie: A });
  const o949 = x.j.ots[0];
  ok('O.T. 0000107949 importada: estado asignada, origen karve, estado Karve HACER, operario TALLER, prevista 02/10/2026', x.s === 200 && x.j.total === 1 && o949.estado === 'asignada' && o949.origen === 'karve' && o949.karve_estado === 'HACER' && o949.karve_operario === 'TALLER' && o949.fecha_prevista === '2026-10-02' && o949.tecnico_id === null && o949.creado.startsWith('2026-10-02 '), JSON.stringify(o949 && { estado: o949.estado, karve_estado: o949.karve_estado, karve_operario: o949.karve_operario, creado: o949.creado }));
  ok('…con cliente y máquina de Karve enlazados y síntoma = avisos de Karve', o949 && o949.cliente_nombre && o949.maquina_id && /No arranca por las ma/.test(o949.sintoma || ''), o949 && `${o949.cliente_nombre} / máquina ${o949.maquina_flota} / ${o949.sintoma}`);
  x = await pedir(`/api/ot/${o949.id}`, { cookie: A });
  ok('detalle: historial con "Importada de Karve (HACER · TALLER)" y notas internas con la persona de contacto', x.s === 200 && x.j.historial.length === 1 && /Importada de Karve \(HACER · TALLER\)/.test(x.j.historial[0].nota) && /Persona de contacto: Xabier/.test(x.j.notas_internas || ''), JSON.stringify(x.j.historial && x.j.historial[0] && x.j.historial[0].nota));

  // Mapeo de estados: recambios → pendiente_repuesto, PPTO → pausada, S.A.T. EXTERNO → en_curso sin técnico, PDTE Nº PEDIDO → pendiente_pedido, cerradas → cerrada con fecha_cierre
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pendiente_repuesto', { cookie: A });
  const rep = x.j.ots.filter((o) => o.origen === 'karve');
  ok('RECAMBIOS/ALMACEN/… → pendiente_repuesto (≥ 150)', rep.length >= 150 && rep.every((o) => /RECAMBIOS|REC\. URG\.|ALMACEN|PROVEEDOR|RE\. PEDIDO|RE\.PE\.URG|CONSULTADO REC\./.test(o.karve_estado)), `n=${rep.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pausada', { cookie: A });
  const pau = x.j.ots.filter((o) => o.origen === 'karve');
  ok('PPTO/PDTE OK PPTO/PDTE. DICTAMEN → pausada (≥ 150)', pau.length >= 150 && pau.every((o) => /PPTO|DICTAMEN/.test(o.karve_estado)), `n=${pau.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=en_curso', { cookie: A });
  const sat = x.j.ots.filter((o) => o.origen === 'karve');
  ok('S.A.T. EXTERNO → en_curso sin técnico local (≥ 15)', sat.length >= 15 && sat.every((o) => o.karve_estado === 'S.A.T. EXTERNO' && o.tecnico_id === null), `n=${sat.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pendiente_pedido', { cookie: A });
  const ped = x.j.ots.filter((o) => o.origen === 'karve');
  ok('PDTE Nº PEDIDO → pendiente_pedido (≥ 40)', ped.length >= 40 && ped.every((o) => o.karve_estado === 'PDTE Nº PEDIDO'), `n=${ped.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=cerrada', { cookie: A });
  const cer = x.j.ots.filter((o) => o.origen === 'karve');
  ok('cerradas de Karve: 20, con fecha_cierre y ordenadas de las más recientes', cer.length === 20 && cer.every((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.fecha_cierre)) && cer.every((o) => o.fecha_cierre >= '2026-09-01'), `n=${cer.length} ${cer[0] && cer[0].fecha_cierre}`);
  const urgentes = [...rep, ...pau].filter((o) => /URG/.test(o.karve_estado));
  ok('estados "URG." → prioridad alta; el resto media', urgentes.length > 0 && urgentes.every((o) => o.prioridad === 1) && rep.filter((o) => !/URG/.test(o.karve_estado)).every((o) => o.prioridad === 2), `urgentes=${urgentes.length}`);

  // Kanban: las vivas entran; las cerradas de Karve (octubre) no, porque son de hace más de 7 días; con ?cerradas=90 sí
  x = await pedir('/api/kanban', { cookie: A });
  const kb = x.j;
  const vivasKb = todasLasOT(kb).filter((o) => o.origen === 'karve' && o.fase !== 'cerrada');
  const cerradasKarveKb = kb.fases.find((f) => f.codigo === 'cerrada').ots.filter((o) => o.origen === 'karve');
  ok('Kanban: las vivas importadas (≥ 800) con karve_estado y operario de Karve; ninguna cerrada de Karve (son de hace > 7 días)', x.s === 200 && vivasKb.length >= 800 && vivasKb.every((o) => o.karve_estado && o.karve_operario) && cerradasKarveKb.length === 0, `vivas=${vivasKb.length} cerradasKarve=${cerradasKarveKb.length}`);
  ok('Kanban: total = abiertas del seed + vivas importadas + cerradas recientes del seed', kb.total === seedAbiertas + r.vivas.nuevas + faseCerrada.ots.length, `total=${kb.total}`);
  x = await pedir('/api/kanban?cerradas=90', { cookie: A });
  const cerradas90 = x.j.fases.find((f) => f.codigo === 'cerrada').ots.filter((o) => o.origen === 'karve');
  ok('Kanban ?cerradas=90: aparecen las 20 cerradas de Karve', x.s === 200 && cerradas90.length === 20, `n=${cerradas90.length}`);
  x = await pedir('/api/kanban', { cookie: GS });
  const satKb = todasLasOT(x.j).filter((o) => o.karve_estado === 'S.A.T. EXTERNO');
  ok('gestor_sat: ve en su Kanban las S.A.T. EXTERNO importadas (sin técnico)', x.s === 200 && satKb.length >= 15 && todasLasOT(x.j).every((o) => o.tecnico_id === null || o.tecnico_nombre), `n=${satKb.length}`);

  // Segunda importación: todo sin cambios; una O.T. editada en la app se conserva
  x = await pedir(`/api/ot/${o949.id}`, { cookie: A, metodo: 'PUT', body: { version: o949.version, sintoma: 'Editada en la app', origen: 'karve' } });
  ok('PUT sobre una importada → 200 (origen karve admitido)', x.s === 200 && x.j.version === 2 && x.j.sintoma === 'Editada en la app', x.t.slice(0, 120));
  r = importar(['--cerradas=20']);
  ok(`segunda importación: 0 nuevas, ≥ 800 sin cambios, 1 conservada (${r.salida.split('\n')[1].trim()})`, r.vivas.nuevas === 0 && r.vivas.sin_cambios >= 800 && r.vivas.conservadas === 1 && r.cerradas.nuevas === 0 && r.cerradas.sin_cambios === 20);
  x = await pedir(`/api/ot/${o949.id}`, { cookie: A });
  ok('la O.T. editada conserva el síntoma de la app', x.s === 200 && x.j.sintoma === 'Editada en la app' && x.j.version === 2);

  // Cerrar una O.T. en la app deja fecha_cierre y sale en la columna de cerradas
  x = await pedir('/api/ot?abiertas=0&limite=1&estado=vb_factura', { cookie: A });
  const vb = x.j.ots[0];
  x = await pedir(`/api/ot/${vb.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'cerrada', version: vb.version } });
  ok('cerrar una O.T. desde la app → fecha_cierre de hoy', x.s === 200 && x.j.ot.estado === 'cerrada' && String(x.j.ot.fecha_cierre || '').startsWith(hoyMenos(0)), `${x.s} ${x.j && x.j.ot && x.j.ot.fecha_cierre}`);
  x = await pedir('/api/kanban', { cookie: A });
  ok('…y aparece en la columna de cerradas del Kanban', x.s === 200 && x.j.fases.find((f) => f.codigo === 'cerrada').ots.some((o) => o.id === vb.id));

  console.log(res.join('\n'));
  const fallos = res.filter((r2) => r2.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
