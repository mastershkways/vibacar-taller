// Prueba de la interfaz del técnico (F4-05 + F4-06) en Brave headless vía CDP, a tamaño de móvil (390 × 844) y de tablet:
// "Mi día" (grupos, botón único por momento, cronómetro en marcha siempre a la vista), ficha de trabajo a pantalla completa
// (cronómetro con las tres fases, checklist, Parar por hoy / Pausar / Terminar con Terminar bloqueado si falta algo) y lo que ve
// la oficina (fase en el Tablero y el Planificador, tiempos y checklist en el detalle).
// Servidor en 5055 con la BD del seed (ciclo tecniconav). Antes de abrir el navegador, la oficina planifica por la API tres
// O.T. para hoy al técnico (un preventivo y dos correctivos).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-tecnico');
fs.mkdirSync(CAPTURAS, { recursive: true });
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);
const consola = [];
const red = [];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function pedir(ruta, { metodo = 'GET', cookie = '', body } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(BASE + ruta, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { s: r.status, j: json, t: texto };
}
async function login(usuario, clave) {
  const r = await fetch(BASE + '/acceso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  if (r.status !== 200) throw new Error(`login ${usuario} → ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function abrirPestana() {
  const r = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  const info = await r.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((r2, rej) => { ws.onopen = r2; ws.onerror = rej; });
  let id = 0; const pendientes = new Map(); const oyentes = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pendientes.has(m.id)) { const { r: rr, j } = pendientes.get(m.id); pendientes.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : rr(m.result); }
    else if (m.method) for (const o of oyentes) o(m.method, m.params);
  };
  const enviar = (method, params = {}) => new Promise((rr, j) => { const i = ++id; pendientes.set(i, { r: rr, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  const esperarEvento = (metodo, timeout = 10000) => new Promise((rr, j) => {
    const t = setTimeout(() => j(new Error(`timeout ${metodo}`)), timeout);
    const o = (m, p) => { if (m === metodo) { clearTimeout(t); oyentes.splice(oyentes.indexOf(o), 1); rr(p); } };
    oyentes.push(o);
  });
  oyentes.push((m, p) => {
    if (m === 'Runtime.exceptionThrown') consola.push(`EXCEPCIÓN: ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description || ''}`);
    if (m === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) consola.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m === 'Network.responseReceived' && p.response.status >= 400) red.push(`${p.response.status} ${p.response.url.replace(BASE, '')}`);
  });
  await enviar('Page.enable'); await enviar('Runtime.enable'); await enviar('Network.enable');
  await enviar('Emulation.setFocusEmulationEnabled', { enabled: true });
  return { enviar, esperarEvento, cerrar: () => ws.close() };
}
const evaluar = async (p, expr) => {
  const r = await p.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}\n${expr.slice(0, 200)}`);
  return r.result.value;
};
const esperarHasta = async (p, expr, timeout = 8000) => { const fin = Date.now() + timeout; while (Date.now() < fin) { if (await evaluar(p, expr)) return true; await dormir(150); } return false; };
const captura = async (p, nombre) => { const r = await p.enviar('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(CAPTURAS, `${nombre}.png`), Buffer.from(r.data, 'base64')); };
const navegar = async (p, url) => { const nav = p.esperarEvento('Page.loadEventFired'); await p.enviar('Page.navigate', { url }); await nav; };
const salir = async (p) => { const nav = p.esperarEvento('Page.loadEventFired'); await evaluar(p, `document.querySelector('header form').requestSubmit()`); await nav; };
async function entrar(p, usuario, clave) {
  await navegar(p, `${BASE}/`);
  if ((await evaluar(p, 'location.pathname')) !== '/acceso') { await salir(p); await navegar(p, `${BASE}/`); }
  const nav = p.esperarEvento('Page.loadEventFired');
  await evaluar(p, `(() => { document.getElementById('usuario').value = ${JSON.stringify(usuario)}; document.getElementById('clave').value = ${JSON.stringify(clave)}; document.getElementById('formulario').requestSubmit(); })()`);
  await nav;
  ok(`login ${usuario} → /`, (await evaluar(p, 'location.pathname')) === '/');
}
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 3000);
const tamano = (p, width, height) => p.enviar('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
const clic = (p, sel) => evaluar(p, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const texto = (p, sel) => evaluar(p, `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const sinDesborde = (p) => evaluar(p, `document.documentElement.scrollWidth <= window.innerWidth + 1`);
// Tareas de "Mi día": por grupo, con su hora, nº y texto del botón principal.
const tareas = (p) => evaluar(p, `[...document.querySelectorAll('.grupo')].flatMap(g => [...g.querySelectorAll('.tarea')].map(t => ({ grupo: g.dataset.grupo, id: Number(t.dataset.id), hora: t.querySelector('.tarea-hora').textContent.trim(), num: t.querySelector('.tarea-num').textContent, boton: t.querySelector('[data-accion=principal]').textContent, fase: [...t.querySelector('[data-accion=principal]').classList].find(c => c.startsWith('fase-')) || '', chips: [...t.querySelectorAll('.dato-chip')].map(c => c.textContent.trim()), crono: t.classList.contains('con-crono') })))`);
const ficha = (p) => evaluar(p, `(() => { const f = document.querySelector('.ficha'); if (!f) return null; const b = (a) => f.querySelector('[data-accion=' + a + ']'); return {
  numero: f.querySelector('[data-ref=numero]').textContent, activa: (f.querySelector('.fase.activa') || { dataset: {} }).dataset.fase || '', enMarcha: f.querySelector('.crono').classList.contains('en-marcha'),
  faseTexto: f.querySelector('[data-ref=fase]').textContent, reloj: f.querySelector('[data-ref=reloj]').textContent, pista: f.querySelector('[data-ref=pista]').textContent,
  parar: !b('parar').disabled, pausar: !b('pausar').disabled, terminar: !b('terminar').disabled,
  falta: f.querySelector('[data-ref=falta]').classList.contains('oculto') ? '' : f.querySelector('[data-ref=falta]').textContent,
  tramos: f.querySelectorAll('[data-ref=tramos] li[class^=fase-]').length, puntos: [...f.querySelectorAll('.punto')].map(x => x.dataset.resultado), progreso: f.querySelector('[data-ref=progreso]').textContent,
  checklistVisible: !f.querySelector('[data-ref=sec-checklist]').classList.contains('oculto') }; })()`);
const enFicha = (p, numero) => esperarHasta(p, `document.body.classList.contains('modo-ficha') && (document.querySelector('.ficha [data-ref=numero]') || {}).textContent === ${JSON.stringify(numero)} && !document.querySelector('.fase:disabled')`);
const enMiDia = (p) => esperarHasta(p, `location.hash === '#midia' && !document.body.classList.contains('modo-ficha') && !!document.querySelector('.midia') && !document.querySelector('.midia .vacio:only-child')?.textContent.includes('Cargando')`);

(async () => {
  // --- Preparación por la API: tres O.T. para hoy a Mikel (tecnico1) ------------------------------------------------------
  const A = await login('admin_prueba', 'clave-prueba-123');
  const R = await login('responsable1', 'prueba123');
  const buscar = async (q) => (await pedir(`/api/ot?abiertas=0&q=${encodeURIComponent(q)}`, { cookie: A })).j.ots[0];
  const mikel = (await pedir('/api/tecnicos', { cookie: A })).j.find((t) => /Mikel/.test(t.nombre));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const HOY = iso(new Date());
  const torreta = await buscar('torreta');            // en curso, con bloque hoy a las 08:00
  const rev500 = await buscar('Revisión 500 h');      // preventivo
  const garaio = await buscar('No arranca en fr');
  const luces = await buscar('Luces de trabajo');
  let x = await pedir(`/api/ot/${rev500.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: HOY, hora_inicio: '10:00', duracion_min: 60 } });
  const y = await pedir(`/api/ot/${garaio.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: HOY, hora_inicio: '12:00', nota: 'Llevar comprobador de baterías' } });
  const z = await pedir(`/api/ot/${luces.id}/bloques`, { cookie: R, metodo: 'POST', body: { tecnico_id: mikel.id, dia: HOY, hora_inicio: '16:00', duracion_min: 90 } });
  ok('preparación: tres bloques de hoy para el técnico', x.s === 201 && y.s === 201 && z.s === 201, `${x.s} ${y.s} ${z.s}`);

  const p = await abrirPestana();
  await tamano(p, 390, 844);

  // --- Mi día en el móvil -----------------------------------------------------------------------------------------------------
  await entrar(p, 'tecnico1', 'prueba123');
  ok('técnico: entra en "Mi día" (pestaña activa) con sus tareas', await esperarHasta(p, `document.querySelectorAll('.tarea').length === 4`) && (await texto(p, '#nav button.activo')) === 'Mi día' && (await texto(p, '.midia-barra h2')) === 'Mi día');
  let ts = await tareas(p);
  ok('grupos: 1 en curso y 3 de hoy ordenadas por hora (10:00, 12:00, 16:00)', ts.map((t) => t.grupo).join() === 'en_curso,hoy,hoy,hoy' && ts.slice(1).map((t) => t.hora.slice(0, 5)).join() === '10:00,12:00,16:00', JSON.stringify(ts.map((t) => [t.grupo, t.hora])));
  ok('botón único por momento: "Continuar" en la que está en curso sin cronómetro y "Salir hacia el cliente" (azul) en las planificadas', /Continuar/.test(ts[0].boton) && ts.slice(1).every((t) => /Salir hacia el cliente/.test(t.boton) && t.fase === 'fase-desplazamiento'), JSON.stringify(ts.map((t) => t.boton)));
  ok('el preventivo enseña "Checklist 0/4" y "Preventivo"', ts[1].id === rev500.id && ts[1].chips.some((c) => /Checklist 0\/4/.test(c)) && ts[1].chips.includes('Preventivo'), JSON.stringify(ts[1].chips));
  ok('resumen del día con las tres fases y el total; sin cronómetro en marcha no hay aviso arriba', (await evaluar(p, `[...document.querySelectorAll('.midia-resumen .pill span')].map(s => s.textContent.replace(/^\\S+ /, '')).join('|')`)) === 'Desplazamiento|Espera de acceso|Trabajo|hoy' && (await evaluar(p, `document.querySelector('[data-ref=crono-banner]').classList.contains('oculto')`)), await evaluar(p, `[...document.querySelectorAll('.midia-resumen .pill span')].map(s => s.textContent).join('|')`));
  ok('móvil: sin desplazamiento horizontal y botones de al menos 56 px de alto', (await sinDesborde(p)) && (await evaluar(p, `[...document.querySelectorAll('.tarea-botones .btn')].every(b => b.getBoundingClientRect().height >= 56)`)), `ancho=${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  ok('la nota de la oficina se ve en la tarjeta', /Llevar comprobador de baterías/.test(await texto(p, `.tarea[data-id="${garaio.id}"] .tarea-nota`)));
  await captura(p, '01-midia-movil');

  // --- Un botón por momento: Salir → He llegado → Empezar trabajo -------------------------------------------------------------
  await clic(p, `.tarea[data-id="${garaio.id}"] [data-accion=principal]`);
  ok('Salir: aparece arriba el cronómetro en marcha (Desplazamiento, nº de la O.T.) y lleva a su ficha', await esperarHasta(p, `!document.querySelector('[data-ref=crono-banner]').classList.contains('oculto')`) && /Desplazamiento/.test(await texto(p, '.crono-banner')) && (await texto(p, '.crono-banner')).includes(garaio.numero) && (await evaluar(p, `document.querySelector('.crono-banner').getAttribute('href')`)) === `#trabajo/${garaio.id}`, await texto(p, '.crono-banner'));
  await esperarHasta(p, `!!document.querySelector('.tarea[data-id="${garaio.id}"].con-crono')`);
  ts = await tareas(p);
  const tg = ts.find((t) => t.id === garaio.id);
  ok('…la tarjeta pasa a "En curso" con el botón "He llegado" (ámbar)', tg.grupo === 'en_curso' && /He llegado/.test(tg.boton) && tg.fase === 'fase-espera' && tg.crono, JSON.stringify(tg));
  const r1 = await texto(p, '[data-ref=banner-reloj]');
  await dormir(2200);
  const r2 = await texto(p, '[data-ref=banner-reloj]');
  ok('el reloj avanza solo', /^\d\d:\d\d:\d\d$/.test(r1) && r2 > r1, `${r1} → ${r2}`);
  await captura(p, '02-midia-desplazamiento');
  await clic(p, `.tarea[data-id="${garaio.id}"] [data-accion=principal]`);
  ok('He llegado: fase "Espera de acceso" y el botón pasa a "Empezar trabajo" (verde)', await esperarHasta(p, `/Empezar trabajo/.test((document.querySelector('.tarea[data-id="${garaio.id}"] [data-accion=principal]') || {}).textContent || '')`) && /Espera de acceso/.test(await texto(p, '.crono-banner')) && (await tareas(p)).find((t) => t.id === garaio.id).fase === 'fase-trabajo');

  // --- Ficha de trabajo: pantalla completa, cronómetro fijo, tres fases ------------------------------------------------------
  await clic(p, `.tarea[data-id="${garaio.id}"] [data-accion=ficha]`);
  ok('Ficha: se abre a pantalla completa (sin la cabecera general) con el nº de la O.T.', await enFicha(p, garaio.numero) && (await evaluar(p, `location.hash === '#trabajo/${garaio.id}' && getComputedStyle(document.querySelector('header.cabecera')).display === 'none'`)));
  let f = await ficha(p);
  ok('cronómetro: fase activa "Espera de acceso", reloj en marcha y pista del siguiente paso', f.activa === 'espera' && f.enMarcha && /Espera de acceso · desde las \d\d:\d\d/.test(f.faseTexto) && /^\d\d:\d\d:\d\d$/.test(f.reloj) && /pulsa Trabajo/.test(f.pista), JSON.stringify([f.activa, f.faseTexto, f.pista]));
  ok('las tres fases, cada una con su total', (await evaluar(p, `[...document.querySelectorAll('.fase')].map(b => b.dataset.fase + ':' + b.querySelector('.fase-nombre').textContent + ':' + /min|h/.test(b.querySelector('.fase-total').textContent)).join('|')`)) === 'desplazamiento:Desplazamiento:true|espera:Espera de acceso:true|trabajo:Trabajo:true');
  ok('Terminar bloqueado sin tiempo de Trabajo, con el motivo a la vista; Parar por hoy y Pausar disponibles', !f.terminar && f.parar && f.pausar && f.falta === 'Para terminar falta: fichar tiempo de Trabajo.', JSON.stringify([f.terminar, f.falta]));
  ok('datos del cliente: dirección con enlace al mapa, teléfono de contacto pulsable y nota de la oficina', (await evaluar(p, `!!document.querySelector('.ficha-datos a[href*="google.com/maps"]') && !!document.querySelector('.ficha-datos a[href^="tel:"]')`)) && /Llevar comprobador de baterías/.test(await texto(p, '.ficha-datos')), (await texto(p, '.ficha-datos')).slice(0, 200));
  ok('móvil: la ficha no desborda a lo ancho; acciones pegadas abajo y cronómetro pegado arriba al desplazar', (await sinDesborde(p)) && (await evaluar(p, `(() => { window.scrollTo(0, 400); const a = document.querySelector('.ficha-acciones').getBoundingClientRect(); const c = document.querySelector('.crono').getBoundingClientRect(); const r = Math.abs(a.bottom - window.innerHeight) <= 1 && c.top <= 1 && c.top >= -1; window.scrollTo(0, 0); return r; })()`)));
  await captura(p, '03-ficha-espera');
  await clic(p, '.fase[data-fase=trabajo]');
  ok('pulsar Trabajo: la fase activa cambia, el borde del cronómetro pasa a verde y Terminar se desbloquea (correctivo, sin checklist)', await esperarHasta(p, `(document.querySelector('.fase.activa') || { dataset: {} }).dataset.fase === 'trabajo' && document.querySelector('.crono').classList.contains('fase-trabajo') && !document.querySelector('[data-accion=terminar]').disabled`));
  f = await ficha(p);
  ok('…tres tramos fichados (desplazamiento, espera, trabajo), sin checklist y sin aviso de "falta"', f.tramos === 3 && !f.checklistVisible && f.falta === '', JSON.stringify([f.tramos, f.checklistVisible, f.falta]));

  // --- Parar por hoy: nota opcional, vuelve a Mi día y la O.T. sigue ahí --------------------------------------------------------
  await clic(p, '[data-accion=parar]');
  ok('Parar por hoy: modal que explica que sigue en su tablero y que para lo demás está Pausar', await esperarHasta(p, `!!document.querySelector('#modales [data-ref=nota]')`) && (await texto(p, '#modales [data-ref=titulo]')) === 'Parar por hoy' && /sigue en tu tablero/.test(await texto(p, '#modales [data-ref=pista]')) && /usa Pausar/.test(await texto(p, '#modales [data-ref=pista]')));
  await evaluar(p, `document.querySelector('#modales [data-ref=nota]').value = 'Sigo mañana a primera hora'`);
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…vuelve a Mi día, sin cronómetro, con la O.T. en "En curso" (botón Continuar) y su tiempo fichado', await enMiDia(p) && await esperarHasta(p, `document.querySelector('[data-ref=crono-banner]').classList.contains('oculto') && /Continuar/.test((document.querySelector('.tarea[data-id="${garaio.id}"] [data-accion=principal]') || {}).textContent || '')`) && (await tareas(p)).find((t) => t.id === garaio.id).chips.some((c) => /fichados/.test(c)));
  await sinModal(p);

  // --- Preventivo: checklist y Terminar bloqueado hasta responderlo todo -------------------------------------------------------
  await clic(p, `.tarea[data-id="${rev500.id}"] .tarea-cliente`);
  ok('tocar la tarjeta abre su ficha', await enFicha(p, rev500.numero));
  f = await ficha(p);
  ok('checklist visible con los 4 puntos de la plantilla, 0 de 4', f.checklistVisible && f.puntos.length === 4 && f.progreso === '0 de 4' && (await evaluar(p, `[...document.querySelectorAll('.punto-texto')].map(t => t.textContent).join('|')`)) === 'Revisión visual|Niveles|Engrase|Pruebas de funcionamiento', f.progreso);
  ok('sin empezar: Parar por hoy desactivado, Terminar bloqueado por las dos cosas', !f.parar && !f.terminar && f.falta === 'Para terminar falta: fichar tiempo de Trabajo y responder el checklist (0 de 4).' && /Sin empezar/.test(f.faseTexto), f.falta);
  await clic(p, '.fase[data-fase=trabajo]');
  await esperarHasta(p, `(document.querySelector('.fase.activa') || { dataset: {} }).dataset.fase === 'trabajo'`);
  f = await ficha(p);
  ok('con Trabajo en marcha ya solo falta el checklist', !f.terminar && f.falta === 'Para terminar falta: responder el checklist (0 de 4).', f.falta);
  const punto = (n) => `.punto:nth-child(${n})`;
  await clic(p, `${punto(1)} [data-res=hecho]`);
  ok('punto 1 "Hecho": queda marcado y cuenta 1 de 4', await esperarHasta(p, `document.querySelector('${punto(1)}').dataset.resultado === 'hecho' && document.querySelector('[data-ref=progreso]').textContent === '1 de 4'`));
  await clic(p, `${punto(2)} [data-res=no_aplica]`);
  await esperarHasta(p, `document.querySelector('${punto(2)}').dataset.resultado === 'no_aplica'`);
  await clic(p, `${punto(3)} [data-res=incidencia]`);
  ok('punto 3 "Incidencia": pide la nota en un modal', await esperarHasta(p, `!!document.querySelector('#modales [data-ref=nota]')`) && (await texto(p, '#modales [data-ref=titulo]')) === 'Engrase');
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…sin nota no deja guardar', await esperarHasta(p, `/Escribe la nota/.test((document.querySelector('#modales .aviso') || {}).textContent || '')`));
  await evaluar(p, `document.querySelector('#modales [data-ref=nota]').value = 'Engrasador del bulón roto'`);
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…con nota queda como incidencia y la nota se ve en el punto', await esperarHasta(p, `document.querySelector('${punto(3)}').dataset.resultado === 'incidencia' && /Engrasador del bulón roto/.test(document.querySelector('${punto(3)} .punto-nota').textContent)`));
  await sinModal(p);
  await clic(p, `${punto(4)} [data-res=hecho]`);
  ok('punto 4: checklist 4 de 4 → Terminar se desbloquea y desaparece el aviso', await esperarHasta(p, `document.querySelector('[data-ref=progreso]').textContent === '4 de 4' && !document.querySelector('[data-accion=terminar]').disabled && document.querySelector('[data-ref=falta]').classList.contains('oculto')`));
  await clic(p, `${punto(1)} [data-res=hecho]`);
  ok('volver a pulsar el elegido lo deja sin responder → Terminar se bloquea otra vez', await esperarHasta(p, `document.querySelector('${punto(1)}').dataset.resultado === '' && document.querySelector('[data-accion=terminar]').disabled && /responder el checklist \\(3 de 4\\)/.test(document.querySelector('[data-ref=falta]').textContent)`));
  await clic(p, `${punto(1)} [data-res=hecho]`);
  await esperarHasta(p, `!document.querySelector('[data-accion=terminar]').disabled`);
  await evaluar(p, `document.querySelector('[data-ref=sec-checklist]').scrollIntoView({ block: 'start' })`);
  await dormir(300);
  await captura(p, '04-ficha-checklist');
  ok('móvil: los botones del checklist miden al menos 48 px y no desbordan', (await sinDesborde(p)) && (await evaluar(p, `[...document.querySelectorAll('.punto-botones .btn')].every(b => b.getBoundingClientRect().height >= 48)`)));

  // --- Terminar -------------------------------------------------------------------------------------------------------------
  await clic(p, '[data-accion=terminar]');
  ok('Terminar: modal de dos preguntas hacia Finalizada, en modo tablet', await esperarHasta(p, `!!document.querySelector('#modales .modal-fondo.tablet [data-ref=nota]')`) && /Finalizada/.test(await texto(p, '#modales [data-ref=titulo]')));
  await evaluar(p, `document.querySelector('#modales [data-ref=nota]').value = 'Revisión de 500 h hecha; engrasador pendiente'`);
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…al confirmar vuelve a Mi día y la O.T. finalizada ya no está', await enMiDia(p) && await esperarHasta(p, `document.querySelectorAll('.tarea').length === 3 && !document.querySelector('.tarea[data-id="${rev500.id}"]')`));
  await sinModal(p);

  // --- Pausar: pide motivo y la O.T. sale de su tablero ------------------------------------------------------------------------
  await clic(p, `.tarea[data-id="${torreta.id}"] [data-accion=principal]`);
  await enFicha(p, torreta.numero);
  await clic(p, '.fase[data-fase=trabajo]');
  await esperarHasta(p, `(document.querySelector('.fase.activa') || { dataset: {} }).dataset.fase === 'trabajo'`);
  ok('los textos de los botones dejan clara la diferencia entre Parar por hoy y Pausar', (await texto(p, '[data-accion=parar] small')) === 'Sigue en tu tablero' && (await texto(p, '[data-accion=pausar] small')) === 'Falta algo: sale de tu tablero' && (await texto(p, '[data-accion=terminar] small')) === 'Trabajo hecho');
  await clic(p, '[data-accion=pausar]');
  ok('Pausar: el modal avisa de que sale de su tablero y exige motivo y nota', await esperarHasta(p, `!!document.querySelector('#modales [data-ref=opcion]')`) && /sale de tu tablero/.test(await texto(p, '#modales [data-ref=desde]')) && (await evaluar(p, `document.querySelector('#modales [data-ref=opcion]').required`)));
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…sin motivo no deja pausar', await esperarHasta(p, `/Elige el motivo/.test((document.querySelector('#modales .aviso') || {}).textContent || '')`));
  await evaluar(p, `(() => { document.querySelector('#modales [data-ref=opcion]').value = 'repuesto'; document.querySelector('#modales [data-ref=nota]').value = 'Falta el rodamiento de la corona'; })()`);
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…con motivo: vuelve a Mi día y la O.T. pausada desaparece de su vista', await enMiDia(p) && await esperarHasta(p, `document.querySelectorAll('.tarea').length === 2 && !document.querySelector('.tarea[data-id="${torreta.id}"]')`) && (await evaluar(p, `document.querySelector('[data-ref=crono-banner]').classList.contains('oculto')`)));
  await sinModal(p);

  // --- Un solo cronómetro: al empezar otra O.T. pregunta antes de parar la primera ----------------------------------------------
  await clic(p, `.tarea[data-id="${garaio.id}"] [data-accion=principal]`);
  await enFicha(p, garaio.numero);
  await clic(p, '.fase[data-fase=trabajo]');
  await esperarHasta(p, `(document.querySelector('.fase.activa') || { dataset: {} }).dataset.fase === 'trabajo'`);
  await clic(p, '[data-accion=volver]');
  await enMiDia(p);
  await esperarHasta(p, `!!document.querySelector('.tarea[data-id="${luces.id}"] [data-accion=principal]')`);
  await clic(p, `.tarea[data-id="${luces.id}"] [data-accion=principal]`);
  ok('con el cronómetro en una O.T., salir hacia otra pregunta si se para la primera', await esperarHasta(p, `/Tienes el cronómetro en marcha en la O\\.T\\. ${garaio.numero}/.test((document.querySelector('#modales [data-ref=titulo]') || {}).textContent || '')`), await texto(p, '#modales [data-ref=titulo]'));
  await clic(p, '#modales [data-ref=opciones] button');
  ok('…al aceptar, el cronómetro pasa a la nueva O.T. (Desplazamiento) y la anterior queda parada', await esperarHasta(p, `(document.querySelector('.crono-banner') || {}).textContent.includes(${JSON.stringify(luces.numero)}) && !document.querySelector('.tarea[data-id="${garaio.id}"].con-crono')`) && /Desplazamiento/.test(await texto(p, '.crono-banner')));
  await sinModal(p);

  // --- Tablet y rutas -----------------------------------------------------------------------------------------------------------
  await tamano(p, 1024, 768);
  await dormir(300);
  ok('tablet (1024 × 768): Mi día sin desborde', await sinDesborde(p));
  await captura(p, '05-midia-tablet');
  await evaluar(p, `location.hash = 'trabajo/${luces.id}'`);
  await enFicha(p, luces.numero);
  ok('tablet: ficha sin desborde, con las acciones abajo', (await sinDesborde(p)) && (await evaluar(p, `Math.abs(document.querySelector('.ficha-acciones').getBoundingClientRect().bottom - window.innerHeight) <= 1`)));
  await captura(p, '06-ficha-tablet');
  await evaluar(p, `location.hash = 'misot'`);
  ok('la ruta antigua #misot lleva a Mi día', await esperarHasta(p, `!!document.querySelector('.midia') && !document.body.classList.contains('modo-ficha') && document.querySelector('#nav button.activo').textContent === 'Mi día'`));

  // --- Lo que ve la oficina -------------------------------------------------------------------------------------------------------
  await tamano(p, 1600, 950);
  await salir(p);
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await esperarHasta(p, `document.querySelectorAll('.tarjeta').length > 5`);
  ok('Tablero: la tarjeta de la O.T. con el cronómetro en marcha enseña la fase', (await evaluar(p, `(() => { const t = document.querySelector('.tarjeta[data-id="${luces.id}"] .dato-chip'); return t ? t.textContent : ''; })()`)).includes('Desplazamiento desde las'), await evaluar(p, `(document.querySelector('.tarjeta[data-id="${luces.id}"] .dato-chip') || {}).textContent || ''`));
  await evaluar(p, `location.hash = 'ot/${rev500.id}'`);
  ok('detalle de la O.T.: tiempos fichados por fase y checklist con la incidencia', await esperarHasta(p, `!!document.querySelector('#modales [data-ref=fila-tiempos]:not(.oculto)')`) && /Trabajo/.test(await texto(p, '#modales [data-ref=tiempos]')) && /4 de 4 respondidos · ⚠ Engrase: Engrasador del bulón roto/.test(await texto(p, '#modales [data-ref=checklist]')), await texto(p, '#modales [data-ref=checklist]'));
  await evaluar(p, `document.querySelector('#modales [data-accion=cerrar]').click()`);
  await sinModal(p);
  await evaluar(p, `location.hash = 'trabajo/${luces.id}'`);
  ok('la oficina no usa la ficha del técnico: #trabajo/ID le abre el detalle de siempre', await esperarHasta(p, `!!document.querySelector('#modales [data-ot-id="${luces.id}"]') && !document.body.classList.contains('modo-ficha')`));
  await evaluar(p, `document.querySelector('#modales [data-accion=cerrar]').click()`);
  await sinModal(p);
  await evaluar(p, `location.hash = 'planificador'`);
  ok('Planificador: el bloque de la O.T. con el cronómetro en marcha lleva el punto de la fase', await esperarHasta(p, `!!document.querySelector('.bloque[data-ot="${luces.id}"] .crono-punto.fase-desplazamiento')`));
  await captura(p, '07-planificador-crono');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  if (consola.length) res.push('FALLO consola con errores');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
