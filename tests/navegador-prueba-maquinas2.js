// Prueba de Máquinas v2 (F3-04) y Roles v2 (F3-05) en Brave headless vía CDP. Servidor en 5055 con prueba-maquinas2.db
// (tras cliente-prueba-maquinas2.js). Capturas en ./capturas-maquinas2/.
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-maquinas2');
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
const elegir = (p, sel, valor) => evaluar(p, `(() => { const s = document.querySelector(${JSON.stringify(sel)}); s.value = ${JSON.stringify(valor)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
const clicFila = (p, texto) => evaluar(p, `(() => { const tr = [...document.querySelectorAll('.tabla tbody tr')].find(t => t.textContent.includes(${JSON.stringify(texto)})); if (!tr) return false; tr.click(); return true; })()`);
const escape = async (p) => { await p.enviar('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
const sinModal = (p) => esperarHasta(p, `!document.querySelector('#modales .modal-fondo')`, 2500);
const nFilas = (p) => evaluar(p, `document.querySelectorAll('.tabla tbody tr').length`);
const cabeceras = (p) => evaluar(p, `[...document.querySelectorAll('.tabla thead th')].map(th => th.textContent)`);
const dis = (p, sel) => evaluar(p, `document.querySelector(${JSON.stringify(sel)}).disabled`);
const irMaquinas = async (p) => { await evaluar(p, `location.hash = 'maquinas'`); await esperarHasta(p, `location.hash === '#maquinas' && document.querySelectorAll('.tabla tbody tr').length > 5`); };

(async () => {
  fs.mkdirSync(CAPTURAS, { recursive: true });
  const p = await abrirPestana();

  // --- Administrativo ------------------------------------------------------------------------------------
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  ok('administrativo: cabecera "Administrativo", Tablero por defecto y pestaña Usuarios', (await evaluar(p, `document.querySelector('#usuario-rol').textContent`)) === 'Administrativo' && (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Tablero' && (await textosNav(p)).includes('Usuarios'));
  await irMaquinas(p);
  const cab = await cabeceras(p);
  ok('máquinas: columnas Máquina · Bastidor · Nº flota · Cliente · Estado · Horas, con estados y contratos pintados', JSON.stringify(cab) === JSON.stringify(['Máquina', 'Bastidor', 'Nº flota', 'Cliente', 'Estado', 'Horas']) && (await evaluar(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Rent to Rent') && tr.textContent.includes('RR-2025-014')) && [...document.querySelectorAll('.tabla tbody tr')].some(tr => /F-\\d{2}-0001/.test(tr.textContent))`)), JSON.stringify(cab));
  await captura(p, '01-maquinas-tabla');
  await clicFila(p, 'Liebherr');
  ok('ficha existente: marca/modelo/bastidor/flota/estado/contrato/características y cliente bloqueados; horas y observaciones libres; aviso de bloqueo; botón "Editar campos bloqueados" (administrativo)', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; const d = (n) => m.querySelector('[name=' + n + ']').disabled; return d('marca') && d('modelo') && d('bastidor') && d('estado') && d('caracteristicas') && m.querySelector('[name=num_flota]').readOnly && m.querySelector('[data-ref="clientes"]').disabled && !d('horometro_ultimo') && !d('observaciones') && !m.querySelector('[data-ref="aviso-bloqueo"]').classList.contains('oculto') && !m.querySelector('[data-ref="desbloquear"]').classList.contains('oculto'); })()`));
  ok('ficha existente: metadatos con Estado y contrato; características cargadas', await evaluar(p, `/Subalquilada/.test(document.querySelector('.modal [data-ref="meta"]').textContent) && /SUB-2026-003/.test(document.querySelector('.modal [data-ref="meta"]').textContent) && /Grúa 50 t/.test(document.querySelector('.modal [name=caracteristicas]').value)`));
  await captura(p, '02-ficha-bloqueada');
  await escribir(p, '.modal [name=horometro_ultimo]', '9001');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('ficha existente: guardar horas → toast y fila con 9001 h', await esperarHasta(p, `!!document.querySelector('.toast-ok')`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('Liebherr') && /9\\.?001 h/.test(tr.textContent))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await clicFila(p, 'Liebherr');
  await esperarHasta(p, `!!document.querySelector('.modal [data-ref="desbloquear"]')`);
  await evaluar(p, `document.querySelector('.modal [data-ref="desbloquear"]').click()`);
  ok('administrativo: "Editar campos bloqueados" desbloquea marca, estado, cliente… y avisa de modo corrección', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); return !m.querySelector('[name=marca]').disabled && !m.querySelector('[name=estado]').disabled && !m.querySelector('[data-ref="clientes"]').disabled && !m.querySelector('[name=num_flota]').readOnly && m.querySelector('[data-ref="desbloquear"]').classList.contains('oculto') && /Modo corrección/.test(m.querySelector('[data-ref="avisos"]').textContent); })()`));
  await captura(p, '03-ficha-desbloqueada');
  await escribir(p, '.modal [name=modelo]', 'LTM 1050-3.1');
  await elegir(p, '.modal [name=estado]', 'cliente_final');
  ok('estado → cliente final: el nº de contrato se deshabilita y se vacía', await evaluar(p, `document.querySelector('.modal [name=num_contrato]').disabled && document.querySelector('.modal [name=num_contrato]').value === ''`));
  await elegir(p, '.modal [name=estado]', 'propia');
  await escribir(p, '.modal [name=num_contrato]', 'AL-2026-777');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('administrativo: corrección guardada (modelo, estado Propia y contrato en la fila)', await esperarHasta(p, `!!document.querySelector('.toast-ok')`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('LTM 1050-3.1') && tr.textContent.includes('Propia') && tr.textContent.includes('AL-2026-777'))`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);

  // Alta con nº de flota automático
  await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').click()`);
  ok('nueva: todo editable, nº de flota de solo lectura con aviso "Se asigna al guardar", estado Cliente final y contrato deshabilitado, sin aviso de bloqueo', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; return !m.querySelector('[name=marca]').disabled && m.querySelector('[name=num_flota]').readOnly && /Se asigna/.test(m.querySelector('[name=num_flota]').placeholder) && m.querySelector('[name=estado]').value === 'cliente_final' && m.querySelector('[name=num_contrato]').disabled && m.querySelector('[data-ref="aviso-bloqueo"]').classList.contains('oculto') && m.querySelector('[data-ref="desbloquear"]').classList.contains('oculto'); })()`));
  await evaluar(p, `(() => { const s = document.querySelector('.modal [data-ref="clientes"]'); const o = [...s.options].find(o => /Lezama/.test(o.textContent)); s.value = o.value; s.dispatchEvent(new Event('change')); })()`);
  await escribir(p, '.modal [name=marca]', 'Manitou');
  await escribir(p, '.modal [name=modelo]', 'MRT 2150');
  await elegir(p, '.modal [name=estado]', 'rent_to_rent');
  ok('nueva: con Rent to Rent el contrato se habilita', !(await dis(p, '.modal [name=num_contrato]')));
  await escribir(p, '.modal [name=num_contrato]', 'RR-2026-500');
  await escribir(p, '.modal [name=caracteristicas]', 'Telescópica 21 m, 5 t');
  await captura(p, '04-nueva-maquina');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('nueva: toast con el nº de flota asignado y fila con F-YY-XXXX, Rent to Rent y contrato', await esperarHasta(p, `!!document.querySelector('.toast-ok') && /nº de flota F-\\d{2}-\\d{4}/.test(document.querySelector('.toast-ok').textContent)`) && await sinModal(p) && await esperarHasta(p, `[...document.querySelectorAll('.tabla tbody tr')].some(tr => tr.textContent.includes('MRT 2150') && /F-\\d{2}-\\d{4}/.test(tr.textContent) && tr.textContent.includes('Rent to Rent') && tr.textContent.includes('RR-2026-500'))`), await evaluar(p, `document.querySelector('.toast-ok')?.textContent || ''`));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);

  // --- Responsable ST: sin Usuarios, sin desbloqueo -------------------------------------------------------
  await salir(p);
  await entrar(p, 'responsable1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  ok('responsable_st: cabecera, Tablero por defecto, Maestros sí y Usuarios no', (await evaluar(p, `document.querySelector('#usuario-rol').textContent`)) === 'Responsable de Servicio Técnico' && (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Tablero' && JSON.stringify(await textosNav(p)) === JSON.stringify(['Tablero', 'Listado', 'Maestros']), (await textosNav(p)).join(' · '));
  await irMaquinas(p);
  await clicFila(p, 'MRT 2150');
  ok('responsable_st: ficha bloqueada sin botón "Editar campos bloqueados"; horas editables; Desactivar visible', await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); if (!m) return false; return m.querySelector('[name=marca]').disabled && !m.querySelector('[name=horometro_ultimo]').disabled && m.querySelector('[data-ref="desbloquear"]').classList.contains('oculto') && !m.querySelector('[data-ref="desactivar"]').classList.contains('oculto'); })()`));
  await captura(p, '05-responsable-ficha');
  await escribir(p, '.modal [name=observaciones]', 'Entregada en obra');
  await evaluar(p, `document.querySelector('.modal [data-ref="form"]').requestSubmit()`);
  ok('responsable_st: guardar observaciones → 200 (solo manda horas y observaciones)', await esperarHasta(p, `!!document.querySelector('.toast-ok')`) && await sinModal(p));
  await esperarHasta(p, `!document.querySelector('.toast-ok')`, 6000);
  await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').click()`);
  ok('responsable_st: puede dar de alta máquinas (botón y modal)', await esperarHasta(p, `!!document.querySelector('.modal [name=marca]') && !document.querySelector('.modal [name=marca]').disabled`));
  await escape(p);
  await sinModal(p);

  // --- Gerencia: solo lectura ---------------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'gerencia1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('#nav .menu').length === 1`);
  ok('gerencia: Tablero por defecto, sin botón "+ Nueva O.T.", Maestros sí, Usuarios no', (await evaluar(p, `document.querySelector('#nav button.activo')?.textContent`)) === 'Tablero' && (await evaluar(p, `document.querySelector('[data-accion="nueva"]')?.classList.contains('oculto')`)) === true && !(await textosNav(p)).includes('Usuarios'));
  await captura(p, '06-gerencia-tablero');
  await irMaquinas(p);
  ok('gerencia: máquinas sin botón Nueva y ficha en solo lectura', (await evaluar(p, `document.querySelector('[data-accion="nueva-maquina"]').classList.contains('oculto')`)) && (await clicFila(p, 'MRT 2150')) && await esperarHasta(p, `(() => { const m = document.querySelector('.modal'); return !!m && m.querySelector('[name=horometro_ultimo]').disabled && m.querySelector('[data-ref="guardar"]').classList.contains('oculto') && m.querySelector('[data-ref="desbloquear"]').classList.contains('oculto') && m.querySelector('[data-ref="aviso-bloqueo"]').classList.contains('oculto'); })()`));
  await escape(p);
  await sinModal(p);

  // --- Gestor de SAT: Tablero solo con O.T. de SAT o sin técnico ------------------------------------------
  await salir(p);
  await entrar(p, 'gestorsat1', 'prueba123');
  await esperarHasta(p, `document.querySelectorAll('.tarjeta').length > 0`);
  const tarjetas = await evaluar(p, `[...document.querySelectorAll('.tarjeta')].map(t => t.textContent)`);
  ok(`gestor_sat: Tablero con ${tarjetas.length} tarjetas, ninguna de un técnico interno (Mikel/Ane)`, tarjetas.length > 0 && tarjetas.length < 18 && !tarjetas.some((t) => /Mikel Etxeberria|Ane Zubiaurre/.test(t)), `${tarjetas.length}`);
  ok('gestor_sat: cabecera "Gestor de SAT externos", sin Usuarios', (await evaluar(p, `document.querySelector('#usuario-rol').textContent`)) === 'Gestor de SAT externos' && !(await textosNav(p)).includes('Usuarios'));
  await captura(p, '07-gestor-sat-tablero');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
