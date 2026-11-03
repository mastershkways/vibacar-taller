// Prueba de F3-02 (pantallas simplificadas, menú Maestros) y F3-03 (Clientes v2) en Brave headless vía CDP.
// Servidor en 5055 con prueba-clientes2.db (tras cliente-prueba-clientes2.js). Capturas en ./capturas-clientes2/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-clientes2');
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
const textosNav = (p) => evaluar(p, `[...document.querySelectorAll('#nav > button, #nav > .menu > .menu-boton')].map(b => b.textContent.trim().replace(/\\s*▾$/, ''))`);
const escribir = (p, sel, valor) => evaluar(p, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(valor)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const clicFila = (p, texto) => evaluar(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes(${JSON.stringify(texto)})); if (!tr) return false; tr.click(); return true; })()`);
const escape = async (p) => { await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2500);
const nFilas = (p) => evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`);
const cabeceras = (p) => evaluar(p, `[...document.querySelectorAll('.tabla thead th')].map(th => th.textContent)`);

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // --- F3-02: cabecera con menú Maestros ------------------------------------------------------
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  const nav = await textosNav(p);
  ok('admin: cabecera Tablero · Listado · Maestros · Usuarios (Clientes y Máquinas ya no van sueltas)', JSON.stringify(nav) === JSON.stringify(['Tablero', 'Listado', 'Maestros', 'Usuarios']), nav.join(' · '));
  ok('Maestros: lista cerrada al cargar', await evaluar(p, `getComputedStyle(document.querySelector('#nav .menu-lista')).display === 'none'`));
  await evaluar(p, `document.querySelector('#nav .menu-boton').click()`);
  ok('Maestros: al pulsar se abre con Clientes y Máquinas, visible (position fixed, no recortada)', await esperarHasta(p, `(() => { const l = document.querySelector('#nav .menu-lista'); const r = l.getBoundingClientRect(); return getComputedStyle(l).display === 'flex' && [...l.querySelectorAll('button')].map(b => b.textContent).join() === 'Clientes,Máquinas' && r.top > 40 && r.width > 100; })()`));
  await captura(p, '01-menu-maestros');
  await evaluar(p, `document.body.click()`);
  ok('Maestros: clic fuera lo cierra', await esperarHasta(p, `getComputedStyle(document.querySelector('#nav .menu-lista')).display === 'none'`));
  await evaluar(p, `document.querySelector('#nav .menu-boton').click()`);
  await esperarHasta(p, `getComputedStyle(document.querySelector('#nav .menu-lista')).display === 'flex'`);
  await evaluar(p, `[...document.querySelectorAll('#nav .menu-lista button')].find(b => b.textContent === 'Clientes').click()`);
  ok('Maestros → Clientes: navega, el menú se cierra y "Maestros" queda marcado como activo', await esperarHasta(p, `location.hash === '#clientes' && getComputedStyle(document.querySelector('#nav .menu-lista')).display === 'none' && document.querySelector('#nav .menu').classList.contains('activo') && document.querySelector('#nav .menu-lista button[data-vista="clientes"]').classList.contains('activo')`));
  await escape(p);

  // --- F3-02/03: tabla de clientes simplificada y regla de 3 años --------------------------------
  const cab = await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10`) && await cabeceras(p);
  ok('clientes: 6 columnas esenciales (sin Email, Origen ni Estado) y 10 filas con actividad', JSON.stringify(cab) === JSON.stringify(['Razón social', 'NIF/CIF', 'Teléfono', 'Contacto técnico', 'Comercial', 'Última factura']) && (await nFilas(p)) === 10, `${JSON.stringify(cab)} filas ${await nFilas(p)}`);
  ok('clientes: sin chips de origen ni de estado; contacto técnico y última factura pintados', (await evaluar(p, `document.querySelectorAll('.tabla tbody .chip-naranja, .tabla tbody .chip-ok').length`)) === 0 && (await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Julen Aranburu') && /\\d{2}\\/\\d{2}\\/\\d{4}/.test(tr.textContent))`)));
  ok('clientes: contador "10 clientes" y filtro "Con actividad / Todos (incluye antiguos)"', (await evaluar(p, `document.querySelector('[data-ref="contador"]').textContent`)) === '10 clientes' && (await evaluar(p, `[...document.querySelectorAll('[name=todos] option')].map(o => o.textContent).join('|')`)) === 'Con actividad|Todos (incluye antiguos)');
  await captura(p, '02-clientes-tabla');
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  ok('Todos: 14 filas (12 + 2 del arnés HTTP), 4 tachadas con chip "antiguo" al final', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; return trs.length === 14 && trs.slice(-4).every(t => t.classList.contains('inactivo') && /antiguo/.test(t.textContent)) && trs.slice(0, -4).every(t => !t.classList.contains('inactivo')); })()`), `${await nFilas(p)} / ${await evaluar(p, `document.querySelectorAll('.tabla tbody tr.inactivo').length`)}`);
  await captura(p, '03-clientes-todos');
  await clicFila(p, 'Txorierri');
  ok('ficha de un antiguo: metadatos "Antiguo: más de 3 años sin factura", sin aviso de Karve, sin Desactivar', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; return /Antiguo/.test(m.querySelector('[data-ref="meta"]').textContent) && !m.querySelector('.aviso-info') && !m.querySelector('[data-ref="desactivar"]') && [...m.querySelectorAll('.acciones button')].map(b => b.textContent).join() === 'Guardar,Cancelar'; })()`));
  await escape(p);
  await sinModal(p);
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10`);

  // --- F3-03: ficha con contactos -------------------------------------------------------------------
  await clicFila(p, 'Grúas Lezama');
  ok('ficha: campos de compras, técnico, facturas y última factura cargados; sin chip de origen', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const v = (n) => m.querySelector('[name=' + n + ']').value; return v('compras_nombre') === 'Maite Lezama' && v('tecnico_nombre') === 'Gorka Lezama' && v('tecnico_email') === 'gruas@lezama.example' && v('email_facturas') === 'administracion@lezama.example' && /^\\d{4}-\\d{2}-\\d{2}$/.test(v('ultima_factura')) && !m.querySelector('.chip-naranja') && m.querySelector('[name=ultima_factura]').type === 'date'; })()`));
  await captura(p, '04-ficha-cliente');
  await escribir(p, '.modal [name=tecnico_telefono]', '600 123 123');
  await escribir(p, '.modal [name=tecnico_email]', 'sin-arroba');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('ficha: email mal formado → el navegador no envía (validación HTML5) y el modal sigue', await evaluar(p, `!!document.querySelector('.modal') && !document.querySelector('.modal [name=tecnico_email]').checkValidity()`));
  await escribir(p, '.modal [name=tecnico_email]', 'gorka@lezama.example');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('ficha: guardar → toast y la fila muestra el teléfono nuevo del contacto técnico', await esperarHasta(p, `!!document.querySelector('.toast-ok')`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Lezama') && tr.textContent.includes('600 123 123'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await evaluar(p, `document.querySelector('[data-accion="nuevo-cliente"]').click()`);
  ok('alta: modal sin aviso de Karve, con los bloques Contacto de compras / técnico / Facturación, foco en razón social', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const t = [...m.querySelectorAll('.subtitulo span')].map(s => s.textContent); return !m.querySelector('.aviso-info') && t.includes('Contacto de compras') && t.includes('Contacto técnico') && t.includes('Facturación') && document.activeElement === m.querySelector('[name=nombre]'); })()`));
  await escribir(p, '.modal [name=nombre]', 'Cliente Arnés Navegador SL');
  await escribir(p, '.modal [name=tecnico_nombre]', 'Técnico Arnés');
  await escribir(p, '.modal [name=ultima_factura]', '2021-03-15');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('alta con última factura de 2021 → se crea pero no aparece en "Con actividad"', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /creado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10 && ![...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Cliente Arnés'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);

  // --- Máquinas y usuarios: sin Origen ni avisos ------------------------------------------------------
  await evaluar(p, `location.hash = 'maquinas'`);
  const cabM = await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length > 5`) && await cabeceras(p);
  ok('máquinas: 6 columnas sin Origen, sin chips de origen ni marca "cliente de baja"', JSON.stringify(cabM) === JSON.stringify(['Máquina', 'Bastidor', 'Nº flota', 'Cliente', 'Estado', 'Horas']) && (await evaluar(p, `document.querySelectorAll('.tabla tbody .chip-naranja').length === 0 && !document.querySelector('.tabla tbody').textContent.includes('cliente de baja')`)), JSON.stringify(cabM));
  ok('máquinas: "Maestros" marcado como activo con Máquinas dentro', await evaluar(p, `document.querySelector('#nav .menu').classList.contains('activo') && document.querySelector('#nav .menu-lista button[data-vista="maquinas"]').classList.contains('activo')`));
  await clicFila(p, 'Liebherr');
  ok('ficha de máquina: sin aviso de Karve ni Origen; mantiene Código Karve', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); return !!m && ![...m.querySelectorAll('.aviso-info')].some(a => /Karve se habilitar/.test(a.textContent)) && !/Origen/.test(m.querySelector('[data-ref="meta"]').textContent) && /Código Karve/.test(m.querySelector('[data-ref="meta"]').textContent); })()`));
  await captura(p, '05-ficha-maquina');
  await escape(p);
  await sinModal(p);
  await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').click()`);
  ok('nueva máquina: el selector de cliente incluye a los antiguos (Txorierri)', await esperarHasta(p, `[...document.querySelectorAll('.modal [data-ref="clientes"] option')].some(o => /Txorierri/.test(o.textContent))`));
  await escape(p);
  await sinModal(p);
  await evaluar(p, `location.hash = 'usuarios'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length > 5`);
  await clicFila(p, 'tecnico1');
  ok('ficha de usuario: sin aviso de Karve', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="form"]') && !document.querySelector('.modal .aviso-info')`));
  await escape(p);
  await sinModal(p);

  // --- Nueva O.T.: un cliente antiguo puede volver --------------------------------------------------
  await evaluar(p, `location.hash = 'listado'`);
  await esperarHasta(p, `!!document.querySelector('[data-accion="nueva"]')`);
  await evaluar(p, `document.querySelector('[data-accion="nueva"]').click()`);
  ok('Nueva O.T.: el selector de cliente incluye a Txorierri (antiguo) y a los de actividad', await esperarHasta(p, `(() => { const o = [...document.querySelectorAll('.modal [data-ref="clientes"] option')]; return o.some(x => /Txorierri/.test(x.textContent)) && o.some(x => /Lezama/.test(x.textContent)); })()`));
  await escape(p);
  await sinModal(p);

  // --- Comercial y técnico ---------------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'comercial1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  ok('comercial: Tablero · Listado · Maestros (sin Usuarios)', JSON.stringify(await textosNav(p)) === JSON.stringify(['Tablero', 'Listado', 'Maestros']), (await textosNav(p)).join(' · '));
  await evaluar(p, `location.hash = 'clientes'`);
  ok('comercial: 2 clientes de su cartera con la tabla nueva', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 2`));
  await clicFila(p, 'Lezama');
  ok('comercial: ficha en solo lectura con los contactos visibles y sin Desactivar', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); return !!m && m.querySelector('[name=tecnico_nombre]').disabled && m.querySelector('[name=tecnico_nombre]').value === 'Gorka Lezama' && m.querySelector('[data-ref="guardar"]').classList.contains('oculto') && !m.querySelector('[data-ref="desactivar"]'); })()`));
  await captura(p, '06-comercial-ficha');
  await escape(p);
  await sinModal(p);
  await salir(p);
  await entrar(p, 'tecnico1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('técnico: sin menú Maestros', (await evaluar(p, `document.querySelectorAll('#nav .menu').length`)) === 0 && !(await textosNav(p)).includes('Maestros'));

  // --- Móvil ------------------------------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
  await dormir(300);
  await evaluar(p, `document.querySelector('#nav .menu-boton').click()`);
  ok('móvil 420: el menú Maestros se abre dentro de la pantalla', await esperarHasta(p, `(() => { const l = document.querySelector('#nav .menu-lista'); const r = l.getBoundingClientRect(); return getComputedStyle(l).display === 'flex' && r.left >= 0 && r.right <= 420; })()`));
  await captura(p, '07-movil-menu');
  await evaluar(p, `[...document.querySelectorAll('#nav .menu-lista button')].find(b => b.textContent === 'Clientes').click()`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10`);
  ok('móvil 420: clientes sin scroll horizontal de página', await evaluar(p, `document.documentElement.scrollWidth <= 420`), `scrollWidth ${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '08-movil-clientes');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
