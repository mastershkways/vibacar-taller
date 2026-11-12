// Prueba de la importación de O.T. vivas desde Karve (F3.6-01, mapeo a verticales + etiquetas desde F4-04) y de las cerradas del Tablero (F3.6-02 / F4-04: fuera por defecto).
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
  const OP = await login('operativo1', 'prueba123');

  // Antes: por defecto el Tablero no enseña cerradas (F4-04); con ?cerradas=7 vuelve la columna solo con las de esos días
  x = await pedir('/api/kanban', { cookie: A });
  const antes = x.j;
  ok('Tablero: por defecto dias_cerradas = 0 y sin fase cerrada', x.s === 200 && antes.dias_cerradas === 0 && !antes.fases.some((f) => f.codigo === 'cerrada') && antes.fases.length === 5, `fases=${antes.fases.map((f) => f.codigo).join(',')}`);
  x = await pedir('/api/kanban?cerradas=7', { cookie: A });
  const faseCerrada = x.j.fases.find((f) => f.codigo === 'cerrada');
  ok('Tablero ?cerradas=7: fase cerrada con solo O.T. cerradas en los últimos 7 días', x.s === 200 && x.j.dias_cerradas === 7 && faseCerrada && faseCerrada.abierta === 0 && faseCerrada.ots.every((o) => (o.fecha_cierre || o.actualizado || o.creado) >= hoyMenos(7)), `cerradas=${faseCerrada && faseCerrada.ots.length}`);
  x = await pedir('/api/kanban?cerradas=200', { cookie: A });
  ok('Tablero ?cerradas=200 → se recorta a 90 días', x.s === 200 && x.j.dias_cerradas === 90);
  const seedAbiertas = antes.total;

  // Simulación: informa y no escribe
  let r = importar(['--simular', '--cerradas=20']);
  ok(`simulación: ≥ 800 vivas leídas y nuevas, 20 cerradas, sin escribir (${r.salida.split('\n')[1].trim()})`, r.vivas.leidas >= 800 && r.vivas.nuevas >= 800 && r.cerradas.leidas === 20 && r.cerradas.nuevas === 20);
  x = await pedir('/api/ot?abiertas=0&limite=1', { cookie: A });
  const totalAntes = x.j.total;
  ok('tras la simulación no hay O.T. nuevas', x.s === 200 && totalAntes < 200, `total=${totalAntes}`);

  // Importación real
  r = importar(['--cerradas=20']);
  ok(`importación: ≥ 800 vivas nuevas y 20 cerradas nuevas (${r.salida.split('\n')[1].trim()})`, r.vivas.nuevas >= 800 && r.cerradas.nuevas === 20 && r.vivas.conservadas === 0);
  ok('informe: nuevas por estado local (planificada primero) y sin estados desconocidos', /Nuevas por estado local: planificada \d+/.test(r.salida) && /pausada:repuesto \d+/.test(r.salida) && !/sin mapeo/.test(r.salida), r.salida.split('\n').filter((l) => /estado local|sin mapeo/.test(l)).join(' | '));
  x = await pedir('/api/ot?abiertas=0&limite=1', { cookie: A });
  ok('el listado completo suma las importadas', x.s === 200 && x.j.total === totalAntes + r.vivas.nuevas + r.cerradas.nuevas, `total=${x.j.total}`);

  // Una O.T. viva concreta (HACER, 0000107949: 2026-10-02, cliente 0001604, máquina 0002186, operario TALLER)
  x = await pedir('/api/ot?abiertas=0&q=0000107949', { cookie: A });
  const o949 = x.j.ots[0];
  ok('O.T. 0000107949 importada: vertical planificada sin etiqueta, origen karve, estado Karve HACER, operario TALLER, prevista 02/10/2026', x.s === 200 && x.j.total === 1 && o949.estado === 'planificada' && o949.etiqueta === null && o949.origen === 'karve' && o949.karve_estado === 'HACER' && o949.karve_operario === 'TALLER' && o949.fecha_prevista === '2026-10-02' && o949.tecnico_id === null && o949.creado.startsWith('2026-10-02 '), JSON.stringify(o949 && { estado: o949.estado, karve_estado: o949.karve_estado, karve_operario: o949.karve_operario, creado: o949.creado }));
  ok('…con cliente y máquina de Karve enlazados y síntoma = avisos de Karve', o949 && o949.cliente_nombre && o949.maquina_id && /No arranca por las ma/.test(o949.sintoma || ''), o949 && `${o949.cliente_nombre} / máquina ${o949.maquina_flota} / ${o949.sintoma}`);
  x = await pedir(`/api/ot/${o949.id}`, { cookie: A });
  ok('detalle: historial con "Importada de Karve (HACER · TALLER)" y notas internas con la persona de contacto', x.s === 200 && x.j.historial.length === 1 && /Importada de Karve \(HACER · TALLER\)/.test(x.j.historial[0].nota) && /Persona de contacto: Xabier/.test(x.j.notas_internas || ''), JSON.stringify(x.j.historial && x.j.historial[0] && x.j.historial[0].nota));

  // Mapeo de estados (F4-04): recambios → pausada/repuesto, PPTO → pausada/presupuesto u ok_presupuesto, S.A.T. EXTERNO → en_curso/sat_externo sin técnico,
  // PDTE Nº PEDIDO → pausada/num_pedido, Vº B → finalizada/vb_factura, cerradas → cerrada con fecha_cierre
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pausada&etiqueta=repuesto', { cookie: A });
  const rep = x.j.ots.filter((o) => o.origen === 'karve');
  ok('RECAMBIOS/ALMACEN/… → pausada + etiqueta repuesto (≥ 150)', rep.length >= 150 && rep.every((o) => o.etiqueta === 'repuesto' && /RECAMBIOS|REC\. URG\.|ALMACEN|PROVEEDOR|RE\. PEDIDO|RE\.PE\.URG|CONSULTADO REC\./.test(o.karve_estado)), `n=${rep.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pausada&etiqueta=presupuesto', { cookie: A });
  const pau = x.j.ots.filter((o) => o.origen === 'karve');
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pausada&etiqueta=ok_presupuesto', { cookie: A });
  const pauOk = x.j.ots.filter((o) => o.origen === 'karve');
  ok('PPTO/PDTE. DICTAMEN → pausada/presupuesto y PDTE OK PPTO → pausada/ok_presupuesto (≥ 150 entre las dos)', pau.length + pauOk.length >= 150 && pau.every((o) => /PPTO|DICTAMEN/.test(o.karve_estado) && o.karve_estado !== 'PDTE OK PPTO') && pauOk.length > 0 && pauOk.every((o) => o.karve_estado === 'PDTE OK PPTO'), `n=${pau.length}+${pauOk.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=en_curso&etiqueta=sat_externo', { cookie: A });
  const sat = x.j.ots.filter((o) => o.origen === 'karve');
  ok('S.A.T. EXTERNO → en_curso/sat_externo sin técnico local (≥ 15)', sat.length >= 15 && sat.every((o) => o.karve_estado === 'S.A.T. EXTERNO' && o.tecnico_id === null), `n=${sat.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=pausada&etiqueta=num_pedido', { cookie: A });
  const ped = x.j.ots.filter((o) => o.origen === 'karve');
  ok('PDTE Nº PEDIDO → pausada/num_pedido (≥ 40)', ped.length >= 40 && ped.every((o) => o.karve_estado === 'PDTE Nº PEDIDO'), `n=${ped.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=finalizada&etiqueta=vb_factura', { cookie: A });
  const vbs = x.j.ots.filter((o) => o.origen === 'karve');
  ok('Vº B FACT. / Vº B F. P. → finalizada/vb_factura (≥ 1)', vbs.length >= 1 && vbs.every((o) => /^Vº B/.test(o.karve_estado)), `n=${vbs.length}`);
  x = await pedir('/api/ot?abiertas=0&limite=1000&estado=cerrada', { cookie: A });
  const cer = x.j.ots.filter((o) => o.origen === 'karve');
  ok('cerradas de Karve: 20, con fecha_cierre y ordenadas de las más recientes', cer.length === 20 && cer.every((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.fecha_cierre)) && cer.every((o) => o.fecha_cierre >= '2026-09-01'), `n=${cer.length} ${cer[0] && cer[0].fecha_cierre}`);
  const urgentes = [...rep, ...pau, ...pauOk].filter((o) => /URG/.test(o.karve_estado));
  ok('estados "URG." → prioridad alta; el resto media', urgentes.length > 0 && urgentes.every((o) => o.prioridad === 1) && rep.filter((o) => !/URG/.test(o.karve_estado)).every((o) => o.prioridad === 2), `urgentes=${urgentes.length}`);

  // Tablero: las vivas entran con su etiqueta; las cerradas no se muestran; con ?cerradas=90 aparecen las 20 de Karve
  x = await pedir('/api/kanban', { cookie: A });
  const kb = x.j;
  const vivasKb = todasLasOT(kb).filter((o) => o.origen === 'karve');
  ok('Tablero: las vivas importadas (≥ 800) con karve_estado, operario de Karve y etiqueta coherente con la vertical; sin columna de cerradas', x.s === 200 && vivasKb.length >= 800 && vivasKb.every((o) => o.karve_estado && o.karve_operario && (!o.etiqueta || o.etiqueta_nombre)) && vivasKb.filter((o) => o.etiqueta === 'repuesto').every((o) => o.fase === 'pausada') && !kb.fases.some((f) => f.codigo === 'cerrada'), `vivas=${vivasKb.length}`);
  ok('Tablero: total = abiertas del seed + vivas importadas', kb.total === seedAbiertas + r.vivas.nuevas, `total=${kb.total}`);
  x = await pedir('/api/kanban?cerradas=90', { cookie: A });
  const cerradas90 = x.j.fases.find((f) => f.codigo === 'cerrada').ots.filter((o) => o.origen === 'karve');
  ok('Tablero ?cerradas=90: aparecen las 20 cerradas de Karve', x.s === 200 && cerradas90.length === 20, `n=${cerradas90.length}`);
  x = await pedir('/api/kanban', { cookie: OP });
  const satKb = todasLasOT(x.j).filter((o) => o.karve_estado === 'S.A.T. EXTERNO');
  ok('operativo: ve en su Tablero las S.A.T. EXTERNO importadas (sin técnico)', x.s === 200 && satKb.length >= 15 && todasLasOT(x.j).every((o) => o.tecnico_id === null || o.tecnico_nombre), `n=${satKb.length}`);

  // Segunda importación: todo sin cambios; una O.T. editada en la app se conserva
  x = await pedir(`/api/ot/${o949.id}`, { cookie: A, metodo: 'PUT', body: { version: o949.version, sintoma: 'Editada en la app', origen: 'karve' } });
  ok('PUT sobre una importada → 200 (origen karve admitido)', x.s === 200 && x.j.version === 2 && x.j.sintoma === 'Editada en la app', x.t.slice(0, 120));
  r = importar(['--cerradas=20']);
  ok(`segunda importación: 0 nuevas, ≥ 800 sin cambios, 1 conservada (${r.salida.split('\n')[1].trim()})`, r.vivas.nuevas === 0 && r.vivas.sin_cambios >= 800 && r.vivas.conservadas === 1 && r.cerradas.nuevas === 0 && r.cerradas.sin_cambios === 20);
  x = await pedir(`/api/ot/${o949.id}`, { cookie: A });
  ok('la O.T. editada conserva el síntoma de la app', x.s === 200 && x.j.sintoma === 'Editada en la app' && x.j.version === 2);

  // --- F4-13: bloques automáticos en el Planificador ------------------------------------------------------------------------
  // En la copia de Karve todas las fechas previstas están vencidas y no hay horas: los bloques salen del reparto por capacidad.
  const bloquesDe = (salida) => { const m = salida.match(/Bloques automáticos: (\d+) en su fecha prevista · (\d+) repartidas \(fecha vencida\) · (\d+) quitados · (\d+) sin hueco · (\d+) vencidas sin repartir · (\d+) planificadas sin técnico/); return m ? { en_fecha: +m[1], repartidas: +m[2], quitados: +m[3], sin_hueco: +m[4], sin_repartir: +m[5], sin_tecnico: +m[6] } : null; };
  const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hoyMas = (dias) => { const d = new Date(); d.setDate(d.getDate() + dias); return isoLocal(d); };
  const laborable = (iso) => { const [aa, mm, dd] = iso.split('-').map(Number); const w = new Date(aa, mm - 1, dd).getDay(); return w !== 0 && w !== 6; };
  let bq = bloquesDe(r.salida);
  ok('sin técnicos con código de operario de Karve: ningún bloque automático; las planificadas quedan sin técnico (≥ 300)', bq && bq.en_fecha === 0 && bq.repartidas === 0 && bq.quitados === 0 && bq.sin_tecnico >= 300, JSON.stringify(bq));
  x = await pedir('/api/usuarios', { cookie: A, metodo: 'POST', body: { usuario: 'karve124', nombre: 'Operario Karve 0000124', rol: 'tecnico', clave: 'prueba-123456', karve_id: '0000124' } });
  const tk = x.j;
  r = importar(['--cerradas=20', '--sin-repartir']);
  bq = bloquesDe(r.salida);
  ok('técnico con el código 0000124 + --sin-repartir: sus O.T. se enlazan (≥ 20 actualizadas) pero, con la fecha vencida, no reciben bloque', x.s === 201 && r.vivas.actualizadas >= 20 && bq && bq.repartidas === 0 && bq.en_fecha === 0 && bq.sin_repartir >= 20, `${x.s} ${JSON.stringify(bq)}`);
  r = importar(['--cerradas=20']);
  bq = bloquesDe(r.salida);
  const repartidas = bq ? bq.repartidas : 0;
  ok('importación normal: sus planificadas se reparten (≥ 20), ninguna sin hueco', bq && repartidas >= 20 && bq.sin_hueco === 0 && bq.quitados === 0 && r.vivas.actualizadas === 0, JSON.stringify(bq));
  x = await pedir(`/api/planificador?desde=${hoyMas(1)}&hasta=${hoyMas(31)}`, { cookie: A });
  const autos = (x.j.bloques || []).filter((bl) => bl.origen === 'karve');
  const porDia = {};
  for (const bl of autos) porDia[bl.dia] = (porDia[bl.dia] || 0) + 1;
  ok('Planificador: bloques automáticos del técnico, de 2 h, 4 por día como mucho, solo en laborables, con la O.T. intacta (versión 1, planificada)', x.s === 200 && autos.length === repartidas && autos.every((bl) => bl.tecnico_id === tk.id && bl.duracion_min === 120 && bl.version === 1 && bl.estado === 'planificada') && Object.values(porDia).every((n) => n <= 4) && Object.keys(porDia).every(laborable) && !x.j.avisos.some((av) => av.tecnico_id === tk.id && av.tipo !== 'zonas'), `autos=${autos.length} dias=${Object.keys(porDia).length} avisos=${x.j.avisos.filter((av) => av.tecnico_id === tk.id).map((av) => av.tipo).join()}`);
  const primero = autos[0];
  x = await pedir(`/api/ot/${primero.ot_id}`, { cookie: A });
  ok('detalle: técnico enlazado, un bloque de origen karve e historial "Planificada automáticamente (Karve): …" sin usuario', x.s === 200 && x.j.tecnico_id === tk.id && x.j.bloques.length === 1 && x.j.bloques[0].origen === 'karve' && /^Planificada automáticamente \(Karve\): /.test(x.j.historial.at(-1).nota) && x.j.historial.at(-1).usuario_id === null, x.j.historial && x.j.historial.at(-1).nota);
  x = await pedir(`/api/ot/${primero.ot_id}/bloques/${primero.id}`, { cookie: A, metodo: 'PUT', body: { hora_inicio: '16:00' } });
  ok('mover un bloque automático → pasa a origen manual y la O.T. sube de versión', x.s === 200 && x.j.bloque.origen === 'manual' && x.j.bloque.hora_inicio === '16:00' && x.j.ot.version === 2, x.t.slice(0, 120));
  r = importar(['--cerradas=20']);
  bq = bloquesDe(r.salida);
  ok('otra importación: nada que repartir ni quitar; la O.T. del bloque movido se conserva (2 conservadas)', bq && bq.repartidas === 0 && bq.quitados === 0 && bq.en_fecha === 0 && r.vivas.conservadas === 2, `${JSON.stringify(bq)} conservadas=${r.vivas.conservadas}`);
  x = await pedir(`/api/ot/${primero.ot_id}`, { cookie: A });
  ok('…y su bloque sigue donde se dejó (manual, 16:00)', x.j.bloques.length === 1 && x.j.bloques[0].hora_inicio === '16:00' && x.j.bloques[0].origen === 'manual');
  x = await pedir(`/api/usuarios/${tk.id}`, { cookie: A, metodo: 'PUT', body: { activo: false } });
  r = importar(['--cerradas=20']);
  bq = bloquesDe(r.salida);
  ok('técnico desactivado: la importación quita sus bloques automáticos de las O.T. no tocadas y las desenlaza', x.s === 200 && bq && bq.quitados === repartidas - 1 && bq.repartidas === 0, JSON.stringify(bq));

  // Cerrar una O.T. en la app (etiqueta facturada) deja fecha_cierre; desaparece del Tablero y sale con ?cerradas=7
  x = await pedir('/api/ot?abiertas=0&limite=1&estado=finalizada&etiqueta=vb_factura', { cookie: A });
  const vb = x.j.ots[0];
  x = await pedir(`/api/ot/${vb.id}/estado`, { cookie: A, metodo: 'POST', body: { estado: 'cerrada', etiqueta: 'facturada', version: vb.version } });
  ok('cerrar una O.T. desde la app → fecha_cierre de hoy y etiqueta facturada', x.s === 200 && x.j.ot.estado === 'cerrada' && x.j.ot.etiqueta === 'facturada' && String(x.j.ot.fecha_cierre || '').startsWith(hoyMenos(0)), `${x.s} ${x.j && x.j.ot && x.j.ot.fecha_cierre}`);
  x = await pedir('/api/kanban', { cookie: A });
  ok('…desaparece del Tablero por defecto', x.s === 200 && !todasLasOT(x.j).some((o) => o.id === vb.id));
  x = await pedir('/api/kanban?cerradas=7', { cookie: A });
  ok('…y aparece en la columna de cerradas con ?cerradas=7', x.s === 200 && x.j.fases.find((f) => f.codigo === 'cerrada').ots.some((o) => o.id === vb.id));

  console.log(res.join('\n'));
  const fallos = res.filter((r2) => r2.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
