// Prueba del botón "Sincronizar Karve" y de los contactos en la ficha (F3.5-03) en Brave headless vía CDP.
// Servidor en 5055 con la BD ya sincronizada por cliente-prueba-karve.js. Hace una sincronización real (~40 s).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-karve');
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
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
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
const botonSync = (p) => evaluar(p, `!!document.querySelector('#nav .menu-lista [data-accion="sincronizar-karve"]')`);

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  await entrar(p, 'gerencia1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  ok('gerencia: sin "Sincronizar Karve" en Maestros', !(await botonSync(p)));

  await salir(p);
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  ok('administrativo: "⟳ Sincronizar Karve" al final del desplegable Maestros', (await botonSync(p)) && (await evaluar(p, `[...document.querySelectorAll('#nav .menu-lista button')].map(b => b.textContent).join('|')`)) === 'Clientes|Máquinas|⟳ Sincronizar Karve');
  await evaluar(p, `document.querySelector('#nav .menu-boton').click()`);
  await esperarHasta(p, `getComputedStyle(document.querySelector('#nav .menu-lista')).display === 'flex'`);
  await captura(p, '01-menu-sincronizar');
  await evaluar(p, `document.querySelector('#nav .menu-lista [data-accion="sincronizar-karve"]').click()`);
  ok('pulsar → confirmación "¿Sincronizar…?"', await esperarHasta(p, `!!document.querySelector('#modales .modal-fondo') && /Sincronizar clientes, contactos y máquinas/.test(document.querySelector('#modales .modal-fondo').textContent)`));
  await evaluar(p, `[...document.querySelectorAll('#modales .modal-fondo button')].find(b => b.textContent === 'Sincronizar').click()`);
  ok('toast "Sincronizando con Karve…"', await esperarHasta(p, `[...document.querySelectorAll('.toast')].some(t => /Sincronizando/.test(t.textContent))`, 3000));
  const t0 = Date.now();
  const llego = await esperarHasta(p, `!!document.querySelector('.modal') && /Sincronización con Karve/.test(document.querySelector('.modal h2')?.textContent || '')`, 240000); // la copia de Karve a veces tarda 2 min
  ok(`modal de resumen en ${((Date.now() - t0) / 1000).toFixed(0)} s, con Clientes/Contactos/Máquinas/Duración y toast de resultado`, llego && (await evaluar(p, `(() => { const t = document.querySelector('.modal [data-ref="resumen"]').textContent; return /Clientes/.test(t) && /Contactos/.test(t) && /Máquinas/.test(t) && /Duración/.test(t) && /leídos en Karve/.test(t); })()`)) && (await esperarHasta(p, `[...document.querySelectorAll('.toast-ok')].some(t => /Karve:/.test(t.textContent))`, 3000)));
  ok('modal: lista de avisos (bastidores, sin cliente…)', await evaluar(p, `document.querySelectorAll('.modal [data-ref="alertas"] li').length >= 2`));
  await captura(p, '02-resumen-sincronizacion');
  await escape(p);
  await sinModal(p);

  await evaluar(p, `location.hash = 'clientes'`);
  await esperarHasta(p, `location.hash === '#clientes' && document.querySelectorAll('.tabla tbody tr').length === 50`);
  ok('clientes: 50 filas por página y controles "x–y de total · página 1 de N"', (await evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`)) === 50 && (await evaluar(p, `/1–50 de [\\d.]+ · página 1 de \\d+/.test(document.querySelector('[data-ref="paginacion"]').textContent)`)), await evaluar(p, `document.querySelector('[data-ref="paginacion"]').textContent`));
  const primeraFila = await evaluar(p, `document.querySelector('.tabla tbody tr').textContent`);
  await evaluar(p, `document.querySelector('[data-ref="paginacion"] [data-accion="sig"]').click()`);
  ok('clientes: › pasa a la página 2 con otras filas', await esperarHasta(p, `/página 2 de/.test(document.querySelector('[data-ref="paginacion"]').textContent) && document.querySelector('.tabla tbody tr').textContent !== ${JSON.stringify(primeraFila)}`));
  await evaluar(p, `document.querySelector('[data-ref="paginacion"] [data-accion="ant"]').click()`);
  await esperarHasta(p, `/página 1 de/.test(document.querySelector('[data-ref="paginacion"]').textContent)`);
  await evaluar(p, `location.hash = 'maquinas'`);
  ok('máquinas: 50 filas por página, contador con miles y nº de flota = código de Karve', await esperarHasta(p, `location.hash === '#maquinas' && document.querySelectorAll('.tabla tbody tr').length === 50 && /^\\d[\\d.]* máquinas$/.test(document.querySelector('[data-ref="contador"]').textContent) && [...document.querySelectorAll('.tabla tbody tr')].every(tr => /^\\d+$|^[A-Z0-9-]+$/.test(tr.children[2].textContent))`), await evaluar(p, `document.querySelector('[data-ref="contador"]').textContent`));
  await captura(p, '04-maquinas-paginadas');
  await evaluar(p, `location.hash = 'clientes'`);
  await esperarHasta(p, `location.hash === '#clientes' && document.querySelectorAll('.tabla tbody tr').length === 50`);
  await evaluar(p, `(() => { const el = document.querySelector('[name=q]'); el.value = 'ALDAITURRIAGA'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  ok('clientes: buscar ALDAITURRIAGA → 1 fila con última factura 30/09/2026', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && /30\\/09\\/2026/.test(document.querySelector('.tabla tbody tr').textContent)`));
  await evaluar(p, `document.querySelector('.tabla tbody tr').click()`);
  ok('ficha de un cliente de Karve: bloque "Contactos (de Karve)" con contactos listados', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const b = m.querySelector('[data-ref="bloque-contactos"]'); return b && !b.classList.contains('oculto') && m.querySelectorAll('[data-ref="contactos"] li').length >= 1; })()`));
  await captura(p, '03-ficha-contactos');
  await escape(p);
  await sinModal(p);

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
