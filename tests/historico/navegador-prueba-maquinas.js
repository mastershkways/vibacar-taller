// Prueba del maestro de máquinas (F2-03) en Brave headless vía DevTools Protocol, sin dependencias.
// Servidor de prueba en 5055 con BD temporal (prueba-maquinas.db, tras cliente-prueba-maquinas.js). Capturas en ./capturas-maquinas/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-maquinas');
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
const escribir = (p, sel, valor) => evaluar(p, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(valor)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const elegirOpcion = (p, sel, texto) => evaluar(p, `(() => { const s = document.querySelector(${JSON.stringify(sel)}); const o = [...s.options].find(o => o.textContent.includes(${JSON.stringify(texto)})); if (!o) return false; s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const clicFila = (p, texto) => evaluar(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes(${JSON.stringify(texto)})); if (!tr) return false; tr.click(); return true; })()`);
const escape = async (p) => { await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2500);
const nModales = (p) => evaluar(p, `document.querySelectorAll('#modales .modal-fondo:not(.cerrando)').length`);

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // --- Admin: vista Máquinas ---------------------------------------------------------------
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  ok('admin: pestaña Máquinas en el menú, tras Clientes', await esperarHasta(p, `(() => { const n = [...document.querySelectorAll('#nav button')].map(b => b.textContent); return n.indexOf('Máquinas') === n.indexOf('Clientes') + 1; })()`));
  await evaluar(p, `location.hash = 'maquinas'`);
  ok('máquinas: 24 filas activas (24 de datos + Liebherr − Kubota de baja), buscador y botón Nueva', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 24 && !!document.querySelector('[name=q]') && !!document.querySelector('[data-accion="nueva-maquina"]')`), `filas ${await evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`)}`);
  ok('máquinas: 13 chips Karve y 11 Manual en Origen; horas con unidad; chips Activa', await evaluar(p, `document.querySelectorAll('.tabla tbody .chip-naranja').length === 13 && [...document.querySelectorAll('.tabla tbody .chip-claro')].filter(c => c.textContent === 'Manual').length === 11 && /\\d h$/.test(document.querySelector('.tabla tbody td.suave').textContent) && document.querySelectorAll('.tabla tbody .chip-ok').length === 24`));
  ok('máquinas: contador "24 máquinas"', (await evaluar(p, `document.querySelector('[data-ref="contador"]').textContent`)) === '24 máquinas');
  ok('máquinas: las del cliente de baja llevan la marca "cliente de baja"', await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => /cliente de baja/.test(tr.textContent))`));
  await captura(p, '01-maquinas-admin');

  // --- Alta -------------------------------------------------------------------------------
  await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').click()`);
  ok('nueva: modal con aviso Karve (Fase 5), título y foco en el buscador de cliente', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="form"]') && /Fase 5/.test(document.querySelector('.modal .aviso-info')?.textContent) && document.querySelector('.modal [data-ref="titulo"]').textContent === 'Nueva máquina' && document.activeElement === document.querySelector('.modal [data-ref="buscar-cliente"]')`));
  ok('nueva: el selector solo lista los 10 clientes activos (sin Txorierri ni Berriz)', await esperarHasta(p, `(() => { const o = [...document.querySelectorAll('.modal [data-ref="clientes"] option')]; return o.length === 10 && !o.some(x => /Txorierri|Berriz/.test(x.textContent)); })()`), `${await evaluar(p, `document.querySelectorAll('.modal [data-ref="clientes"] option').length`)}`);
  ok('nueva: sin botón Desactivar ni metadatos', await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto') && document.querySelector('.modal [data-ref="meta"]').classList.contains('oculto')`));
  await escribir(p, '.modal [data-ref="buscar-cliente"]', 'lezama');
  ok('nueva: filtrar "lezama" deja 1 opción', await esperarHasta(p, `document.querySelectorAll('.modal [data-ref="clientes"] option').length === 1`));
  await elegirOpcion(p, '.modal [data-ref="clientes"]', 'Lezama');
  await escribir(p, '.modal [name=marca]', 'Terex');
  await escribir(p, '.modal [name=modelo]', 'AC 55');
  await escribir(p, '.modal [name=bastidor]', 'w09test-ac55');
  await escribir(p, '.modal [name=num_flota]', 'GL-20');
  await escribir(p, '.modal [name=horometro_ultimo]', '2450.5');
  await escribir(p, '.modal [name=observaciones]', 'Alta desde el arnés de navegador');
  await captura(p, '02-nueva-maquina');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nueva: guardar → toast "creada" y modal cerrado', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /creada/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p));
  ok('nueva: fila con bastidor en mayúsculas, cliente, horas y chip Manual', await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Terex AC 55') && tr.textContent.includes('W09TEST-AC55') && tr.textContent.includes('Grúas Lezama') && /2450,5 h/.test(tr.textContent) && [...tr.querySelectorAll('.chip-claro')].some(c => c.textContent === 'Manual'))`));
  await captura(p, '03-maquinas-tras-alta');

  // 409 por bastidor repetido
  await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').click()`);
  await esperarHasta(p, `document.querySelectorAll('.modal [data-ref="clientes"] option').length === 10`);
  await elegirOpcion(p, '.modal [data-ref="clientes"]', 'Ibaizabal');
  await escribir(p, '.modal [name=marca]', 'Duplicada');
  await escribir(p, '.modal [name=bastidor]', 'W09TEST-AC55');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nueva: bastidor repetido → aviso de conflicto (409) en el modal, que sigue abierto', await esperarHasta(p, `!!document.querySelector('.modal .aviso-conflicto') && /W09TEST-AC55/.test(document.querySelector('.modal .aviso-conflicto').textContent) && /Grúas Lezama/.test(document.querySelector('.modal .aviso-conflicto').textContent)`));
  await captura(p, '04-nueva-409');
  await evaluar(p, `[...document.querySelectorAll('.modal [data-accion="cerrar"]')].pop().click()`);
  ok('nueva: Cancelar cierra', await sinModal(p));

  // --- Búsqueda ---------------------------------------------------------------------------
  await escribir(p, '[name=q]', 'lezama');
  ok('buscar "lezama" → 4 filas activas, todas de Grúas Lezama (sin pulsar Enter)', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 4 && [...document.querySelectorAll('.tabla tbody tr')].every(tr => tr.textContent.includes('Grúas Lezama'))`), `${await evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`)}`);
  await escribir(p, '[name=q]', 'ac55');
  ok('buscar por bastidor → 1 fila', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && document.querySelector('.tabla tbody tr').textContent.includes('Terex')`));
  await escribir(p, '[name=q]', 'M000');
  ok('buscar por código Karve → solo chips Karve', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length >= 5 && document.querySelectorAll('.tabla tbody .chip-naranja').length === document.querySelectorAll('.tabla tbody tr').length`));
  await escribir(p, '[name=q]', 'zzzz');
  ok('buscar sin resultados → "Sin resultados"', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && /Sin resultados/.test(document.querySelector('.tabla tbody').textContent)`));
  await captura(p, '05-busqueda');
  await escribir(p, '[name=q]', '');
  ok('buscar vacío → 25 activas', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 25`));

  // --- Edición ----------------------------------------------------------------------------
  await clicFila(p, 'Terex AC 55');
  ok('editar: modal con título, cliente preseleccionado, campos cargados, metadatos (Manual, O.T. 0) y Desactivar', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const s = m.querySelector('[data-ref="clientes"]'); return m.querySelector('[data-ref="titulo"]').textContent === 'Terex AC 55' && s.selectedOptions[0]?.textContent.includes('Grúas Lezama') && m.querySelector('[name=num_flota]').value === 'GL-20' && m.querySelector('[name=horometro_ultimo]').value === '2450.5' && /Alta desde/.test(m.querySelector('[name=observaciones]').value) && /Manual/.test(m.querySelector('[data-ref="meta"]').textContent) && /O\\.T\\.\\s*0/.test(m.querySelector('[data-ref="meta"]').textContent.replace(/\\n/g, ' ')) && !m.querySelector('[data-ref="desactivar"]').classList.contains('oculto'); })()`));
  await captura(p, '06-editar-maquina');
  await escribir(p, '.modal [name=num_flota]', 'GL-21');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('editar: guardar → toast y fila actualizada', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /guardada/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('GL-21'))`));

  // Cambiar de cliente
  await clicFila(p, 'Terex AC 55');
  await esperarHasta(p, `document.querySelectorAll('.modal [data-ref="clientes"] option').length === 10`);
  await elegirOpcion(p, '.modal [data-ref="clientes"]', 'Ibaizabal');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('editar: cambiar el cliente propietario → fila ahora de Ibaizabal', await esperarHasta(p, `!document.querySelector('#modales .modal-fondo') && [...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Terex AC 55') && tr.textContent.includes('Ibaizabal'))`));

  // --- Baja lógica ------------------------------------------------------------------------
  await clicFila(p, 'Terex AC 55');
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="desactivar"]')`);
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  ok('desactivar: pide confirmación (modal elegir)', await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 2 && /Desactivar la máquina/.test(document.querySelectorAll('#modales .modal-fondo')[1].textContent)`));
  await captura(p, '07-confirmar-desactivar');
  await evaluar(p, `[...document.querySelectorAll('#modales .modal-fondo')[1].querySelectorAll('button')].find(b => /Sí, desactivar/.test(b.textContent)).click()`);
  ok('desactivar: toast y la fila desaparece de Activas', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /desactivada/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `![...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Terex AC 55'))`));
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  ok('Mostrar Todas: 28 filas, 4 tachadas al final (Kubota, Terex y 2 rápidas del arnés HTTP)', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; return trs.length === 28 && trs.slice(-4).every(t => t.classList.contains('inactivo') && /Desactivada/.test(t.textContent)) && trs.slice(0, -4).every(t => !t.classList.contains('inactivo')); })()`), `${await evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`)}/${await evaluar(p, `document.querySelectorAll('.tabla tbody tr.inactivo').length`)}`);
  await captura(p, '08-maquinas-todas');
  await clicFila(p, 'Terex AC 55');
  ok('reactivar: el botón dice Reactivar', await esperarHasta(p, `document.querySelector('.modal [data-ref="desactivar"]')?.textContent === 'Reactivar' && !document.querySelector('.modal [data-ref="desactivar"]').classList.contains('btn-peligro')`));
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  ok('reactivar: sin confirmación, toast y vuelve a Activa', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /reactivada/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes('Terex AC 55')); return tr && !tr.classList.contains('inactivo') && /Activa/.test(tr.textContent); })()`));
  ok('desktop: sin scroll horizontal', await evaluar(p, `document.documentElement.scrollWidth <= 1400`));

  // --- Desde la ficha del cliente ---------------------------------------------------------
  await evaluar(p, `location.hash = 'clientes'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 10`);
  await clicFila(p, 'Grúas Lezama');
  ok('ficha cliente: lista de máquinas (5: 2 de Karve, Liebherr manual y 2 desactivadas tachadas) con chips y botón "+ Máquina"', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const li = [...m.querySelectorAll('[data-ref="maquinas"] li')]; return li.length === 5 && li.filter(l => l.querySelector('.chip-naranja')).length === 2 && li.some(l => /Liebherr/.test(l.textContent)) && li.filter(l => l.classList.contains('inactivo') && /Desactivada/.test(l.textContent)).length === 2 && !m.querySelector('[data-ref="nueva-maquina"]').classList.contains('oculto'); })()`), `${await evaluar(p, `document.querySelectorAll('.modal [data-ref="maquinas"] li').length`)}`);
  await captura(p, '09-ficha-cliente-maquinas');
  await evaluar(p, `document.querySelector('.modal [data-ref="nueva-maquina"]').click()`);
  ok('ficha cliente: "+ Máquina" abre el alta encima con Grúas Lezama preseleccionado', await esperarHasta(p, `(() => { const ms = document.querySelectorAll('#modales .modal-fondo'); if (ms.length !== 2) return false; const m = ms[1]; const s = m.querySelector('[data-ref="clientes"]'); return m.querySelector('[data-ref="titulo"]').textContent === 'Nueva máquina' && s && s.selectedOptions[0]?.textContent.includes('Grúas Lezama'); })()`));
  await escribir(p, '#modales .modal-fondo:nth-child(2) [name=marca]', 'Manitou');
  await escribir(p, '#modales .modal-fondo:nth-child(2) [name=modelo]', 'MRT 2150');
  await captura(p, '10-alta-desde-ficha');
  await evaluar(p, `document.querySelectorAll('#modales .modal-fondo')[1].querySelector('[data-ref="form"]').requestSubmit()`);
  ok('ficha cliente: tras guardar, la ficha sigue abierta y la lista pasa a 6 máquinas', await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo:not(.cerrando)').length === 1 && document.querySelectorAll('.modal [data-ref="maquinas"] li').length === 6 && [...document.querySelectorAll('.modal [data-ref="maquinas"] li')].some(l => /Manitou MRT 2150/.test(l.textContent))`), `${await evaluar(p, `document.querySelectorAll('.modal [data-ref="maquinas"] li').length`)}`);
  await evaluar(p, `[...document.querySelectorAll('.modal [data-ref="maquinas"] li')].find(l => /Manitou/.test(l.textContent)).click()`);
  ok('ficha cliente: pulsar una máquina abre su ficha encima', await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 2 && document.querySelectorAll('#modales .modal-fondo')[1].querySelector('[data-ref="titulo"]').textContent === 'Manitou MRT 2150'`));
  await captura(p, '11-ficha-maquina-desde-cliente');
  await escape(p);
  ok('Escape cierra solo la ficha de la máquina', await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo:not(.cerrando)').length === 1`) && await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 1`));
  await escape(p);
  await sinModal(p);
  // Cliente desactivado: sin botón "+ Máquina"
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 12`);
  await clicFila(p, 'Txorierri');
  ok('ficha de cliente desactivado: sin botón "+ Máquina"', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="maquinas"]') && document.querySelector('.modal [data-ref="nueva-maquina"]').classList.contains('oculto')`));
  await escape(p);
  await sinModal(p);

  // --- Nueva O.T. sigue viendo las máquinas del cliente -----------------------------------
  await evaluar(p, `location.hash = 'kanban'`);
  await esperarHasta(p, `!!document.querySelector('[data-accion="nueva"]')`);
  await evaluar(p, `document.querySelector('[data-accion="nueva"]').click()`);
  await esperarHasta(p, `document.querySelectorAll('.modal [data-ref="clientes"] option').length === 10`);
  await elegirOpcion(p, '.modal [data-ref="clientes"]', 'Lezama');
  ok('Nueva O.T.: el selector de máquina de Grúas Lezama lista 4 (sin la Terex, que es de Ibaizabal)', await esperarHasta(p, `document.querySelectorAll('.modal [data-ref="maquinas"] option').length === 5`), `${await evaluar(p, `document.querySelectorAll('.modal [data-ref="maquinas"] option').length`)}`);
  await escape(p);
  await sinModal(p);

  // --- Técnico (tablet): sin pestaña ------------------------------------------------------
  await salir(p);
  await entrar(p, 'tecnico1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('técnico: sin pestaña Máquinas', !(await navTiene(p, 'Máquinas')));
  await evaluar(p, `location.hash = 'maquinas'`);
  await dormir(400);
  ok('técnico: #maquinas redirige a su vista por defecto', (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Mis O.T.');

  // --- Comercial: solo lectura ------------------------------------------------------------
  await salir(p);
  await entrar(p, 'comercial1', 'prueba123');
  ok('comercial: pestaña Máquinas', await esperarHasta(p, `[...document.querySelectorAll('#nav button')].some(b => b.textContent === 'Máquinas')`));
  await evaluar(p, `location.hash = 'maquinas'`);
  ok('comercial: lista sin botón Nueva', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 26`) && (await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').classList.contains('oculto')`)));
  await clicFila(p, 'Terex AC 55');
  ok('comercial: ficha en solo lectura (campos y selector deshabilitados, sin Guardar ni Desactivar)', await esperarHasta(p, `document.querySelector('.modal [name=marca]')?.disabled === true && document.querySelector('.modal [data-ref="clientes"]').disabled === true && document.querySelector('.modal [data-ref="guardar"]').classList.contains('oculto') && document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto')`));
  await captura(p, '12-comercial-solo-lectura');
  await escape(p);
  await sinModal(p);

  // --- Móvil ------------------------------------------------------------------------------
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
  await dormir(300);
  ok('móvil 420: sin scroll horizontal de página', await evaluar(p, `document.documentElement.scrollWidth <= 420`), `scrollWidth ${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '13-maquinas-movil');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
