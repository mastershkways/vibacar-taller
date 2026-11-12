// Prueba del Tablero v2 (F4-04) en Brave headless vía CDP: cinco verticales sin cerradas, etiquetas y urgentes en las tarjetas,
// filtros, "tu vertical" por rol, modal de dos preguntas desde el detalle, y el técnico (Mi día → ficha → Pausar con el mismo modal).
// Servidor en 5055 con la BD del seed (ciclo tablero2, después de cliente-prueba-tablero2.js).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-tablero2');
fs.mkdirSync(CAPTURAS, { recursive: true });
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);
const consola = [];
const red = [];
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  return { enviar, esperarEvento, cerrar: () => ws.close() };
}
const evaluar = async (p, expr) => {
  const r = await p.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}\n${expr.slice(0, 200)}`);
  return r.result.value;
};
const esperarHasta = async (p, expr, timeout = 8000) => { const fin = Date.now() + timeout; while (Date.now() < fin) { if (await evaluar(p, expr)) return true; await dormir(200); } return false; };
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
const escape = async (p) => { await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2500);
const columnas = (p) => evaluar(p, `[...document.querySelectorAll('.columna')].map(c => ({ fase: c.dataset.fase, titulo: c.querySelector('.titulo-col').textContent.trim(), n: c.querySelector('[data-ref=n]').textContent, mia: c.classList.contains('mia'), oculta: c.classList.contains('oculto'), tarjetas: [...c.querySelectorAll('.tarjeta')].map(t => ({ texto: t.textContent, urgente: t.classList.contains('urgente'), etiqueta: t.querySelector('.chip-etiqueta')?.textContent || null })) }))`);
const setSelect = (p, selector, valor) => evaluar(p, `(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(valor)}; s.dispatchEvent(new Event('input', { bubbles: true })); return s.value; })()`);

(async () => {
  const p = await abrirPestana();

  // --- Administrativo: Tablero v2 ------------------------------------------------------------------------------
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await esperarHasta(p, `document.querySelectorAll('.tarjeta').length >= 18`);
  let cols = await columnas(p);
  ok('Tablero: 5 verticales en orden y sin "Cerrada"', cols.map((c) => c.fase).join(',') === 'pendiente_planificar,planificada,en_curso,pausada,finalizada', cols.map((c) => c.titulo).join(' | '));
  ok('Tablero: 18 tarjetas; las urgentes (clase .urgente) arriba de su vertical', cols.reduce((n, c) => n + c.tarjetas.length, 0) === 18 && cols.every((c) => c.tarjetas.every((t, i) => i === 0 || !t.urgente || c.tarjetas[i - 1].urgente)));
  const etiquetas = cols.flatMap((c) => c.tarjetas.map((t) => t.etiqueta)).filter(Boolean);
  ok('Tablero: 6 tarjetas con chip de etiqueta (repuesto, presupuesto, nº de pedido, SAT externo, Vº B factura)', etiquetas.length === 6 && etiquetas.includes('Pendiente de repuesto') && etiquetas.includes('SAT externo') && etiquetas.includes('Vº B factura'), etiquetas.join(' | '));
  ok('Tablero: administrativo tiene "tu vertical" en Pausada y Finalizada', cols.filter((c) => c.mia).map((c) => c.fase).join(',') === 'pausada,finalizada');
  ok('Tablero: contador "18 O.T. abiertas" y sin texto de cerradas', /^18 O\.T\. abiertas · \d+ urgentes · /.test(await evaluar(p, `document.querySelector('[data-ref=contador]').textContent`)), await evaluar(p, `document.querySelector('[data-ref=contador]').textContent`));
  await captura(p, '01-admin-tablero');

  // Filtros: operario, etiqueta, texto, solo mi vertical, limpiar
  await esperarHasta(p, `document.querySelector('[data-ref=f-tecnico]').options.length >= 4`);
  const idMikel = await evaluar(p, `[...document.querySelector('[data-ref=f-tecnico]').options].find(o => /Mikel/.test(o.textContent)).value`);
  await setSelect(p, '[data-ref=f-tecnico]', idMikel);
  cols = await columnas(p);
  ok('filtro operario = Mikel: solo sus tarjetas y contadores "x/y"', cols.flatMap((c) => c.tarjetas).length >= 3 && cols.flatMap((c) => c.tarjetas).every((t) => /Mikel Etxeberria/.test(t.texto)) && cols.some((c) => /\//.test(c.n)), cols.map((c) => c.n).join(','));
  await setSelect(p, '[data-ref=f-tecnico]', '');
  await setSelect(p, '[data-ref=f-etiqueta]', 'repuesto');
  cols = await columnas(p);
  ok('filtro etiqueta = repuesto: 2 tarjetas, las dos en Pausada', cols.flatMap((c) => c.tarjetas).length === 2 && cols.find((c) => c.fase === 'pausada').tarjetas.length === 2);
  await setSelect(p, '[data-ref=f-etiqueta]', '');
  await evaluar(p, `(() => { const i = document.querySelector('[data-ref=filtros] [name=q]'); i.value = 'Ibaizabal'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await dormir(400);
  cols = await columnas(p);
  ok('filtro texto "Ibaizabal": solo sus O.T. (3)', cols.flatMap((c) => c.tarjetas).length === 3 && cols.flatMap((c) => c.tarjetas).every((t) => /Ibaizabal/.test(t.texto)), `${cols.flatMap((c) => c.tarjetas).length}`);
  await setSelect(p, '[data-ref=f-vertical]', 'mias');
  await dormir(300);
  cols = await columnas(p);
  ok('"Solo las mías": quedan visibles Pausada y Finalizada', cols.filter((c) => !c.oculta).map((c) => c.fase).join(',') === 'pausada,finalizada');
  await evaluar(p, `document.querySelector('[data-accion=limpiar-filtros]').click()`);
  await dormir(300);
  cols = await columnas(p);
  ok('Limpiar: vuelven las 18 tarjetas y las 5 verticales', cols.reduce((n, c) => n + c.tarjetas.length, 0) === 18 && cols.every((c) => !c.oculta));
  await captura(p, '02-admin-filtros');

  // Detalle → modal de dos preguntas → Pausada / repuesto
  const antesPausada = Number(cols.find((c) => c.fase === 'pausada').n);
  const antesPend = Number(cols.find((c) => c.fase === 'pendiente_planificar').n);
  const primera = await evaluar(p, `(() => { const t = document.querySelector('.columna[data-fase=pendiente_planificar] .tarjeta'); t.click(); return t.querySelector('.num').textContent.trim().split(' ')[0]; })()`);
  ok('detalle abierto desde la tarjeta', await esperarHasta(p, `!!document.querySelector('.modal [data-ref=transiciones] button')`));
  const botones = await evaluar(p, `[...document.querySelectorAll('.modal [data-ref=transiciones] button')].map(b => b.textContent)`);
  ok('detalle: 5 botones de destino (→ Planificada … → Cerrada) y fila "Planificación: Sin planificar" con el botón Planificar', botones.length === 5 && botones[0] === '→ Planificada' && botones[4] === '→ Cerrada' && /^Sin planificar/.test(await evaluar(p, `document.querySelector('.modal [data-ref=bloques]').textContent`)) && (await evaluar(p, `document.querySelector('.modal [data-ref=bloques] [data-accion=planificar]')?.textContent`)) === 'Planificar', botones.join(' | '));
  await evaluar(p, `[...document.querySelectorAll('.modal [data-ref=transiciones] button')].find(b => b.textContent === '→ Pausada').click()`);
  ok('modal de cambio de estado con las dos preguntas (motivo + nota)', await esperarHasta(p, `(() => { const m = [...document.querySelectorAll('#modales .modal')].at(-1); return !!m && /→ Pausada/.test(m.querySelector('h2').textContent) && m.querySelector('[data-ref=opcion]').required && m.querySelector('[data-ref=opcion]').options.length === 6 && !!m.querySelector('[data-ref=nota]'); })()`));
  await evaluar(p, `(() => { const m = [...document.querySelectorAll('#modales .modal')].at(-1); m.querySelector('[data-ref=confirmar]').click(); })()`);
  ok('sin motivo no deja confirmar (aviso "Elige el motivo")', await esperarHasta(p, `/Elige el motivo/.test([...document.querySelectorAll('#modales .modal')].at(-1).querySelector('[data-ref=avisos]').textContent)`, 2000));
  await evaluar(p, `(() => { const m = [...document.querySelectorAll('#modales .modal')].at(-1); m.querySelector('[data-ref=opcion]').value = 'repuesto'; m.querySelector('[data-ref=nota]').value = 'Falta la batería'; m.querySelector('[data-ref=confirmar]').click(); })()`);
  ok('confirmado: el detalle enseña el chip "Pendiente de repuesto" y el estado Pausada', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); return !!m && m.querySelector('[data-ref=estado]').textContent === 'Pausada' && m.querySelector('[data-ref=etiqueta]').textContent === 'Pendiente de repuesto' && !m.querySelector('[data-ref=etiqueta]').classList.contains('oculto'); })()`));
  ok('detalle: selector de etiqueta dentro de la vertical visible con el valor repuesto; historial con "[Pendiente de repuesto] · Falta la batería"', (await evaluar(p, `document.querySelector('.modal [data-ref=form-etiqueta] select').value`)) === 'repuesto' && /\[Pendiente de repuesto\] · Falta la batería/.test(await evaluar(p, `document.querySelector('.modal [data-ref=historial]').textContent`)));
  await captura(p, '03-admin-detalle-pausada');
  await escape(p);
  await sinModal(p);
  await esperarHasta(p, `document.querySelector('.columna[data-fase=pausada] [data-ref=n]').textContent === '${antesPausada + 1}'`);
  cols = await columnas(p);
  ok(`la tarjeta ${primera} pasa a Pausada en el Tablero (${antesPausada} → ${antesPausada + 1}) y Pendiente de planificar baja a ${antesPend - 1}`, cols.find((c) => c.fase === 'pausada').tarjetas.some((t) => t.texto.includes(primera)) && cols.find((c) => c.fase === 'pausada').n === String(antesPausada + 1) && cols.find((c) => c.fase === 'pendiente_planificar').n === String(antesPend - 1));

  // --- Recambista: su vertical es Pausada ------------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'recambista1', 'prueba123');
  ok('recambista: entra en el Tablero por defecto', await esperarHasta(p, `document.querySelector('#nav button.activo')?.textContent === 'Tablero' && document.querySelectorAll('.tarjeta').length >= 18`));
  cols = await columnas(p);
  const arrastrables = await evaluar(p, `[document.querySelectorAll('.tarjeta[draggable=true]').length, document.querySelectorAll('.tarjeta').length]`);
  ok('recambista: "tu vertical" solo en Pausada; todas las tarjetas arrastrables (puede cambiar estado)', cols.filter((c) => c.mia).map((c) => c.fase).join(',') === 'pausada' && arrastrables[0] === arrastrables[1] && arrastrables[1] > 0, `mias=${cols.filter((c) => c.mia).map((c) => c.fase).join(',')} arrastrables=${arrastrables.join('/')}`);
  await captura(p, '04-recambista-tablero');

  // --- Técnico: Mi día → ficha de trabajo (F4-05); Pausar abre el modal de dos preguntas en modo tablet ----------
  await salir(p);
  await entrar(p, 'tecnico1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('.tarea').length > 0`);
  await evaluar(p, `document.querySelector('.tarea [data-accion=principal]').click()`);   // su O.T. en curso: "Continuar" abre la ficha
  await esperarHasta(p, `document.body.classList.contains('modo-ficha') && !document.querySelector('.fase:disabled')`);
  const accionesT = await evaluar(p, `[...document.querySelectorAll('.ficha-botones [data-accion]')].map(b => b.dataset.accion).join(',')`);
  ok('técnico: la ficha de trabajo ofrece Parar por hoy / Pausar / Terminar (nunca cerrar)', accionesT === 'parar,pausar,terminar', accionesT);
  await evaluar(p, `document.querySelector('.ficha-botones [data-accion=pausar]').click()`);
  ok('técnico: modal de dos preguntas en modo tablet (botones grandes)', await esperarHasta(p, `!!document.querySelector('#modales .modal-fondo.tablet [data-ref=opcion]')`));
  await captura(p, '05-tecnico-modal');
  await escape(p);
  await sinModal(p);

  // --- Operativo: home Tablero, cabecera con el nombre nuevo --------------------------------------------------------
  await salir(p);
  await entrar(p, 'operativo1', 'prueba123');
  await evaluar(p, `location.hash = 'kanban'`); // su home es el Planificador (F4-02)
  await esperarHasta(p, `document.querySelectorAll('.columna').length === 5`);
  ok('operativo: Tablero, cabecera "Operativo administrativo", verticales Pendiente/Planificada/En curso/Pausada resaltadas', (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Tablero' && (await evaluar(p, `document.querySelector('#usuario-rol').textContent`)) === 'Operativo administrativo' && (await columnas(p)).filter((c) => c.mia).length === 4);
  await captura(p, '06-operativo-tablero');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length + (consola.length ? 1 : 0);
  if (consola.length) console.log('FALLO consola con errores');
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
