// Comprobación visual de la interfaz con los datos de prueba (Brave headless + CDP). Capturas en ./capturas-datos/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-datos');
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
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
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
  ok(`login ${usuario}`, (await evaluar(p, 'location.pathname')) === '/');
}

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  ok('kanban: 18 tarjetas repartidas en 9 columnas, ninguna vacía', await esperarHasta(p, `document.querySelectorAll('.tarjeta').length === 18 && [...document.querySelectorAll('.columna')].every(c => c.querySelectorAll('.tarjeta').length >= 1)`), `tarjetas ${await evaluar(p, `document.querySelectorAll('.tarjeta').length`)}, por columna ${await evaluar(p, `[...document.querySelectorAll('.columna')].map(c => c.querySelectorAll('.tarjeta').length).join('/')`)}`);
  ok('kanban: tarjetas con técnico en las columnas asignadas en adelante', await evaluar(p, `[...document.querySelectorAll('.columna[data-fase="en_curso"] .tarjeta, .columna[data-fase="asignada"] .tarjeta')].every(t => !!t.querySelector('.tecnico'))`));
  await captura(p, '01-kanban-lleno');

  await evaluar(p, `[...document.querySelectorAll('.tarjeta')].find(t => t.textContent.includes('Mando de la cesta')).click()`);
  ok('detalle: O.T. con propuesta de técnico pendiente y notas internas', await esperarHasta(p, `!!document.querySelector('.modal .propuesta') && /prioritario/.test(document.querySelector('.modal textarea[name=notas_internas]').value)`));
  await captura(p, '02-detalle-propuesta');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await esperarHasta(p, `!document.querySelector('.modal')`, 2000);

  await evaluar(p, `[...document.querySelectorAll('.tarjeta')].find(t => t.textContent.includes('Cristal de la cabina')).click()`);
  ok('detalle: historial largo (vb_factura: 6 entradas con notas de técnico y finanzas)', await esperarHasta(p, `document.querySelectorAll('.modal [data-ref="historial"] li').length === 6 && /Visto bueno/.test(document.querySelector('.modal [data-ref="historial"]').textContent)`), `${await evaluar(p, `document.querySelectorAll('.modal [data-ref="historial"] li').length`)}`);
  await captura(p, '03-detalle-historial');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await esperarHasta(p, `!document.querySelector('.modal')`, 2000);

  await evaluar(p, `location.hash = 'listado'`);
  ok('listado: 18 abiertas; con "Todas" 20', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 18`));
  await evaluar(p, `(() => { const s = document.querySelector('[name=abiertas]'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
  ok('listado: Todas → 20 filas', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 20`));
  await captura(p, '04-listado-todas');

  await evaluar(p, `location.hash = 'clientes'`);
  ok('clientes: 10 activos, chips Karve y Manual', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10 && document.querySelectorAll('.tabla .chip-naranja').length === 5 && document.querySelectorAll('.tabla .chip-claro').length >= 5`));
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  ok('clientes: Todos → 12 filas, 2 tachadas (una Karve y una manual)', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 12 && document.querySelectorAll('.tabla tr.inactivo').length === 2 && [...document.querySelectorAll('.tabla tr.inactivo')].some(tr => !!tr.querySelector('.chip-naranja'))`));
  await captura(p, '05-clientes-todos');
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(tr => tr.textContent.includes('Ibaizabal')).click()`);
  ok('cliente Karve: ficha con código Karve y 3 máquinas', await esperarHasta(p, `/C000214/.test(document.querySelector('.modal [data-ref="meta"]')?.textContent) && /Máquinas\\s*3/.test(document.querySelector('.modal [data-ref="meta"]').textContent.replace(/\\n/g, ' '))`), await evaluar(p, `document.querySelector('.modal [data-ref="meta"]')?.textContent.replace(/\\s+/g, ' ')`));
  await captura(p, '06-cliente-karve');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await esperarHasta(p, `!document.querySelector('.modal')`, 2000);

  await salir(p);
  await entrar(p, 'tecnico1', 'prueba123');
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: true });
  ok('tecnico1: Mis O.T. con sus asignadas (abiertas)', await esperarHasta(p, `document.querySelectorAll('.tarjeta-grande').length >= 3`), `${await evaluar(p, `document.querySelectorAll('.tarjeta-grande').length`)}`);
  await captura(p, '07-misot-tecnico1');
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });

  await salir(p);
  await entrar(p, 'comercial1', 'prueba123');
  ok('comercial1: Listado por defecto con pestañas Tablero y Clientes', await esperarHasta(p, `document.querySelector('#nav button.activo')?.textContent === 'Listado' && [...document.querySelectorAll('#nav button')].map(b => b.textContent).join(',') === 'Tablero,Listado,Clientes'`));
  await captura(p, '08-listado-comercial');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
