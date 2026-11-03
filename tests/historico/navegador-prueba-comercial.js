// Prueba de la relación vendedor ↔ cliente (F2-05) en Brave headless vía DevTools Protocol, sin dependencias.
// Servidor de prueba en 5055 con BD temporal (prueba-comercial.db, tras cliente-prueba-comercial.js). Capturas en ./capturas-comercial/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-comercial');
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
  await enviar('Emulation.setFocusEmulationEnabled', { enabled: true });
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
async function salir(p) {
  const nav = p.esperarEvento('Page.loadEventFired');
  await evaluar(p, `document.querySelector('header form').requestSubmit()`);
  await nav;
}
async function entrar(p, usuario, clave) {
  await navegar(p, `${BASE}/`);
  if ((await evaluar(p, 'location.pathname')) !== '/acceso') { await salir(p); await navegar(p, `${BASE}/`); }
  const nav = p.esperarEvento('Page.loadEventFired');
  await evaluar(p, `(() => { document.getElementById('usuario').value = ${JSON.stringify(usuario)}; document.getElementById('clave').value = ${JSON.stringify(clave)}; document.getElementById('formulario').requestSubmit(); })()`);
  await nav;
  ok(`login ${usuario} → /`, (await evaluar(p, 'location.pathname')) === '/');
}
const navTiene = (p, texto) => evaluar(p, `[...document.querySelectorAll('#nav button')].some(b => b.textContent === ${JSON.stringify(texto)})`);
const elegirOpcion = (p, sel, texto) => evaluar(p, `(() => { const s = document.querySelector(${JSON.stringify(sel)}); const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(texto)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const clicFila = (p, texto) => evaluar(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes(${JSON.stringify(texto)})); if (!tr) return false; tr.click(); return true; })()`);
const escape = async (p) => { await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2500);
const nFilas = (p) => evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`);
const filaTiene = (p, texto, celda) => evaluar(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes(${JSON.stringify(texto)})); return !!tr && tr.textContent.includes(${JSON.stringify(celda)}); })()`);
const CARTERA = ['Áridos y Hormigones Ibaizabal SA', 'Grúas Lezama'];

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // --- Admin: columna Comercial y selector en la ficha ----------------------------------------
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await evaluar(p, `location.hash = 'clientes'`);
  ok('admin: tabla de clientes con columna "Comercial" (7 columnas) y 10 activos', await esperarHasta(p, `document.querySelectorAll('.tabla thead th').length === 7 && [...document.querySelectorAll('.tabla thead th')].some(th => th.textContent === 'Comercial') && document.querySelectorAll('.tabla tbody tr').length === 10`), `filas ${await nFilas(p)}`);
  ok('admin: Ibaizabal y Lezama muestran "Iker Goikoetxea"; Garaio no', (await filaTiene(p, 'Ibaizabal', 'Iker Goikoetxea')) && (await filaTiene(p, 'Grúas Lezama', 'Iker Goikoetxea')) && !(await filaTiene(p, 'Garaio', 'Iker')));
  await captura(p, '01-clientes-columna-comercial');
  await clicFila(p, 'Grúas Lezama');
  ok('admin: ficha de Lezama con el selector "Comercial responsable" en Iker, habilitado, con "Sin comercial" + Iker + jefe comercial', await esperarHasta(p, `(() => { const s = document.querySelector('.modal [data-ref="comerciales"]'); return !!s && !s.disabled && s.options.length === 3 && s.selectedOptions[0].textContent === 'Iker Goikoetxea'; })()`));
  await captura(p, '02-ficha-cliente-comercial');
  await escape(p);
  await sinModal(p);
  await clicFila(p, 'Garaio');
  ok('admin: ficha de Garaio sin comercial ("— Sin comercial —" seleccionado)', await esperarHasta(p, `document.querySelector('.modal [data-ref="comerciales"]')?.value === ''`));
  await elegirOpcion(p, '.modal [data-ref="comerciales"]', 'Iker');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('admin: asignar Iker a Garaio → toast y la fila muestra el comercial', await esperarHasta(p, `!!document.querySelector('.toast-ok')`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Garaio') && tr.textContent.includes('Iker Goikoetxea'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await clicFila(p, 'Garaio');
  await esperarHasta(p, `(s => !!s && s.value !== '')(document.querySelector('.modal [data-ref="comerciales"]'))`);
  await evaluar(p, `(() => { const s = document.querySelector('.modal [data-ref="comerciales"]'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('admin: quitar el comercial de Garaio → la fila queda sin comercial', await esperarHasta(p, `!!document.querySelector('.toast-ok')`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Garaio') && !tr.textContent.includes('Iker'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await evaluar(p, `document.querySelector('[data-accion="nuevo-cliente"]').click()`);
  ok('admin: alta de cliente: selector presente con "Sin comercial" por defecto', await esperarHasta(p, `document.querySelector('.modal [data-ref="comerciales"]')?.value === '' && document.querySelector('.modal [data-ref="comerciales"]').options.length === 3`));
  await escape(p);
  await sinModal(p);
  await evaluar(p, `location.hash = 'kanban'`);
  ok('admin: Kanban completo (más de 4 tarjetas)', await esperarHasta(p, `document.querySelectorAll('.tarjeta').length > 4`), `${await evaluar(p, `document.querySelectorAll('.tarjeta').length`)}`);

  // --- Comercial: todo filtrado por su cartera ------------------------------------------------
  await salir(p);
  await entrar(p, 'comercial1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('comercial: pestañas Tablero, Listado, Clientes y Máquinas; sin Usuarios; entra en Listado', (await navTiene(p, 'Tablero')) && (await navTiene(p, 'Listado')) && (await navTiene(p, 'Clientes')) && (await navTiene(p, 'Máquinas')) && !(await navTiene(p, 'Usuarios')) && (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Listado');
  ok('comercial: Listado con 4 O.T. abiertas, todas de Ibaizabal o Lezama', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; return trs.length === 4 && trs.every(tr => /Ibaizabal|Lezama/.test(tr.textContent)); })()`), `${await nFilas(p)}`);
  await evaluar(p, `location.hash = 'kanban'`);
  ok('comercial: Kanban con 4 tarjetas, todas de su cartera', await esperarHasta(p, `(() => { const t = [...document.querySelectorAll('.tarjeta')]; return t.length === 4 && t.every(x => /Ibaizabal|Lezama/.test(x.textContent)); })()`), `${await evaluar(p, `document.querySelectorAll('.tarjeta').length`)}`);
  await captura(p, '03-comercial-kanban');
  await evaluar(p, `location.hash = 'clientes'`);
  ok('comercial: tabla de clientes con solo sus 2 clientes, sin botón Nuevo', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; return trs.length === 2 && trs.every(tr => /Ibaizabal|Lezama/.test(tr.textContent)) && document.querySelector('[data-accion="nuevo-cliente"]').classList.contains('oculto'); })()`), `${await nFilas(p)}`);
  ok('comercial: contador "2 clientes"', (await evaluar(p, `document.querySelector('[data-ref="contador"]').textContent`)) === '2 clientes');
  await captura(p, '04-comercial-clientes');
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await dormir(500);
  ok('comercial: "Todos" sigue mostrando solo su cartera (2)', (await nFilas(p)) === 2, `${await nFilas(p)}`);
  await clicFila(p, 'Grúas Lezama');
  ok('comercial: ficha de Lezama en solo lectura, selector de comercial deshabilitado en Iker, con sus 2 máquinas', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const s = m.querySelector('[data-ref="comerciales"]'); return s.disabled && s.selectedOptions[0]?.textContent === 'Iker Goikoetxea' && m.querySelector('[data-ref="guardar"]').classList.contains('oculto') && m.querySelectorAll('[data-ref="maquinas"] li').length === 2; })()`));
  await captura(p, '05-comercial-ficha-solo-lectura');
  await escape(p);
  await sinModal(p);
  await evaluar(p, `location.hash = 'maquinas'`);
  ok('comercial: tabla de máquinas con las 5 de su cartera', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; return trs.length === 5 && trs.every(tr => /Ibaizabal|Lezama/.test(tr.textContent)); })()`), `${await nFilas(p)}`);
  // O.T. ajena por URL: el detalle no se abre (404 → toast de error)
  const idAjena = await evaluar(p, `fetch('/api/ot?abiertas=0&limite=100').then(r => r.json()).then(j => Math.max(...j.ots.map(o => o.id)) + 100)`);
  await evaluar(p, `location.hash = 'ot/1'`);
  ok('comercial: abrir por URL una O.T. que no es de su cartera → aviso de error y sin modal', await esperarHasta(p, `!!document.querySelector('.toast-error') && /no encontrada/i.test(document.querySelector('.toast-error').textContent)`, 5000) && !(await evaluar(p, `!!document.querySelector('#modales .modal-fondo')`)), `idAjena=${idAjena}`);
  await esperarHasta(p, `!document.querySelector('.toast-error')`, 6000);

  // --- Jefe comercial: todo, en solo lectura ---------------------------------------------------------
  await salir(p);
  await entrar(p, 'jefeventas1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('jefe comercial: cabecera "Jefe comercial", pestañas Tablero/Listado/Clientes/Máquinas, sin Usuarios', (await evaluar(p, `document.querySelector('#usuario-rol').textContent`)) === 'Jefe comercial' && (await navTiene(p, 'Tablero')) && (await navTiene(p, 'Clientes')) && !(await navTiene(p, 'Usuarios')));
  await evaluar(p, `location.hash = 'kanban'`);
  ok('jefe comercial: Kanban completo (más de 4 tarjetas, con clientes fuera de la cartera de Iker)', await esperarHasta(p, `document.querySelectorAll('.tarjeta').length > 4 && [...document.querySelectorAll('.tarjeta')].some(t => /Garaio|Urkiola|Mendibil/.test(t.textContent))`), `${await evaluar(p, `document.querySelectorAll('.tarjeta').length`)}`);
  await captura(p, '07-jefe-comercial-kanban');
  await evaluar(p, `location.hash = 'clientes'`);
  ok('jefe comercial: los 10 clientes activos, sin botón Nuevo', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10 && document.querySelector('[data-accion="nuevo-cliente"]').classList.contains('oculto')`), `${await nFilas(p)}`);
  await clicFila(p, 'Garaio');
  ok('jefe comercial: ficha de un cliente sin comercial en solo lectura', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); return !!m && m.querySelector('[data-ref="guardar"]').classList.contains('oculto') && m.querySelector('[data-ref="comerciales"]').disabled; })()`));
  await escape(p);
  await sinModal(p);

  // --- Financiero: ve todo y puede asignar ------------------------------------------------------
  await salir(p);
  await entrar(p, 'finanzas1', 'prueba123');
  await evaluar(p, `location.hash = 'clientes'`);
  ok('financiero: ve los 10 clientes activos', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10`), `${await nFilas(p)}`);
  await clicFila(p, 'Garaio');
  ok('financiero: ficha editable con el selector de comercial habilitado', await esperarHasta(p, `(() => { const s = document.querySelector('.modal [data-ref="comerciales"]'); return !!s && !s.disabled && s.options.length === 3; })()`));
  await escape(p);
  await sinModal(p);

  // --- Móvil (comercial) ------------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'comercial1', 'prueba123');
  await evaluar(p, `location.hash = 'clientes'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 2`);
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
  await dormir(300);
  ok('móvil 420: sin scroll horizontal de página', await evaluar(p, `document.documentElement.scrollWidth <= 420`), `scrollWidth ${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '06-comercial-movil');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
