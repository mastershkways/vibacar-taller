// Prueba de la interfaz de fichajes (F4-07 + F4-08) en Brave headless vía CDP: en el móvil (390 × 844), el técnico ve en
// "Mi día" el aviso de los días que no llegan a la jornada y la tarjeta "Horas sin O.T." (comodín), y en "Mis horas" pide
// correcciones; en escritorio, la oficina ve "Fichajes" (jornadas de todos + incidencias), aprueba, rechaza y corrige
// directamente; gerencia solo mira.
// Servidor en 5055 con la BD del seed (ciclo fichajesnav). Antes de abrir el navegador, la oficina añade por la API un
// fichaje de 4 h a Mikel dos días laborables atrás: así ese día queda "bajo" y el siguiente, "sin fichar".
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-fichajes');
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
const conModal = (p, sel = '') => esperarHasta(p, `!!document.querySelector('#modales .modal-fondo:not(.cerrando) ${sel}')`, 4000);
const tamano = (p, width, height, mobile = true) => p.enviar('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const clic = (p, sel) => evaluar(p, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
const clicTexto = (p, sel, patron) => evaluar(p, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => ${patron}.test(e.textContent)); if (!el) return false; el.click(); return true; })()`);
const texto = (p, sel) => evaluar(p, `(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const sinDesborde = (p) => evaluar(p, `document.documentElement.scrollWidth <= window.innerWidth + 1`);
// Rellena el diálogo de corrección (los campos que se pasen) y lo envía.
const rellenar = (p, campos, enviar = true) => evaluar(p, `(() => {
  const f = document.querySelector('#modales [data-ref=form]'); if (!f) return false;
  const c = ${JSON.stringify(campos)};
  for (const k of ['destino', 'tipo', 'ot_numero', 'inicio', 'fin', 'motivo']) {
    if (c[k] === undefined) continue;
    f.elements[k].value = c[k];
    f.elements[k].dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (${enviar}) f.requestSubmit();
  return true; })()`);
const toastCon = (p, patron) => esperarHasta(p, `[...document.querySelectorAll('#toasts .toast')].some(t => ${patron}.test(t.textContent))`, 5000);
const dia = (p, d) => evaluar(p, `(() => { const el = document.querySelector('.dia[data-dia="${d}"]'); if (!el) return null; return {
  abierto: el.open, clase: el.className, total: el.querySelector('.dia-total').textContent, chips: [...el.querySelectorAll('.dia-estado .dato-chip')].map(c => c.textContent),
  tramos: [...el.querySelectorAll('.tramos-dia li')].map(li => ({ hora: li.querySelector('.tr-hora').textContent, que: li.querySelector('.tr-que').textContent, marcas: [...li.querySelectorAll('.tr-marcas .dato-chip')].map(c => c.textContent), botones: [...li.querySelectorAll('.tr-botones button')].map(b => b.textContent) })),
  cargado: !/Cargando/.test(el.querySelector('.dia-cuerpo').textContent), vacio: (el.querySelector('.dia-cuerpo .vacio') || {}).textContent || '', anadir: (el.querySelector('[data-accion=anadir]') || {}).textContent || '' }; })()`);
const diaCargado = (p, d) => esperarHasta(p, `(() => { const el = document.querySelector('.dia[data-dia="${d}"]'); return !!el && el.open && !/Cargando/.test(el.querySelector('.dia-cuerpo').textContent); })()`);
const incidencias = (p, raiz) => evaluar(p, `[...document.querySelectorAll('${raiz} .incidencia')].map(i => ({ id: Number(i.dataset.id), clase: i.className, cab: i.querySelector('.inc-cab').textContent, cambio: i.querySelector('.inc-cambio').textContent, estado: i.querySelector('.inc-cab .chip').textContent, botones: [...i.querySelectorAll('.inc-botones button')].map(b => b.dataset.accion) }))`);
const celda = (p, tecnicoId, d) => evaluar(p, `(() => { const td = document.querySelector('tr[data-tecnico="${tecnicoId}"] td[data-dia="${d}"]'); return td ? { clase: td.className, texto: td.textContent, marca: !!td.querySelector('.marca') } : null; })()`);

(async () => {
  // --- Preparación por la API ---------------------------------------------------------------------------------------------
  const A = await login('admin_prueba', 'clave-prueba-123');
  const M = await login('tecnico1', 'prueba123');
  const buscar = async (q) => (await pedir(`/api/ot?abiertas=0&q=${encodeURIComponent(q)}`, { cookie: A })).j.ots[0];
  const mikel = (await pedir('/api/tecnicos', { cookie: A })).j.find((t) => /Mikel/.test(t.nombre));
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const HOY = iso(new Date());
  const laborablesAntes = (n) => { const r = []; const d = new Date(); while (r.length < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) r.push(iso(d)); } return r; };
  const [D1, D2] = laborablesAntes(2);
  const MESES_ATRAS = (HOY.slice(0, 4) - D2.slice(0, 4)) * 12 + (HOY.slice(5, 7) - D2.slice(5, 7));   // 0, o 1 si D2 cae en el mes anterior
  const torreta = await buscar('torreta');            // en curso, de Mikel, con bloque hoy
  let x = await pedir('/api/incidencias', { cookie: A, metodo: 'POST', body: { accion: 'anadir', tecnico_id: mikel.id, dia: D2, ot_id: torreta.id, tipo: 'trabajo', inicio: '08:00', fin: '12:00', motivo: 'Parte en papel' } });
  ok('preparación: la oficina añade 4 h de trabajo a Mikel dos laborables atrás', x.s === 201 && x.j.incidencia.estado === 'aprobada', `${x.s}`);

  const p = await abrirPestana();
  await tamano(p, 390, 844);

  // --- Mi día en el móvil: aviso de jornadas y comodín ---------------------------------------------------------------------
  await entrar(p, 'tecnico1', 'prueba123');
  ok('técnico: el menú tiene "Mis horas" y no "Fichajes"', await esperarHasta(p, `!!document.querySelector('.seccion-comodin')`) && (await evaluar(p, `[...document.querySelectorAll('#nav button[data-vista]')].map(b => b.dataset.vista).join()`)) === 'midia,horas,listado', await evaluar(p, `[...document.querySelectorAll('#nav button[data-vista]')].map(b => b.dataset.vista).join()`));
  const avisoDias = await evaluar(p, `[...document.querySelectorAll('.aviso-jornada .dia-bajo')].map(b => ({ dia: b.dataset.dia, texto: b.textContent }))`);
  ok('aviso arriba: dos días no llegan a las 8 h (uno con 4 h fichadas, otro sin fichar)', /2 días no llegan a las 8 h/.test(await texto(p, '.aviso-jornada h3')) && avisoDias.length === 2 && avisoDias[0].dia === D2 && /4 h fichados.*faltan 4 h/.test(avisoDias[0].texto) && avisoDias[1].dia === D1 && /sin fichar.*faltan 8 h/.test(avisoDias[1].texto), JSON.stringify(avisoDias));
  ok('tarjeta "Horas sin O.T." con el código del comodín del mes y su botón', /Horas sin O\.T\./.test(await texto(p, '.seccion-comodin h3')) && new RegExp(`CM-${HOY.slice(0, 7).replace('-', '')}-`).test(await texto(p, '.comodin-tarjeta')) && /Imputar horas sin O\.T\./.test(await texto(p, '.comodin-tarjeta [data-accion=empezar-comodin]')));
  ok('…no cuenta como tarea y el resumen sigue con las tres fases y el total', (await evaluar(p, `document.querySelectorAll('.tarea').length`)) === 1 && (await evaluar(p, `document.querySelectorAll('.midia-resumen .pill').length`)) === 4);
  ok('móvil: sin desplazamiento horizontal', await sinDesborde(p), `ancho=${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '01-midia-aviso-comodin');

  await clic(p, '.comodin-tarjeta [data-accion=empezar-comodin]');
  ok('Imputar: pregunta el concepto con los cuatro de la lista', await conModal(p, '.opciones button') && (await evaluar(p, `[...document.querySelectorAll('#modales .opciones button')].map(b => b.textContent).join('|')`)) === 'Trabajos de taller|Formación|Sin trabajo asignado|Otros');
  await captura(p, '02-comodin-conceptos');
  await clicTexto(p, '#modales .opciones button', '/^Formación$/');
  ok('…al elegir "Formación" arranca: aviso arriba con "Sin O.T. · Formación", reloj y botón Parar', await esperarHasta(p, `!document.querySelector('[data-ref=crono-banner]').classList.contains('oculto')`) && /Sin O\.T\..*Formación/.test(await texto(p, '.crono-banner .cb-texto')) && (await evaluar(p, `document.querySelector('.crono-banner').classList.contains('fase-comodin') && !!document.querySelector('.crono-banner [data-accion=parar-comodin]')`)), await texto(p, '.crono-banner'));
  ok('…la tarjeta pasa a "en marcha" con Parar y Cambiar, y el resumen gana la casilla "Sin O.T."', await esperarHasta(p, `!!document.querySelector('.comodin-tarjeta.con-crono [data-accion=parar-comodin]')`) && (await evaluar(p, `document.querySelectorAll('.midia-resumen .pill').length`)) === 5 && /Sin O\.T\./.test(await texto(p, '.midia-resumen .pill.fase-comodin')));
  const r1 = await texto(p, '[data-ref=banner-reloj]');
  await dormir(2200);
  const r2 = await texto(p, '[data-ref=banner-reloj]');
  ok('…y el reloj avanza solo', r1 !== r2 && /^\d\d:\d\d:\d\d$/.test(r2), `${r1} → ${r2}`);
  ok('móvil: con el comodín en marcha tampoco hay desplazamiento horizontal', await sinDesborde(p));
  await captura(p, '03-comodin-en-marcha');

  // Con el comodín en marcha, abrir una O.T. y fichar en ella pregunta antes de pararlo.
  await clic(p, `.tarea[data-id="${torreta.id}"] [data-accion=principal]`);
  ok('ficha de una O.T.: avisa de que el cronómetro está en el comodín', await esperarHasta(p, `document.body.classList.contains('modo-ficha') && /en el comodín \\(Formación\\)/.test((document.querySelector('.ficha [data-ref=avisos]') || {}).textContent || '')`), await texto(p, '.ficha [data-ref=avisos]'));
  await esperarHasta(p, `!document.querySelector('.fase:disabled')`);
  await clic(p, '.fase[data-fase=trabajo]');
  ok('…al pulsar "Trabajo" pregunta si se para el comodín', await conModal(p, '.opciones button') && /en el comodín \(Formación\)\. ¿Lo paras y empiezas en esta\?/.test(await texto(p, '#modales [data-ref=titulo]')), await texto(p, '#modales [data-ref=titulo]'));
  await clic(p, '#modales .opciones button');
  ok('…y al aceptar el cronómetro pasa a la O.T.', await esperarHasta(p, `(document.querySelector('.fase.activa') || { dataset: {} }).dataset.fase === 'trabajo'`));
  await clic(p, '[data-accion=volver]');
  await esperarHasta(p, `location.hash === '#midia' && !!document.querySelector('.seccion-comodin')`);
  await clic(p, '.comodin-tarjeta [data-accion=empezar-comodin]');
  await conModal(p, '.opciones button');
  await clicTexto(p, '#modales .opciones button', '/^Otros$/');
  ok('"Otros" pide una nota antes de empezar', await esperarHasta(p, `!!document.querySelector('#modales [data-ref=nota]') && document.querySelector('#modales [data-ref=titulo]').textContent === 'Otros'`));
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…sin nota no deja seguir', await esperarHasta(p, `/Escribe la nota/.test((document.querySelector('#modales [data-ref=avisos]') || {}).textContent || '')`));
  await evaluar(p, `document.querySelector('#modales [data-ref=nota]').value = 'Recoger la furgoneta de la ITV'`);
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…con nota, y con el cronómetro en una O.T., pregunta si se para la O.T.', await esperarHasta(p, `/Tienes el cronómetro en marcha en la O\\.T\\. ${torreta.numero}.*¿Lo paras y empiezas con "Otros"\\?/.test((document.querySelector('#modales .modal-fondo:not(.cerrando) [data-ref=titulo]') || {}).textContent || '')`), await texto(p, '#modales [data-ref=titulo]'));
  await clic(p, '#modales .modal-fondo:not(.cerrando) .opciones button');
  ok('…al aceptar, el aviso de arriba pasa a "Sin O.T. · Otros"', await esperarHasta(p, `/Sin O\\.T\\..*Otros/.test((document.querySelector('.crono-banner .cb-texto') || {}).textContent || '')`), await texto(p, '.crono-banner'));
  await dormir(1100);
  await clic(p, '.crono-banner [data-accion=parar-comodin]');
  ok('Parar desde el aviso: desaparece y la tarjeta vuelve al botón de imputar', await esperarHasta(p, `document.querySelector('[data-ref=crono-banner]').classList.contains('oculto') && !document.querySelector('.comodin-tarjeta.con-crono')`) && /Imputar horas sin O\.T\./.test(await texto(p, '.comodin-tarjeta [data-accion=empezar-comodin]')));

  // --- Mis horas en el móvil: el día, sus fichajes y pedir correcciones -------------------------------------------------------
  await clic(p, `.aviso-jornada .dia-bajo[data-dia="${D2}"]`);
  ok('pulsar un día del aviso lleva a "Mis horas" con ese día abierto', await esperarHasta(p, `location.hash === '#horas' && !!document.querySelector('.dia[data-dia="${D2}"]')`) && await diaCargado(p, D2) && (await texto(p, '.horas-barra h2')) === 'Mis horas' && (await texto(p, '#nav button.activo')) === 'Mis horas');
  let d2 = await dia(p, D2);
  ok('…el día enseña 4 h, "Faltan 4 h" y su fichaje de trabajo, marcado como corregido, con Corregir y Quitar', d2 && /e-bajo/.test(d2.clase) && d2.total === '4 h' && d2.chips.some((c) => /Faltan 4 h/.test(c)) && d2.tramos.length === 1 && d2.tramos[0].hora === '08:00–12:00' && /Trabajo · O\.T\. /.test(d2.tramos[0].que)
    && d2.tramos[0].marcas.includes('Corregido') && d2.tramos[0].botones.join() === 'Corregir,Quitar' && /Añadir tiempo que falta/.test(d2.anadir), JSON.stringify(d2));
  if (!MESES_ATRAS) {
    const pills = await evaluar(p, `[...document.querySelectorAll('.horas-resumen .pill')].map(x => x.textContent)`);
    ok('resumen del mes: fichado, las tres fases, sin O.T. y los días por debajo', pills.length === 6 && /Fichado en el mes/.test(pills[0]) && /Sin O\.T\./.test(pills[4]) && /Días por debajo de 8 h/.test(pills[5]) && /faltan/.test(pills[5]), JSON.stringify(pills));
    ok('…y el día sin fichar aparece en la lista como "Sin fichar"', ((await dia(p, D1)) || { chips: [] }).chips.some((c) => /Sin fichar/.test(c)));
  }
  ok('móvil: "Mis horas" sin desplazamiento horizontal', await sinDesborde(p), `ancho=${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '04-mis-horas-dia');

  await clic(p, `.dia[data-dia="${D2}"] [data-accion=anadir]`);
  ok('Añadir tiempo: el diálogo ofrece sus O.T. del día y el comodín, y avisa de que lo aprueba la oficina', await conModal(p, '[data-ref=form]') && (await texto(p, '#modales [data-ref=titulo]')) === 'Pedir que se añada tiempo'
    && (await evaluar(p, `(() => { const o = [...document.querySelector('#modales [name=destino]').options].map(x => x.value); return o.includes('ot:${torreta.id}') && o.includes('comodin') && !o.includes('numero'); })()`))
    && /La oficina tiene que aprobarla/.test(await texto(p, '#modales [data-ref=resumen]')) && (await texto(p, '#modales [data-ref=guardar]')) === 'Enviar a la oficina');
  await rellenar(p, { destino: `ot:${torreta.id}`, tipo: 'trabajo', inicio: '11:00', fin: '12:30', motivo: 'Me faltó fichar' });
  ok('…si se solapa con otro fichaje, el diálogo lo dice y no se cierra', await esperarHasta(p, `/Se solapa con otro fichaje: 08:00–12:00/.test((document.querySelector('#modales [data-ref=avisos]') || {}).textContent || '')`), await texto(p, '#modales [data-ref=avisos]'));
  await rellenar(p, { destino: 'comodin' }, false);
  ok('…al elegir el comodín, el desplegable pasa a "Concepto" con los conceptos', (await texto(p, '#modales [data-ref=et-tipo]')) === 'Concepto' && (await evaluar(p, `[...document.querySelector('#modales [name=tipo]').options].map(x => x.value).join()`)) === 'taller,formacion,sin_tarea,otros,vacaciones,baja,festivo');
  await captura(p, '05-pedir-correccion');
  await rellenar(p, { tipo: 'formacion', inicio: '13:00', fin: '17:00', motivo: 'Curso de carretillero, sin tablet' });
  ok('…enviada: aviso de que la oficina tiene que aprobarla', await toastCon(p, '/Corrección enviada/') && await sinModal(p));
  ok('…aparece en "Correcciones del mes" como pendiente, con Retirar, y el día la marca', await esperarHasta(p, `document.querySelectorAll('.horas-incidencias .incidencia.e-pendiente').length === 1`) && await diaCargado(p, D2)
    && (await incidencias(p, '.horas-incidencias')).some((i) => /Añadir/.test(i.cab) && /comodín \(Formación\).*13:00–17:00/.test(i.cambio) && i.estado === 'Pendiente' && i.botones.join() === 'retirar')
    && ((await dia(p, D2)).chips.some((c) => /1 pendiente/.test(c))), JSON.stringify(await incidencias(p, '.horas-incidencias')));
  await clic(p, `.dia[data-dia="${D2}"] .tramos-dia [data-accion=corregir]`);
  ok('Corregir: el diálogo viene con el tipo y las horas del fichaje', await conModal(p, '[data-ref=form]') && (await evaluar(p, `(() => { const f = document.querySelector('#modales [data-ref=form]'); return f.elements.tipo.value + '|' + f.elements.inicio.value + '|' + f.elements.fin.value + '|' + document.querySelector('#modales [data-ref=bloque-destino]').classList.contains('oculto'); })()`)) === 'trabajo|08:00|12:00|true');
  await rellenar(p, { inicio: '08:30', motivo: 'Empecé más tarde' });
  await toastCon(p, '/Corrección enviada/');
  ok('…enviada: el fichaje queda marcado "Corrección pedida" y ya no se puede tocar', await esperarHasta(p, `document.querySelectorAll('.horas-incidencias .incidencia.e-pendiente').length === 2`) && await diaCargado(p, D2) && await esperarHasta(p, `[...document.querySelectorAll('.dia[data-dia="${D2}"] .tr-marcas .dato-chip')].some(c => /Corrección pedida/.test(c.textContent))`)
    && (await dia(p, D2)).tramos[0].botones.length === 0, JSON.stringify(await dia(p, D2)));
  await captura(p, '06-mis-horas-pendientes');
  const mod = (await incidencias(p, '.horas-incidencias')).find((i) => /Corregir/.test(i.cab));
  await clic(p, `.horas-incidencias .incidencia[data-id="${mod.id}"] [data-accion=retirar]`);
  ok('Retirar: la corrección pasa a "Retirada" y el fichaje vuelve a tener sus botones', await toastCon(p, '/Corrección retirada/') && await esperarHasta(p, `document.querySelectorAll('.horas-incidencias .incidencia.e-pendiente').length === 1 && !!document.querySelector('.horas-incidencias .incidencia.e-anulada')`)
    && await diaCargado(p, D2) && await esperarHasta(p, `document.querySelectorAll('.dia[data-dia="${D2}"] .tr-botones button').length === 2`));
  await evaluar(p, `location.hash = 'horas/${mikel.id}'`);
  await dormir(400);
  ok('el técnico no entra en las horas de otro por la dirección: se queda en las suyas', (await evaluar(p, 'location.hash')) === '#horas' && (await texto(p, '.horas-barra h2')) === 'Mis horas');
  await evaluar(p, `location.hash = 'fichajes'`);
  await dormir(400);
  ok('…ni en "Fichajes": vuelve a Mi día', await esperarHasta(p, `!!document.querySelector('.midia')`) && !(await evaluar(p, `!!document.querySelector('.fich-tabla')`)));

  // --- Oficina (escritorio): Fichajes ------------------------------------------------------------------------------------
  await tamano(p, 1366, 900, false);
  await entrar(p, 'responsable1', 'prueba123');
  ok('responsable: el menú tiene "Fichajes" con el contador de pendientes (1) y no "Mis horas"', await esperarHasta(p, `(document.querySelector('#nav button[data-vista=fichajes] .nav-contador') || {}).textContent === '1'`) && !(await evaluar(p, `!!document.querySelector('#nav button[data-vista=horas]')`)));
  await clic(p, '#nav button[data-vista=fichajes]');
  await esperarHasta(p, `!!document.querySelector('tr[data-tecnico="${mikel.id}"]')`);
  for (let i = 0; i < MESES_ATRAS; i++) { await clic(p, '[data-ref=mes-nav] [data-accion=mes-ant]'); await dormir(500); }
  await esperarHasta(p, `!!document.querySelector('tr[data-tecnico="${mikel.id}"] td[data-dia="${D2}"]')`);
  const c2 = await celda(p, mikel.id, D2), c1 = await celda(p, mikel.id, D1);
  ok('Jornadas: la fila de Mikel marca el día de 4 h en ámbar, con la marca de corrección pendiente', c2 && /c-bajo/.test(c2.clase) && c2.texto === '4' && c2.marca, JSON.stringify(c2));
  if (c1) ok('…y el día sin fichar en rojo, con un 0', /c-sin_fichar/.test(c1.clase) && c1.texto === '0', JSON.stringify(c1));
  ok('…una fila por técnico (con el SAT señalado), las columnas de totales y el aviso de cuántos no llegan', (await evaluar(p, `document.querySelectorAll('.fich-tabla tbody tr[data-tecnico]').length`)) >= 3 && /SAT externo/.test(await texto(p, '.fich-tabla tbody')) && /Falta/.test(await texto(p, '.fich-tabla thead'))
    && /1 técnico con días por debajo de 8 h/.test(await texto(p, '.barra-vista .contador')), await texto(p, '.barra-vista .contador'));
  ok('…la tabla cabe en la pantalla o se desplaza dentro de su caja, no la página', await sinDesborde(p), `ancho=${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '07-fichajes-jornadas');

  await clic(p, '[data-pestana=incidencias]');
  await esperarHasta(p, `document.querySelectorAll('[data-ref=panel-incidencias] .incidencia').length === 1`);
  let incs = await incidencias(p, '[data-ref=panel-incidencias]');
  ok('Incidencias: la pendiente de Mikel con Aprobar y Rechazar', incs.length === 1 && /Mikel/.test(incs[0].cab) && /Añadir/.test(incs[0].cab) && incs[0].botones.join() === 'aprobar,rechazar' && (await texto(p, '[data-ref=n-pend]')) === '1', JSON.stringify(incs));
  await captura(p, '08-fichajes-incidencias');
  await clic(p, '[data-ref=panel-incidencias] [data-accion=aprobar]');
  ok('Aprobar: se aplica, la lista queda vacía y el contador desaparece', await toastCon(p, '/Corrección aprobada y aplicada/') && await esperarHasta(p, `/No hay incidencias pendientes/.test(document.querySelector('[data-ref=lista]').textContent) && !document.querySelector('#nav .nav-contador')`));
  await clic(p, '[data-pestana=jornadas]');
  ok('…y en Jornadas el día de Mikel pasa a verde con 8 h', await esperarHasta(p, `(() => { const td = document.querySelector('tr[data-tecnico="${mikel.id}"] td[data-dia="${D2}"]'); return !!td && td.classList.contains('c-ok') && td.textContent === '8'; })()`), JSON.stringify(await celda(p, mikel.id, D2)));

  // Horas de un técnico (desde una celda) y corrección directa.
  const diaLibre = c1 ? D1 : D2;
  await clic(p, `tr[data-tecnico="${mikel.id}"] td[data-dia="${diaLibre}"]`);
  ok('pulsar una celda abre las horas de ese técnico con el día desplegado y el botón de volver', await esperarHasta(p, `location.hash === '#horas/${mikel.id}'`) && await diaCargado(p, diaLibre) && /^Horas de Mikel/.test(await texto(p, '.horas-barra h2')) && !(await evaluar(p, `document.querySelector('.horas-barra [data-accion=volver]').classList.contains('oculto')`)) && (await texto(p, '#nav button.activo')).startsWith('Fichajes'));
  const antes = await dia(p, diaLibre);
  await clic(p, `.dia[data-dia="${diaLibre}"] [data-accion=anadir]`);
  ok('Añadir un fichaje (oficina): se aplica en el momento y admite otra O.T. por número', await conModal(p, '[data-ref=form]') && (await texto(p, '#modales [data-ref=titulo]')) === 'Añadir un fichaje' && /Se aplica en el momento/.test(await texto(p, '#modales [data-ref=resumen]'))
    && (await evaluar(p, `[...document.querySelector('#modales [name=destino]').options].some(x => x.value === 'numero')`)) && (await texto(p, '#modales [data-ref=guardar]')) === 'Guardar');
  await rellenar(p, { destino: 'comodin', tipo: 'vacaciones' }, false);
  ok('…al elegir una ausencia (Vacaciones) propone la jornada entera, de 08:00 a 16:00', (await evaluar(p, `(() => { const f = document.querySelector('#modales [data-ref=form]'); return f.elements.inicio.value + '-' + f.elements.fin.value; })()`)) === '08:00-16:00');
  await rellenar(p, { destino: 'numero' }, false);
  ok('…al elegir "Otra O.T." aparece la casilla del número', !(await evaluar(p, `document.querySelector('#modales [name=ot_numero]').classList.contains('oculto')`)));
  await rellenar(p, { destino: 'numero', ot_numero: torreta.numero, tipo: 'desplazamiento', inicio: '06:30', fin: '07:00', motivo: 'Desplazamiento sin fichar' });
  ok('…guardado: aviso "Fichaje corregido" y el tramo aparece en el día, marcado como corregido', await toastCon(p, '/Fichaje corregido/') && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.dia[data-dia="${diaLibre}"] .tr-hora')].some(h => h.textContent === '06:30–07:00')`)
    && (await dia(p, diaLibre)).tramos.find((t) => t.hora === '06:30–07:00').marcas.includes('Corregido'), JSON.stringify(await dia(p, diaLibre)));
  await captura(p, '09-horas-de-un-tecnico');
  await evaluar(p, `[...document.querySelectorAll('.dia[data-dia="${diaLibre}"] .tramos-dia li')].find(li => li.querySelector('.tr-hora').textContent === '06:30–07:00').querySelector('[data-accion=quitar]').click()`);
  ok('Quitar (oficina): solo pide el motivo', await conModal(p, '[data-ref=form]') && (await evaluar(p, `document.querySelector('#modales [data-ref=bloque-horas]').classList.contains('oculto') && document.querySelector('#modales [data-ref=bloque-tipo]').classList.contains('oculto')`)) && (await texto(p, '#modales [data-ref=guardar]')) === 'Quitar el fichaje');
  await rellenar(p, { motivo: 'Duplicado' });
  ok('…y el día vuelve a como estaba', await toastCon(p, '/Fichaje corregido/') && await esperarHasta(p, `![...document.querySelectorAll('.dia[data-dia="${diaLibre}"] .tr-hora')].some(h => h.textContent === '06:30–07:00')`) && await diaCargado(p, diaLibre) && (await dia(p, diaLibre)).total === antes.total, JSON.stringify(await dia(p, diaLibre)));
  await clic(p, '.horas-barra [data-accion=volver]');
  ok('"‹ Fichajes" vuelve a la vista de la oficina', await esperarHasta(p, `location.hash === '#fichajes' && !!document.querySelector('.fich-tabla tbody tr[data-tecnico]')`));

  // Rechazar: el técnico pide otra corrección (por la API) y el responsable la rechaza con respuesta.
  const tramoOT = (await pedir(`/api/jornadas/dia?dia=${D2}&tecnico_id=${mikel.id}`, { cookie: A })).j.tramos.find((t) => t.ot_id === torreta.id);
  x = await pedir('/api/incidencias', { cookie: M, metodo: 'POST', body: { accion: 'modificar', tramo_id: tramoOT.id, fin: '12:45', motivo: 'Salí más tarde' } });
  await clic(p, '[data-pestana=incidencias]');
  await evaluar(p, `(() => { const s = document.querySelector('[data-ref=filtros] [name=estado]'); s.value = 'pendiente'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  ok('nueva petición de Mikel: aparece en Incidencias y vuelve el contador', x.s === 201 && await esperarHasta(p, `document.querySelectorAll('[data-ref=panel-incidencias] .incidencia.e-pendiente').length === 1 && (document.querySelector('#nav .nav-contador') || {}).textContent === '1'`));
  await clic(p, '[data-ref=panel-incidencias] [data-accion=rechazar]');
  ok('Rechazar pide el porqué', await esperarHasta(p, `!!document.querySelector('#modales [data-ref=nota]') && /Rechazar la corrección/.test(document.querySelector('#modales [data-ref=titulo]').textContent)`));
  await evaluar(p, `document.querySelector('#modales [data-ref=nota]').value = 'El parte del cliente dice 12:00'`);
  await clic(p, '#modales [data-ref=confirmar]');
  ok('…y la deja rechazada: la lista de pendientes queda vacía', await toastCon(p, '/Corrección rechazada/') && await esperarHasta(p, `/No hay incidencias pendientes/.test(document.querySelector('[data-ref=lista]').textContent)`));
  await evaluar(p, `(() => { const s = document.querySelector('[data-ref=filtros] [name=estado]'); s.value = 'resueltas'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await esperarHasta(p, `document.querySelectorAll('[data-ref=panel-incidencias] .incidencia').length >= 5`);
  incs = await incidencias(p, '[data-ref=panel-incidencias]');
  ok('"Resueltas" enseña las aprobadas, la rechazada (con su respuesta) y la retirada, sin botones', ['Aprobada', 'Rechazada', 'Retirada'].every((e) => incs.some((i) => i.estado === e)) && incs.every((i) => i.botones.length === 0) && /El parte del cliente dice 12:00/.test(await texto(p, '[data-ref=panel-incidencias] .incidencia.e-rechazada')), JSON.stringify(incs.map((i) => i.estado)));
  await captura(p, '10-incidencias-resueltas');

  // --- Gerencia: solo mira -----------------------------------------------------------------------------------------------------
  x = await pedir('/api/incidencias', { cookie: M, metodo: 'POST', body: { accion: 'modificar', tramo_id: tramoOT.id, fin: '12:15', motivo: 'Otra petición' } });
  await entrar(p, 'gerencia1', 'prueba123');
  await evaluar(p, `location.hash = 'fichajes'`);
  await esperarHasta(p, `!!document.querySelector('tr[data-tecnico="${mikel.id}"]')`);
  await clic(p, '[data-pestana=incidencias]');
  await esperarHasta(p, `document.querySelectorAll('[data-ref=panel-incidencias] .incidencia').length === 1`);
  ok('gerencia: ve Fichajes y la incidencia pendiente, sin botones para resolverla', x.s === 201 && (await incidencias(p, '[data-ref=panel-incidencias]'))[0].botones.length === 0);
  await evaluar(p, `S.horas.abrir = '${D2}'; location.hash = 'horas/${mikel.id}'`);
  ok('…y las horas de un técnico, sin Corregir, Quitar ni Añadir', await diaCargado(p, D2) && (await dia(p, D2)).tramos.length === 2 && (await dia(p, D2)).tramos.every((t) => t.botones.length === 0) && (await dia(p, D2)).anadir === '', JSON.stringify(await dia(p, D2)));

  // --- Tablet: Mis horas del técnico ------------------------------------------------------------------------------------------
  await tamano(p, 820, 1180);
  await entrar(p, 'tecnico1', 'prueba123');
  await esperarHasta(p, `!!document.querySelector('.seccion-comodin')`);
  ok('técnico: en Mi día ya solo queda un día por debajo y le avisa de la corrección pendiente', (await evaluar(p, `document.querySelectorAll('.aviso-jornada .dia-bajo').length`)) === 1 && /Tienes una corrección pendiente/.test(await texto(p, '.aviso-jornada .pendientes')), await texto(p, '.aviso-jornada'));
  await clic(p, '#nav button[data-vista=horas]');
  await esperarHasta(p, `!!document.querySelector('.horas-dias .dia')`);
  for (let i = 0; i < MESES_ATRAS; i++) { await clic(p, '.horas-barra [data-accion=mes-ant]'); await dormir(500); }
  await esperarHasta(p, `!!document.querySelector('.dia[data-dia="${D2}"]')`);
  d2 = await dia(p, D2);
  ok('Mis horas (tablet): el día corregido llega a 8 h, en verde y sin "Faltan"', d2 && /e-ok/.test(d2.clase) && d2.total === '8 h' && !d2.chips.some((c) => /Faltan/.test(c)), JSON.stringify(d2));
  ok('…las correcciones del mes enseñan la rechazada con la respuesta de la oficina', /El parte del cliente dice 12:00/.test(await texto(p, '.horas-incidencias')) && await sinDesborde(p));
  await captura(p, '11-mis-horas-tablet');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  if (consola.length) res.push('FALLO consola con errores');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
