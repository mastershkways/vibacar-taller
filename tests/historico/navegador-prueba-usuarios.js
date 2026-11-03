// Prueba del maestro de usuarios (F2-04) en Brave headless vía DevTools Protocol, sin dependencias.
// Servidor de prueba en 5055 con BD temporal (prueba-usuarios.db, tras cliente-prueba-usuarios.js). Capturas en ./capturas-usuarios/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-usuarios');
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
async function irAcceso(p) {
  await navegar(p, `${BASE}/`);
  if ((await evaluar(p, 'location.pathname')) !== '/acceso') { await salir(p); await navegar(p, `${BASE}/`); }
}
async function entrar(p, usuario, clave) {
  await irAcceso(p);
  const nav = p.esperarEvento('Page.loadEventFired');
  await evaluar(p, `(() => { document.getElementById('usuario').value = ${JSON.stringify(usuario)}; document.getElementById('clave').value = ${JSON.stringify(clave)}; document.getElementById('formulario').requestSubmit(); })()`);
  await nav;
  ok(`login ${usuario} → /`, (await evaluar(p, 'location.pathname')) === '/');
}
// Intento de login que debe fallar: la pantalla no navega y pinta el error.
async function entrarMal(p, usuario, clave) {
  await irAcceso(p);
  await evaluar(p, `(() => { document.getElementById('usuario').value = ${JSON.stringify(usuario)}; document.getElementById('clave').value = ${JSON.stringify(clave)}; document.getElementById('formulario').requestSubmit(); })()`);
  const conError = await esperarHasta(p, `document.getElementById('error') && document.getElementById('error').textContent.trim().length > 0`, 5000);
  return { conError, ruta: await evaluar(p, 'location.pathname'), texto: await evaluar(p, `document.getElementById('error')?.textContent || ''`) };
}
const navTiene = (p, texto) => evaluar(p, `[...document.querySelectorAll('#nav button')].some(b => b.textContent === ${JSON.stringify(texto)})`);
const escribir = (p, sel, valor) => evaluar(p, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(valor)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
const elegirOpcion = (p, sel, valor) => evaluar(p, `(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(valor)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value === ${JSON.stringify(valor)}; })()`);
const clicFila = (p, texto) => evaluar(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes(${JSON.stringify(texto)})); if (!tr) return false; tr.click(); return true; })()`);
const escape = async (p) => { await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2500);
const nFilas = (p) => evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`);
const chips = (p, texto) => evaluar(p, `[...document.querySelectorAll('.tabla tbody .chip')].filter(c => c.textContent === ${JSON.stringify(texto)}).length`);

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // --- Admin: vista Usuarios ---------------------------------------------------------------
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  ok('admin: pestaña Usuarios en el menú, la última, tras Máquinas', await esperarHasta(p, `(() => { const n = [...document.querySelectorAll('#nav button')].map(b => b.textContent); return n.indexOf('Usuarios') === n.length - 1 && n.indexOf('Usuarios') === n.indexOf('Máquinas') + 1; })()`));
  await evaluar(p, `location.hash = 'usuarios'`);
  ok('usuarios: 7 filas activas, buscador, botón Nuevo y contador', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 7 && !!document.querySelector('[name=q]') && !!document.querySelector('[data-accion="nuevo-usuario"]') && document.querySelector('[data-ref="contador"]').textContent === '7 usuarios'`), `filas ${await nFilas(p)}`);
  ok('usuarios: chips de rol 2 Técnico interno, 1 SAT externo, 4 Oficina (con el nombre del rol al lado) y 7 Activo',
    (await chips(p, 'Técnico interno')) === 2 && (await chips(p, 'SAT externo')) === 1 && (await chips(p, 'Oficina')) === 4 && (await chips(p, 'Activo')) === 7
    && (await evaluar(p, `[...document.querySelectorAll('.tabla tbody .rol-nombre')].map(e => e.textContent)`)).includes('Financiero / Administración'),
    `${await chips(p, 'Técnico interno')}/${await chips(p, 'SAT externo')}/${await chips(p, 'Oficina')}`);
  ok('usuarios: la fila del propio admin lleva el chip "tú" y tecnico1 muestra OP012', await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('admin_prueba') && tr.textContent.includes('tú')) && [...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('tecnico1') && tr.textContent.includes('OP012'))`));
  await captura(p, '01-usuarios-lista');

  // --- Búsqueda ---------------------------------------------------------------------------
  await escribir(p, '[name=q]', 'mikel');
  ok('buscar "mikel" → 1 fila (sin pulsar Enter)', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && document.querySelector('.tabla tbody tr').textContent.includes('tecnico1')`), `${await nFilas(p)}`);
  await escribir(p, '[name=q]', 'OP0');
  ok('buscar "OP0" (código Karve) → 3 filas', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 3`), `${await nFilas(p)}`);
  await escribir(p, '[name=q]', 'zzzz');
  ok('buscar sin resultados → "Sin resultados"', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 1 && /Sin resultados/.test(document.querySelector('.tabla tbody').textContent)`));
  await escribir(p, '[name=q]', '');
  ok('buscar vacío → 7 activos', await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 7`));

  // --- Alta -------------------------------------------------------------------------------
  await evaluar(p, `document.querySelector('[data-accion="nuevo-usuario"]').click()`);
  ok('nuevo: modal con aviso Karve (Fase 5), título "Nuevo usuario" y foco en el login', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="form"]') && /Fase 5/.test(document.querySelector('.modal .aviso-info')?.textContent) && document.querySelector('.modal [data-ref="titulo"]').textContent === 'Nuevo usuario' && document.activeElement === document.querySelector('.modal [name=usuario]')`));
  ok('nuevo: selector con los 6 roles (Técnico por defecto), contraseña obligatoria, sin Desactivar ni metadatos', await evaluar(p, `document.querySelectorAll('.modal [data-ref="roles"] option').length === 6 && document.querySelector('.modal [data-ref="roles"]').value === 'tecnico' && document.querySelector('.modal [name=clave]').required === true && document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto') && document.querySelector('.modal [data-ref="meta"]').classList.contains('oculto')`));
  await escribir(p, '.modal [name=usuario]', 'tecnico9');
  await escribir(p, '.modal [name=nombre]', 'Prueba Headless');
  await escribir(p, '.modal [name=email]', 'prueba9@vibacar-pruebas.local');
  await escribir(p, '.modal [name=karve_id]', 'OP099');
  await escribir(p, '.modal [name=clave]', 'secreta-9');
  await captura(p, '02-nuevo-usuario');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nuevo: guardar → toast "creado" y modal cerrado', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /creado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p));
  ok('nuevo: fila con tecnico9, chip Técnico interno, OP099 y Activo; contador 8', await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('tecnico9') && tr.textContent.includes('Prueba Headless') && tr.textContent.includes('OP099') && [...tr.querySelectorAll('.chip')].some(c => c.textContent === 'Técnico interno') && [...tr.querySelectorAll('.chip')].some(c => c.textContent === 'Activo')) && document.querySelector('[data-ref="contador"]').textContent === '8 usuarios'`));
  await captura(p, '03-usuario-creado');

  // --- 409 por login repetido ---------------------------------------------------------------
  await evaluar(p, `document.querySelector('[data-accion="nuevo-usuario"]').click()`);
  await esperarHasta(p, `!!document.querySelector('.modal [name=usuario]')`);
  await escribir(p, '.modal [name=usuario]', 'TECNICO9');
  await escribir(p, '.modal [name=nombre]', 'Otro');
  await escribir(p, '.modal [name=clave]', 'otra-clave');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nuevo: login repetido → aviso de conflicto (409) en el modal con el nombre del otro usuario, modal abierto', await esperarHasta(p, `!!document.querySelector('.modal .aviso-conflicto') && /TECNICO9/.test(document.querySelector('.modal .aviso-conflicto').textContent) && /Prueba Headless/.test(document.querySelector('.modal .aviso-conflicto').textContent)`));
  await captura(p, '04-login-repetido-409');
  await escape(p);
  ok('nuevo: Escape cierra', await sinModal(p));

  // --- Edición ----------------------------------------------------------------------------
  await clicFila(p, 'Prueba Headless');
  ok('editar: título, campos cargados, contraseña vacía con etiqueta "Nueva contraseña", metadatos (O.T. 0, último acceso nunca) y Desactivar', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; return m.querySelector('[data-ref="titulo"]').textContent === 'Prueba Headless' && m.querySelector('[name=usuario]').value === 'tecnico9' && m.querySelector('[name=karve_id]').value === 'OP099' && m.querySelector('[data-ref="roles"]').value === 'tecnico' && m.querySelector('[name=clave]').value === '' && m.querySelector('[name=clave]').required === false && /Nueva contraseña/.test(m.querySelector('[data-ref="etiqueta-clave"]').textContent) && /O\\.T\\. asignadas\\s*0/.test(m.querySelector('[data-ref="meta"]').textContent.replace(/\\n/g, ' ')) && /nunca/.test(m.querySelector('[data-ref="meta"]').textContent) && !m.querySelector('[data-ref="desactivar"]').classList.contains('oculto'); })()`));
  await captura(p, '05-editar-usuario');
  await escribir(p, '.modal [name=nombre]', 'Prueba Headless 2');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('editar: guardar sin contraseña → toast "guardado" (sin "contraseña") y fila actualizada', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /guardado/.test(document.querySelector('.toast-ok').textContent) && !/contraseña/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Prueba Headless 2'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await clicFila(p, 'Prueba Headless 2');
  await esperarHasta(p, `!!document.querySelector('.modal [name=clave]')`);
  await escribir(p, '.modal [name=clave]', 'cambiada-9');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('editar: con contraseña nueva → toast "contraseña cambiada"', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /contraseña cambiada/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await clicFila(p, 'Prueba Headless 2');
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="roles"]')`);
  await elegirOpcion(p, '.modal [data-ref="roles"]', 'sat');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('editar: cambiar el rol a SAT → chip SAT externo en la fila', await esperarHasta(p, `!document.querySelector('#modales .modal-fondo') && [...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('tecnico9') && [...tr.querySelectorAll('.chip')].some(c => c.textContent === 'SAT externo'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);

  // --- Baja lógica ------------------------------------------------------------------------
  await clicFila(p, 'Prueba Headless 2');
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="desactivar"]')`);
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  ok('desactivar: pide confirmación (modal elegir)', await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 2 && /Desactivar a "Prueba Headless 2"/.test(document.querySelectorAll('#modales .modal-fondo')[1].textContent)`));
  await captura(p, '06-confirmar-desactivar');
  await evaluar(p, `[...document.querySelectorAll('#modales .modal-fondo')[1].querySelectorAll('button')].find(b => /Sí, desactivar/.test(b.textContent)).click()`);
  ok('desactivar: toast y la fila desaparece de Activos (7)', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /desactivado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 7 && ![...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('tecnico9'))`));
  await evaluar(p, `(() => { const s = document.querySelector('[name=todos]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  ok('Mostrar Todos: 10 filas, 3 tachadas al final (tecnico3 del seed, prueba.http2 del arnés HTTP y tecnico9)', await esperarHasta(p, `(() => { const trs = [...document.querySelectorAll('.tabla tbody tr')]; return trs.length === 10 && trs.slice(-3).every(t => t.classList.contains('inactivo') && /Desactivado/.test(t.textContent)) && trs.slice(0, -3).every(t => !t.classList.contains('inactivo')); })()`), `${await nFilas(p)}/${await evaluar(p, `document.querySelectorAll('.tabla tbody tr.inactivo').length`)}`);
  await captura(p, '07-usuarios-todos');
  await clicFila(p, 'Prueba Headless 2');
  ok('reactivar: el botón dice Reactivar y la ficha marca "desactivado"', await esperarHasta(p, `document.querySelector('.modal [data-ref="desactivar"]')?.textContent === 'Reactivar' && !document.querySelector('.modal [data-ref="desactivar"]').classList.contains('btn-peligro') && /desactivado/.test(document.querySelector('.modal [data-ref="meta"]').textContent)`));
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  ok('reactivar: sin confirmación, toast y vuelve a Activo', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /reactivado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes('tecnico9')); return tr && !tr.classList.contains('inactivo') && /Activo/.test(tr.textContent); })()`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);

  // --- El propio administrador --------------------------------------------------------------
  await clicFila(p, 'admin_prueba');
  ok('mi usuario: sin botón Desactivar y selector de rol deshabilitado', await esperarHasta(p, `!!document.querySelector('.modal [data-ref="form"]') && document.querySelector('.modal [data-ref="desactivar"]').classList.contains('oculto') && document.querySelector('.modal [data-ref="roles"]').disabled === true`));
  await escribir(p, '.modal [name=nombre]', 'Administrador de pruebas');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('mi usuario: guardar el nombre → toast y la cabecera cambia', await esperarHasta(p, `!!document.querySelector('.toast-ok') && document.querySelector('#usuario-nombre').textContent === 'Administrador de pruebas'`) && await sinModal(p));
  ok('desktop: sin scroll horizontal', await evaluar(p, `document.documentElement.scrollWidth <= 1400`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);

  // --- Caché de técnicos (selector de Asignación del detalle de O.T.) renovada tras tocar usuarios ---
  ok('tras guardar/reactivar usuarios la caché de técnicos se vacía y al recargarla incluye al reactivado (rol sat)', (await evaluar(p, `S.tecnicos === null`)) && (await evaluar(p, `cargarTecnicos().then(t => t.some(x => /Prueba Headless 2/.test(x.nombre) && x.rol === 'sat'))`)));

  // --- El nuevo usuario entra con la contraseña cambiada ---------------------------------------
  await salir(p);
  await entrar(p, 'tecnico9', 'cambiada-9');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('tecnico9: entra con la contraseña cambiada desde la pantalla, ve Mis O.T. y no tiene pestaña Usuarios', (await navTiene(p, 'Mis O.T.')) && !(await navTiene(p, 'Usuarios')));
  await evaluar(p, `location.hash = 'usuarios'`);
  await dormir(400);
  ok('tecnico9: #usuarios redirige a su vista por defecto', (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Mis O.T.');

  // --- Baja desde la pantalla y login rechazado -------------------------------------------------
  await salir(p);
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await evaluar(p, `location.hash = 'usuarios'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 8`);
  await clicFila(p, 'Prueba Headless 2');
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="desactivar"]')`);
  await evaluar(p, `document.querySelector('.modal [data-ref="desactivar"]').click()`);
  await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 2`);
  await evaluar(p, `[...document.querySelectorAll('#modales .modal-fondo')[1].querySelectorAll('button')].find(b => /Sí, desactivar/.test(b.textContent)).click()`);
  ok('admin desactiva a tecnico9 desde la pantalla', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /desactivado/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p));
  await salir(p);
  const intento = await entrarMal(p, 'tecnico9', 'cambiada-9');
  ok('tecnico9 desactivado: el login con contraseña correcta se rechaza y se queda en /acceso con error', intento.conError && intento.ruta === '/acceso', `${intento.ruta} "${intento.texto}"`);
  await captura(p, '08-login-rechazado');

  // --- Financiero: sin pestaña ------------------------------------------------------------------
  await entrar(p, 'finanzas1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav button').length >= 1`);
  ok('financiero: sin pestaña Usuarios', !(await navTiene(p, 'Usuarios')));
  await evaluar(p, `location.hash = 'usuarios'`);
  await dormir(400);
  ok('financiero: #usuarios redirige a su vista por defecto (Listado)', (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Listado');

  // --- Móvil ------------------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await evaluar(p, `location.hash = 'usuarios'`);
  await esperarHasta(p, `document.querySelectorAll('.tabla tbody tr').length === 7`);
  await p.enviar('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: true });
  await dormir(300);
  ok('móvil 420: sin scroll horizontal de página', await evaluar(p, `document.documentElement.scrollWidth <= 420`), `scrollWidth ${await evaluar(p, 'document.documentElement.scrollWidth')}`);
  await captura(p, '09-usuarios-movil');
  await clicFila(p, 'tecnico1');
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="form"]')`);
  await dormir(300);
  await captura(p, '10-usuario-movil');
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
