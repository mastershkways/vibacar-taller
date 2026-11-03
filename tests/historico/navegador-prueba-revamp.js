// Prueba visual del revamp UI (Fase 2) en Brave headless vía DevTools Protocol, sin dependencias.
// Servidor de prueba en 5055 con BD temporal (prueba-revamp.db). Capturas en ./capturas-revamp/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-revamp');
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
  let id = 0;
  const pendientes = new Map();
  const oyentes = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pendientes.has(m.id)) { const { r: rr, j } = pendientes.get(m.id); pendientes.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : rr(m.result); }
    else if (m.method) for (const o of oyentes) o(m.method, m.params);
  };
  const enviar = (method, params = {}) => new Promise((rr, j) => { const i = ++id; pendientes.set(i, { r: rr, j }); ws.send(JSON.stringify({ id: i, method, params })); });
  const esperarEvento = (metodo, filtro = () => true, timeout = 10000) => new Promise((rr, j) => {
    const t = setTimeout(() => j(new Error(`timeout esperando ${metodo}`)), timeout);
    const o = (m, p) => { if (m === metodo && filtro(p)) { clearTimeout(t); oyentes.splice(oyentes.indexOf(o), 1); rr(p); } };
    oyentes.push(o);
  });
  oyentes.push((m, p) => {
    if (m === 'Runtime.exceptionThrown') consola.push(`EXCEPCIÓN: ${p.exceptionDetails.text} ${p.exceptionDetails.exception?.description || ''}`);
    if (m === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) consola.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m === 'Network.responseReceived' && p.response.status >= 400) red.push(`${p.response.status} ${p.response.url.replace(BASE, '')}`);
  });
  await enviar('Page.enable'); await enviar('Runtime.enable'); await enviar('Network.enable');
  await enviar('Emulation.setFocusEmulationEnabled', { enabled: true }); // en headless la ventana no tiene el foco y :focus no se aplicaría
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  return { ws, enviar, esperarEvento, cerrar: () => ws.close() };
}
async function evaluar(p, expr) {
  const r = await p.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}\n${expr.slice(0, 200)}`);
  return r.result.value;
}
async function esperarHasta(p, expr, timeout = 8000) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) { if (await evaluar(p, expr)) return true; await dormir(150); }
  return false;
}
async function captura(p, nombre) {
  const r = await p.enviar('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(CAPTURAS, `${nombre}.png`), Buffer.from(r.data, 'base64'));
}
async function navegar(p, url) {
  const nav = p.esperarEvento('Page.loadEventFired');
  await p.enviar('Page.navigate', { url });
  await nav;
}
async function entrar(p, usuario, clave) {
  await navegar(p, `${BASE}/`);
  if ((await evaluar(p, 'location.pathname')) !== '/acceso') { await salir(p); await navegar(p, `${BASE}/`); } // sesión previa en el perfil
  const nav = p.esperarEvento('Page.loadEventFired');
  await evaluar(p, `(() => { document.getElementById('usuario').value = ${JSON.stringify(usuario)}; document.getElementById('clave').value = ${JSON.stringify(clave)}; document.getElementById('formulario').requestSubmit(); })()`);
  await nav;
  ok(`login ${usuario} → /`, (await evaluar(p, 'location.pathname')) === '/');
}
async function salir(p) {
  const nav = p.esperarEvento('Page.loadEventFired');
  await evaluar(p, `document.querySelector('header form').requestSubmit()`);
  await nav;
}
async function tamano(p, width, height, mobile) {
  await p.enviar('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  await dormir(400);
}
const sinScrollH = (p, w) => evaluar(p, `document.documentElement.scrollWidth <= ${w}`);
const estilo = (sel, prop) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).getPropertyValue(${JSON.stringify(prop)})`;

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // ---- Acceso
  await navegar(p, `${BASE}/acceso`);
  ok('acceso: fondo gris claro #f8f9fa', (await evaluar(p, estilo('body', 'background-color'))) === 'rgb(248, 249, 250)');
  await captura(p, '01-acceso');

  // ---- Admontaller: Kanban
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  ok('css cargado: body #f8f9fa', await esperarHasta(p, `${estilo('body', 'background-color')} === 'rgb(248, 249, 250)'`));
  ok('kanban: 9 columnas y 4 tarjetas', await esperarHasta(p, `document.querySelectorAll('.columna').length === 9 && document.querySelectorAll('.tarjeta').length === 4`), `tarjetas ${await evaluar(p, `document.querySelectorAll('.tarjeta').length`)}`);
  ok('vista: animación de entrada aplicada', await evaluar(p, `document.getElementById('app').classList.contains('entra') && ${estilo('#app', 'animation-name')} === 'subir'`));
  ok('tarjeta: radio, sombra y transición', await evaluar(p, `(() => { const s = getComputedStyle(document.querySelector('.tarjeta')); return s.borderRadius === '10px' && s.boxShadow !== 'none' && s.transitionDuration === '0.2s'; })()`));
  ok('botón primario naranja con transición .2s', await evaluar(p, `(() => { const s = getComputedStyle(document.querySelector('.btn-primario')); return s.backgroundColor === 'rgb(255, 78, 0)' && s.transitionDuration === '0.2s'; })()`));
  ok('nav activo: pestaña naranja', await evaluar(p, `${estilo('#nav button.activo', 'color')} === 'rgb(217, 66, 0)'`));
  ok('desktop: sin scroll horizontal', await sinScrollH(p, 1400));
  await captura(p, '02-kanban-admin');

  // Drag: clase agarrada en dragstart, luego arrastrando; columnas destino marcadas
  await evaluar(p, `(() => {
    const t = [...document.querySelectorAll('.tarjeta')].find(x => x.draggable);
    const dt = new DataTransfer();
    t.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    window.__agarrada = t.classList.contains('agarrada') && getComputedStyle(t).transform !== 'none';
    window.__okCols = document.querySelectorAll('.columna.destino-ok').length;
    window.__t = t;
  })()`);
  await dormir(50);
  ok('drag: tarjeta agarrada escalada en dragstart', await evaluar(p, 'window.__agarrada === true'));
  ok('drag: tras un tick, hueco atenuado (.arrastrando) y columnas destino marcadas', await evaluar(p, `window.__t.classList.contains('arrastrando') && !window.__t.classList.contains('agarrada') && window.__okCols > 0`), `destino-ok: ${await evaluar(p, 'window.__okCols')}`);
  ok('drag: columna destino con pulso', await evaluar(p, `${estilo('.columna.destino-ok .cuerpo', 'animation-name')} === 'pulso'`));
  await captura(p, '03-kanban-drag');
  await evaluar(p, `window.__t.dispatchEvent(new DragEvent('dragend', { bubbles: true }))`);
  ok('drag: dragend limpia clases', await evaluar(p, `!window.__t.classList.contains('arrastrando') && !document.querySelector('.columna.destino-ok')`));

  // ---- Detalle: fade-in del modal, cierre animado
  await evaluar(p, `document.querySelector('.tarjeta').click()`);
  ok('detalle: modal abierto con animación de entrada', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="historial"] li') && ${estilo('.modal-fondo', 'animation-name')} === 'fondo-entra' && ${estilo('.modal', 'animation-name')} === 'modal-entra'`));
  ok('detalle: modal con radio 16 y backdrop blur', await evaluar(p, `(() => { const m = getComputedStyle(document.querySelector('.modal')); const f = getComputedStyle(document.querySelector('.modal-fondo')); return m.borderRadius === '16px' && /blur/.test(f.backdropFilter || f.webkitBackdropFilter || ''); })()`));
  await evaluar(p, `document.querySelector('.modal textarea[name=sintoma]').focus()`);
  await dormir(350); // la transición del borde dura .2s
  ok('detalle: inputs con borde naranja en focus', await evaluar(p, `(() => { const t = document.querySelector('.modal textarea[name=sintoma]'); return document.activeElement === t && getComputedStyle(t).borderColor === 'rgb(255, 78, 0)'; })()`), await evaluar(p, `document.hasFocus() + ' ' + getComputedStyle(document.querySelector('.modal textarea[name=sintoma]')).borderColor`));
  await captura(p, '04-detalle');

  // 409 → aviso de conflicto con animación; toast de éxito con entrada/salida
  const otId = await evaluar(p, `document.querySelector('.modal-fondo').dataset.otId`);
  const version = await evaluar(p, `fetch('/api/ot/${otId}').then(r => r.json()).then(o => o.version)`);
  await evaluar(p, `fetch('/api/ot/${otId}', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: ${version}, sintoma: 'Cambiado por otro ' + Date.now() }) }).then(r => r.status)`);
  await evaluar(p, `(() => { const f = document.querySelector('.modal [data-ref="form-datos"]'); f.elements.notas_internas.value = 'Mi cambio revamp'; f.requestSubmit(); })()`);
  ok('409: aviso de conflicto animado (aparecer)', await esperarHasta(p, `!!document.querySelector('.modal .aviso-conflicto') && ${estilo('.modal .aviso-conflicto', 'animation-name')} === 'aparecer'`));
  await captura(p, '05-detalle-409');
  await evaluar(p, `document.querySelector('.modal .aviso-conflicto button').click()`);
  ok('409: recargar quita el aviso', await esperarHasta(p, `!document.querySelector('.modal .aviso-conflicto') && /Cambiado por otro/.test(document.querySelector('.modal textarea[name=sintoma]').value)`));
  await evaluar(p, `(() => { const f = document.querySelector('.modal [data-ref="form-datos"]'); f.elements.notas_internas.value = 'Mi cambio revamp'; f.requestSubmit(); })()`);
  ok('toast ok: entra con animación toast-entra', await esperarHasta(p, `!!document.querySelector('.toast-ok') && ${estilo('.toast-ok', 'animation-name')} === 'toast-entra'`));
  await captura(p, '06-toast');
  await evaluar(p, `document.querySelector('.toast-ok').click()`);
  ok('toast ok: al tocarlo sale con toast-sale y desaparece', (await evaluar(p, `document.querySelector('.toast-ok')?.classList.contains('saliendo') && ${estilo('.toast-ok', 'animation-name')} === 'toast-sale'`)) && await esperarHasta(p, `!document.querySelector('.toast-ok')`, 2000));

  // Cierre con Escape: clase cerrando → animación → nodo eliminado
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  ok('Escape: modal con .cerrando y animación de salida', await evaluar(p, `document.querySelector('.modal-fondo')?.classList.contains('cerrando') && ${estilo('.modal', 'animation-name')} === 'modal-sale'`));
  ok('Escape: el modal desaparece al terminar', await esperarHasta(p, `!document.querySelector('.modal')`, 2000));

  // ---- Nueva O.T.: modal estrecho, utilidades .separado en lugar de estilos inline
  await evaluar(p, `document.querySelector('[data-accion="nueva"]').click()`);
  ok('nueva: modal abierto sin estilos inline', await esperarHasta(p, `!!document.querySelector('.modal.estrecho') && !document.querySelector('.modal [style]')`));
  ok('nueva: botón Crear cliente separado 8px', await evaluar(p, `${estilo('.modal .inline.separado', 'margin-top')} === '10px' && ${estilo('.modal select.separado', 'margin-top')} === '8px'`));
  await captura(p, '07-nueva-ot');
  await evaluar(p, `document.querySelector('.modal [data-accion="cerrar"]').click()`);
  ok('nueva: botón × cierra con animación', await esperarHasta(p, `!document.querySelector('.modal')`, 2000));

  // ---- Listado
  await evaluar(p, `location.hash = 'listado'`);
  ok('listado: filas y cabecera sticky', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length >= 4 && ${estilo('.tabla th', 'position')} === 'sticky'`));
  ok('listado: tabla en tarjeta con radio y sombra', await evaluar(p, `(() => { const s = getComputedStyle(document.querySelector('.tabla-envoltorio')); return s.borderRadius === '12px' && s.boxShadow !== 'none'; })()`));
  await captura(p, '08-listado');
  await tamano(p, 820, 1100, true);
  ok('tablet 820: listado sin scroll horizontal de página', await sinScrollH(p, 820));
  await captura(p, '09-listado-tablet');
  await tamano(p, 1400, 900, false);

  // ---- Técnico (tablet): Mis O.T.
  await salir(p);
  await entrar(p, 'tec1', 'tecnico123');
  ok('técnico: Mis O.T. con tarjetas grandes', await esperarHasta(p, `document.querySelector('#nav button.activo')?.textContent === 'Mis O.T.' && document.querySelectorAll('.tarjeta-grande').length >= 1`));
  await tamano(p, 1024, 768, true);
  const medidas = await evaluar(p, `(() => {
    const t = document.querySelector('.tarjeta-grande');
    const botones = [...t.querySelectorAll('.btn')].map(b => b.getBoundingClientRect().height);
    const s = getComputedStyle(t);
    return { fuente: parseFloat(s.fontSize), minBoton: Math.min(...botones), gap: parseFloat(getComputedStyle(t.querySelector('.botones')).gap), padding: parseFloat(s.paddingTop), actualizar: document.querySelector('.misot-barra .btn').getBoundingClientRect().height };
  })()`);
  ok('tablet 1024: fuente ≥ 18px en tarjeta grande', medidas.fuente >= 18, `${medidas.fuente}px`);
  ok('tablet 1024: todos los botones ≥ 48px (mín. real)', medidas.minBoton >= 48, `${medidas.minBoton}px`);
  ok('tablet 1024: botón Actualizar ≥ 48px', medidas.actualizar >= 48, `${medidas.actualizar}px`);
  ok('tablet 1024: gap ≥ 14 y padding ≥ 18', medidas.gap >= 14 && medidas.padding >= 18, `gap ${medidas.gap}, padding ${medidas.padding}`);
  ok('tablet 1024: sin scroll horizontal', await sinScrollH(p, 1024));
  await captura(p, '10-misot-tablet');
  // Parte con textarea de dictado
  await evaluar(p, `document.querySelector('.tarjeta-grande [data-destino]').click()`);
  ok('parte: textarea dictado ≥ 220px y 19px', await esperarHasta(p, `(() => { const t = document.querySelector('.modal textarea.dictado'); return t && t.getBoundingClientRect().height >= 220 && getComputedStyle(t).fontSize === '19px'; })()`));
  await captura(p, '11-parte-tablet');
  await evaluar(p, `document.querySelector('.modal [data-accion="cerrar"]').click()`);
  await esperarHasta(p, `!document.querySelector('.modal')`, 2000);
  // Móvil
  await tamano(p, 420, 860, true);
  ok('móvil 420: sin scroll horizontal', await sinScrollH(p, 420), `scrollWidth ${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  ok('móvil 420: botones ≥ 48px', await evaluar(p, `[...document.querySelectorAll('.tarjeta-grande .btn')].every(b => b.getBoundingClientRect().height >= 48)`));
  await captura(p, '12-misot-movil');
  await evaluar(p, `document.querySelector('.tarjeta-grande [data-accion="detalle"]').click()`);
  ok('móvil: modal a pantalla completa', await esperarHasta(p, `!!document.querySelector('.modal') && ${estilo('.modal', 'border-radius')} === '0px'`));
  await captura(p, '13-detalle-movil');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await esperarHasta(p, `!document.querySelector('.modal')`, 2000);
  await tamano(p, 1400, 900, false);

  // ---- Elegir (modal de opciones) vía drop con varios destinos no se fuerza; comprobamos solo el estilo de .opciones existe
  ok('css: utilidad .opciones definida', await evaluar(p, `[...document.styleSheets[0].cssRules].some(r => r.selectorText === '.modal-cuerpo .opciones')`));
  ok('css: prefers-reduced-motion presente', await evaluar(p, `[...document.styleSheets[0].cssRules].some(r => r.media && /prefers-reduced-motion/.test(r.media.mediaText))`));

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
