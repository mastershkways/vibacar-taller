// Prueba del maestro de clientes (F2-02) en Brave headless vía DevTools Protocol, sin dependencias.
// Servidor de prueba en 5055 con BD temporal (prueba-revamp.db). Capturas en ./capturas-clientes/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-clientes');
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
const filasCon = (p, texto) => evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].filter(tr => tr.textContent.includes(${JSON.stringify(texto)})).length`);
const escribir = (p, sel, valor) => evaluar(p, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(valor)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2000);

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // ---- Admontaller
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  ok('admin: pestaña Clientes en el menú', await esperarHasta(p, `[...document.querySelectorAll('#nav button')].some(b => b.textContent === 'Clientes')`));
  await evaluar(p, `location.hash = 'clientes'`);
  ok('clientes: vista con filas, buscador y botón Nuevo', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length >= 3 && !!document.querySelector('[name=q]') && !!document.querySelector('[data-accion="nuevo-cliente"]')`), `filas ${await evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`)}`);
  ok('clientes: columna Origen con chip Manual', await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].every(tr => tr.querySelector('.chip-claro')?.textContent === 'Manual')`));
  ok('clientes: contador', /\d+ clientes/.test(await evaluar(p, `document.querySelector('[data-ref="contador"]').textContent`)));
  await captura(p, '01-clientes-admin');

  // Alta
  await evaluar(p, `document.querySelector('[data-accion="nuevo-cliente"]').click()`);
  ok('nuevo: modal con animación y aviso de Karve (Fase 5)', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="form"]') && /Fase 5/.test(document.querySelector('.modal .aviso-info')?.textContent) && getComputedStyle(document.querySelector('.modal')).animationName === 'modal-entra'`));
  ok('nuevo: título y foco en Razón social', await esperarHasta(p, `document.querySelector('.modal [data-ref="titulo"]').textContent === 'Nuevo cliente' && document.activeElement === document.querySelector('.modal [name=nombre]')`));
  ok('nuevo: sin botón Desactivar ni metadatos', await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto') && document.querySelector('.modal [data-ref="meta"]').classList.contains('oculto')`));
  await captura(p, '02-nuevo-cliente');
  // Error de validación visible en el modal (email mal)
  await escribir(p, '.modal [name=nombre]', 'Talleres Headless SA');
  await escribir(p, '.modal [name=cif]', 'a-99999999');
  await escribir(p, '.modal [name=telefono]', '600 123 456');
  await escribir(p, '.modal [name=email]', 'compras@headless.example');
  await escribir(p, '.modal [name=direccion]', 'Calle Prueba 1, Bilbao');
  await evaluar(p, `document.querySelector('.modal [name=exige_pedido]').checked = true`);
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nuevo: guardar → toast ok y modal cerrado', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /creado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p));
  ok('nuevo: fila nueva con CIF normalizado y chip Manual', await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Talleres Headless SA') && tr.textContent.includes('A99999999') && tr.querySelector('.chip-claro')?.textContent === 'Manual')`));
  await captura(p, '03-clientes-tras-alta');

  // CIF duplicado → 409 en el modal
  await evaluar(p, `document.querySelector('[data-accion="nuevo-cliente"]').click()`);
  await esperarHasta(p, `!!document.querySelector('.modal [name=nombre]')`);
  await escribir(p, '.modal [name=nombre]', 'Duplicado SL');
  await escribir(p, '.modal [name=cif]', 'A99999999');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nuevo: CIF repetido → aviso de conflicto en el modal (409) y sigue abierto', await esperarHasta(p, `!!document.querySelector('.modal .aviso-conflicto') && /Talleres Headless/.test(document.querySelector('.modal .aviso-conflicto').textContent)`));
  await captura(p, '04-nuevo-409');
  await evaluar(p, `document.querySelector('.modal [data-accion="cerrar"]').click()`);
  ok('nuevo: Cancelar cierra', await sinModal(p));

  // Búsqueda instantánea
  await escribir(p, '[name=q]', 'headless');
  ok('buscar "headless" → 1 fila (sin pulsar Enter)', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && document.querySelector('.tabla tbody tr').textContent.includes('Talleres Headless')`));
  await escribir(p, '[name=q]', '600 123');
  ok('buscar por teléfono → 1 fila', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1`));
  await escribir(p, '[name=q]', 'zzzz-no-existe');
  ok('buscar sin resultados → "Sin resultados"', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && /Sin resultados/.test(document.querySelector('.tabla tbody').textContent)`));
  await captura(p, '05-busqueda');
  await escribir(p, '[name=q]', '');
  ok('buscar vacío → todas', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length >= 4`));

  // Edición
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(tr => tr.textContent.includes('Talleres Headless')).click()`);
  ok('editar: modal con datos cargados, metadatos y botón Desactivar', await esperarHasta(p, `document.querySelector('.modal [data-ref="titulo"]')?.textContent === 'Talleres Headless SA' && document.querySelector('.modal [name=telefono]').value === '600 123 456' && document.querySelector('.modal [name=exige_pedido]').checked && !document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto') && /Manual/.test(document.querySelector('.modal [data-ref="meta"]').textContent)`));
  await captura(p, '06-editar-cliente');
  await escribir(p, '.modal [name=telefono]', '600 999 000');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('editar: guardar → toast y fila actualizada', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /guardado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('600 999 000'))`));

  // Baja lógica
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(tr => tr.textContent.includes('Talleres Headless')).click()`);
  await esperarHasta(p, `document.querySelector('.modal [data-ref="titulo"]')?.textContent === 'Talleres Headless SA'`);
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  ok('desactivar: pide confirmación (modal elegir)', await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 2 && /Desactivar a/.test(document.querySelectorAll('#modales .modal-fondo')[1].textContent)`));
  await captura(p, '07-confirmar-desactivar');
  await evaluar(p, `[...document.querySelectorAll('#modales .modal-fondo')[1].querySelectorAll('button')].find(b => /Sí, desactivar/.test(b.textContent)).click()`);
  ok('desactivar: toast y la fila desaparece de Activos', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /desactivado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `![...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Talleres Headless'))`));
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  ok('Mostrar Todos: aparece como Desactivado, tachado y al final', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; const tr = trs.find(t => t.textContent.includes('Talleres Headless')); return tr && tr.classList.contains('inactivo') && /Desactivado/.test(tr.textContent) && trs[trs.length - 1] === tr; })()`));
  await captura(p, '08-clientes-todos');
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(tr => tr.textContent.includes('Talleres Headless')).click()`);
  ok('reactivar: el botón dice Reactivar', await esperarHasta(p, `document.querySelector('.modal [data-ref="desactivar"]')?.textContent === 'Reactivar' && !document.querySelector('.modal [data-ref="desactivar"]').classList.contains('btn-peligro')`));
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  ok('reactivar: sin confirmación, toast y vuelve a Activo', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /reactivado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes('Talleres Headless')); return tr && !tr.classList.contains('inactivo') && /Activo/.test(tr.textContent); })()`));
  ok('desktop: sin scroll horizontal', await evaluar(p, `document.documentElement.scrollWidth <= 1400`));

  // Nueva O.T. sigue listando clientes (comparte la API)
  await evaluar(p, `location.hash = 'listado'`);
  await esperarHasta(p, `!!document.querySelector('[data-accion="nueva"]')`);
  await evaluar(p, `document.querySelector('[data-accion="nueva"]').click()`);
  ok('nueva O.T.: el cliente nuevo aparece en el selector', await esperarHasta(p, `[...document.querySelectorAll('.modal [data-ref="clientes"] option')].some(o => o.textContent.includes('Talleres Headless'))`));
  await evaluar(p, `document.querySelector('.modal [data-accion="cerrar"]').click()`);
  await sinModal(p);

  // ---- Técnico: sin pestaña Clientes
  await salir(p);
  await entrar(p, 'tec1', 'tecnico123');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('técnico: sin pestaña Clientes', !(await navTiene(p, 'Clientes')));
  await evaluar(p, `location.hash = 'clientes'`);
  await dormir(500);
  ok('técnico: #clientes redirige a su vista por defecto', (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Mis O.T.');

  // ---- Comercial: pestaña sí, solo lectura
  await salir(p);
  await entrar(p, 'com1', 'comercial123');
  ok('comercial: pestaña Clientes', await esperarHasta(p, `[...document.querySelectorAll('#nav button')].some(b => b.textContent === 'Clientes')`));
  await evaluar(p, `location.hash = 'clientes'`);
  ok('comercial: lista sin botón Nuevo', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length >= 4`) && !(await evaluar(p, `!!document.querySelector('[data-accion="nuevo-cliente"]') && !document.querySelector('[data-accion="nuevo-cliente"]').classList.contains('oculto')`)));
  await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].find(tr => tr.textContent.includes('Talleres Headless')).click()`);
  ok('comercial: ficha en solo lectura (campos deshabilitados, sin Guardar ni Desactivar)', await esperarHasta(p, `document.querySelector('.modal [name=nombre]')?.disabled === true && document.querySelector('.modal [data-ref="guardar"]').classList.contains('oculto') && document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto')`));
  await captura(p, '09-comercial-solo-lectura');
  await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sinModal(p);
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
  await dormir(400);
  ok('móvil 420: sin scroll horizontal de página', await evaluar(p, `document.documentElement.scrollWidth <= 420`), `scrollWidth ${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '10-clientes-movil');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
