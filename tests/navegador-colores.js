// F3-01: revisión visual de los colores nuevos en Brave headless (capturas + estilos calculados). Servidor en 5055.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-colores');
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);
const consola = [];
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
    if (m === 'Runtime.exceptionThrown') consola.push(`EXCEPCIÓN: ${p.exceptionDetails.text}`);
    if (m === 'Runtime.consoleAPICalled' && (p.type === 'error' || p.type === 'warning')) consola.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  await enviar('Page.enable'); await enviar('Runtime.enable');
  await enviar('Emulation.setFocusEmulationEnabled', { enabled: true });
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  return { enviar, esperarEvento, cerrar: () => ws.close() };
}
const evaluar = async (p, expr) => {
  const r = await p.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text} ${expr.slice(0, 120)}`);
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
}
const color = (p, sel, prop) => evaluar(p, `getComputedStyle(document.querySelector(${JSON.stringify(sel)}))[${JSON.stringify(prop)}]`);

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();
  await navegar(p, `${BASE}/`);
  if ((await evaluar(p, 'location.pathname')) !== '/acceso') { await salir(p); await navegar(p, `${BASE}/`); }
  ok('acceso: botón ámbar #f28c00 con texto oscuro', (await color(p, 'button', 'backgroundColor')) === 'rgb(242, 140, 0)' && (await color(p, 'button', 'color')) === 'rgb(26, 29, 33)', `${await color(p, 'button', 'backgroundColor')} / ${await color(p, 'button', 'color')}`);
  await captura(p, '01-acceso');

  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await esperarHasta(p, `document.querySelectorAll('.tarjeta').length > 0`);
  ok('cabecera: línea inferior ámbar', (await color(p, '.cabecera', 'borderBottomColor')) === 'rgb(242, 140, 0)', await color(p, '.cabecera', 'borderBottomColor'));
  ok('pestaña activa: texto ámbar oscuro legible (#8a4b00)', (await color(p, '#nav button.activo', 'color')) === 'rgb(138, 75, 0)', await color(p, '#nav button.activo', 'color'));
  ok('theme-color #f28c00', (await evaluar(p, `document.querySelector('meta[name=theme-color]').content`)) === '#f28c00');
  await captura(p, '02-tablero');
  await evaluar(p, `location.hash = 'clientes'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length > 1`);
  ok('botón primario: fondo ámbar y texto oscuro', (await color(p, '.btn-primario', 'backgroundColor')) === 'rgb(242, 140, 0)' && (await color(p, '.btn-primario', 'color')) === 'rgb(26, 29, 33)', `${await color(p, '.btn-primario', 'backgroundColor')} / ${await color(p, '.btn-primario', 'color')}`);
  await captura(p, '03-clientes');
  await evaluar(p, `location.hash = 'usuarios'`);
  await esperarHasta(p, `!!document.querySelector('.tabla tbody .chip-naranja')`);
  ok('chip Técnico interno (usuarios): ámbar con texto oscuro', (await color(p, '.chip-naranja', 'backgroundColor')) === 'rgb(242, 140, 0)' && (await color(p, '.chip-naranja', 'color')) === 'rgb(26, 29, 33)', `${await color(p, '.chip-naranja', 'color')}`);
  await evaluar(p, `location.hash = 'clientes'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length > 1`);
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes('Lezama')).click()`);
  await esperarHasta(p, `!!document.querySelector('.modal [name=nombre]')`);
  await dormir(350);
  ok('foco en input: borde ámbar', (await color(p, '.modal [name=nombre]', 'borderColor')) === 'rgb(242, 140, 0)', await color(p, '.modal [name=nombre]', 'borderColor'));
  await captura(p, '04-ficha-cliente');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(400);
  await evaluar(p, `location.hash = 'maquinas'`);
  await esperarHasta(p, `location.hash === '#maquinas' && document.querySelectorAll('.tabla tbody tr').length > 1`);
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes('Liebherr')).click()`);
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="aviso-bloqueo"]:not(.oculto)')`);
  await dormir(350);
  ok('aviso info (bloqueo de máquina): fondo ámbar suave y texto ámbar oscuro', (await color(p, '.modal .aviso-info', 'backgroundColor')) === 'rgb(255, 244, 229)' && (await color(p, '.modal .aviso-info', 'color')) === 'rgb(138, 75, 0)', `${await color(p, '.modal .aviso-info', 'backgroundColor')} / ${await color(p, '.modal .aviso-info', 'color')}`);
  await captura(p, '04b-ficha-maquina');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await dormir(400);
  await evaluar(p, `location.hash = 'usuarios'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length > 1`);
  await captura(p, '05-usuarios');

  await salir(p);
  await entrar(p, 'tecnico1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('.tarjeta-grande').length > 0`);
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: true });
  await dormir(300);
  await captura(p, '06-tablet-misot');
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
  await dormir(300);
  await captura(p, '07-movil');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola:', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
