// Prueba del Planificador (F4-02 + F4-03) en Brave headless vía CDP: home por rol, vista Día (columnas por técnico, bloques,
// bandeja), arrastrar de la bandeja al calendario (mini-modal), mover un bloque, aviso de solape, quitar, vista Semana, solo
// lectura de gerencia y botón "Planificar" del detalle. El arrastre se simula con DragEvent sintéticos.
// Servidor en 5055 con la BD del seed (ciclo planificadornav).
const fs = require('fs');
const path = require('path');
const BASE = 'http://localhost:5055';
const CDP = 'http://127.0.0.1:9333';
const CAPTURAS = path.join(__dirname, 'capturas-planificador');
fs.mkdirSync(CAPTURAS, { recursive: true });
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
  await enviar('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
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
const sinToasts = (p) => esperarHasta(p, `!document.querySelector('.toast')`, 9000);

// Estado de la vista Día: por técnico, sus bloques (hora y nº) y los avisos de la cabecera.
const dia = (p) => evaluar(p, `[...document.querySelectorAll('.plan-cab')].map(c => ({ id: c.dataset.tecnico, nombre: c.querySelector('b').textContent, carga: c.querySelector('.plan-carga').textContent.trim(), avisos: [...c.querySelectorAll('.chip-aviso')].map(a => a.dataset.aviso), bloques: [...document.querySelectorAll('.plan-col[data-tecnico="' + c.dataset.tecnico + '"] .bloque')].map(b => ({ id: b.dataset.bloque, hora: b.querySelector('.b-hora').textContent, num: b.querySelector('.b-num').textContent.trim().split(' ')[0], aviso: b.classList.contains('con-aviso'), arrastrable: b.draggable })) }))`);
const nBandeja = (p) => evaluar(p, `document.querySelector('[data-ref=n-bandeja]').textContent`);
// Arrastre sintético: dragstart en el origen, dragover + drop en el destino a la altura de `hora` (vista Día) o en el centro (celda).
const arrastrar = (p, selOrigen, selDestino, hora = null) => evaluar(p, `(() => {
  const origen = ${selOrigen};
  const destino = ${selDestino};
  if (!origen || !destino) return 'falta ' + (!origen ? 'origen' : 'destino');
  const dt = new DataTransfer();
  origen.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const r = destino.getBoundingClientRect();
  const y = ${hora === null ? 'r.top + r.height / 2' : `r.top + ((${hora} * 60 - S.plan.vIni) / 60) * PX_HORA`};
  const ev = { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: y, dataTransfer: dt };
  destino.dispatchEvent(new DragEvent('dragover', ev));
  const sombra = !!document.querySelector('.plan-sombra') || destino.classList.contains('soltar-aqui');
  destino.dispatchEvent(new DragEvent('drop', ev));
  origen.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
  return sombra ? 'ok' : 'sin sombra';
})()`);
const tarjetaBandeja = (texto) => `[...document.querySelectorAll('.tarjeta-bandeja')].find(c => c.textContent.includes(${JSON.stringify(texto)}))`;
const columna = (id) => `document.querySelector('.plan-col[data-tecnico="${id}"]')`;
const bloque = (num) => `[...document.querySelectorAll('.bloque')].find(b => b.querySelector('.b-num').textContent.includes(${JSON.stringify(num)}))`;

(async () => {
  const p = await abrirPestana();

  // --- Responsable: home Planificador, vista Día --------------------------------------------------------------------------
  await entrar(p, 'responsable1', 'prueba123');
  ok('responsable_st: entra en el Planificador (primera pestaña)', await esperarHasta(p, `document.querySelector('#nav button.activo')?.textContent === 'Planificador' && document.querySelectorAll('.plan-col').length === 3`));
  let d = await dia(p);
  ok('vista Día: una columna por técnico (Ane, Mikel, SAT), un bloque del seed en cada una a las 08:00 y carga "2 h / 8 h"', d.map((t) => t.nombre).join('|') === 'Ane Zubiaurre|Mikel Etxeberria|SAT Bizkaia (ext.)' && d.every((t) => t.bloques.length === 1 && /^08:00–10:00 · 2 h/.test(t.bloques[0].hora) && /^2 h \/ 8 h/.test(t.carga) && t.avisos.length === 0), JSON.stringify(d.map((t) => [t.carga, t.bloques.length])));
  ok('cabecera: "3 bloques · 6 h", botón Día activo y la fecha de hoy', /^3 bloques · 6 h$/.test(await evaluar(p, `document.querySelector('[data-ref=contador]').textContent`)) && (await evaluar(p, `document.querySelector('[data-modo=dia]').classList.contains('activo') && document.querySelector('[data-ref=fecha]').value === hoyISO()`)), await evaluar(p, `document.querySelector('[data-ref=contador]').textContent`));
  ok('bandeja: 6 O.T. sin planificar, arrastrables, urgentes arriba', (await nBandeja(p)) === '6' && (await evaluar(p, `(() => { const c = [...document.querySelectorAll('.tarjeta-bandeja')]; return c.length === 6 && c.every(x => x.draggable) && c[0].classList.contains('urgente'); })()`)));
  await captura(p, '01-dia');
  const [ane, mikel] = d;

  // Arrastrar "Garaio" de la bandeja a la columna de Mikel a las 11:00 → mini-modal → Planificar
  const numGaraio = await evaluar(p, `${tarjetaBandeja('Garaio')}.querySelector('.num').textContent.trim().split(' ')[0]`);
  const r1 = await arrastrar(p, tarjetaBandeja('Garaio'), columna(mikel.id), 11);
  ok('arrastrar de la bandeja a la columna: sombra con la hora y mini-modal "Planificar" con técnico, día, 11:00 y 2 h', r1 === 'ok' && await esperarHasta(p, `(() => { const m = document.querySelector('#modales .modal'); if (!m) return false; const f = m.querySelector('form'); return /^Planificar ${numGaraio}$/.test(m.querySelector('h2').textContent) && f.elements.tecnico_id.value === '${mikel.id}' && f.elements.dia.value === hoyISO() && f.elements.hora_inicio.value === '11:00' && f.elements.duracion_min.value === '120'; })()`), r1);
  await captura(p, '02-modal-planificar');
  await evaluar(p, `(() => { const f = document.querySelector('#modales .modal form'); f.elements.nota.value = 'Llevar comprobador de baterías'; f.requestSubmit(); })()`);
  ok('planificada: el bloque aparece en la columna de Mikel (11:00–13:00) y la bandeja baja a 5', await esperarHasta(p, `!!(${bloque(numGaraio)}) && document.querySelector('[data-ref=n-bandeja]').textContent === '5'`) && await sinModal(p));
  d = await dia(p);
  ok('…Mikel con 2 bloques y carga "4 h / 8 h"; contador "4 bloques · 8 h"', d[1].bloques.length === 2 && /^4 h \/ 8 h/.test(d[1].carga) && d[1].bloques.some((b) => b.num === numGaraio && /^11:00–13:00/.test(b.hora)) && /^4 bloques · 8 h$/.test(await evaluar(p, `document.querySelector('[data-ref=contador]').textContent`)), JSON.stringify(d[1]));

  // Mover el bloque a la columna de Ane a las 14:00 (sin modal)
  const r2 = await arrastrar(p, bloque(numGaraio), columna(ane.id), 14);
  ok('mover el bloque a otro técnico y hora (sin modal): pasa a Ane a las 14:00', r2 === 'ok' && await esperarHasta(p, `(() => { const b = ${bloque(numGaraio)}; return !!b && b.closest('.plan-col').dataset.tecnico === '${ane.id}' && /^14:00–16:00/.test(b.querySelector('.b-hora').textContent); })()`), r2);
  // Solaparlo con el del seed (08:00–10:00) → aviso
  await arrastrar(p, bloque(numGaraio), columna(ane.id), 9);
  ok('solape: aviso ⚠ en la cabecera de Ane, los dos bloques marcados y repartidos en dos carriles', await esperarHasta(p, `(() => { const cab = document.querySelector('.plan-cab[data-tecnico="${ane.id}"]'); const bs = [...document.querySelectorAll('.plan-col[data-tecnico="${ane.id}"] .bloque')]; return !!cab.querySelector('.chip-aviso[data-aviso=solape]') && bs.length === 2 && bs.every(b => b.classList.contains('con-aviso')) && bs[0].style.left !== bs[1].style.left; })()`));
  await sinToasts(p);
  await captura(p, '03-solape');

  // Abrir el bloque → Quitar → confirmar
  await evaluar(p, `${bloque(numGaraio)}.click()`);
  ok('clic en el bloque: modal "Bloque de …" con Quitar y "+ Otro bloque"', await esperarHasta(p, `(() => { const m = document.querySelector('#modales .modal'); return !!m && /^Bloque de ${numGaraio}$/.test(m.querySelector('h2').textContent) && !m.querySelector('[data-ref=quitar]').classList.contains('oculto') && !m.querySelector('[data-ref=partir]').classList.contains('oculto') && m.querySelector('form').elements.nota.value === 'Llevar comprobador de baterías'; })()`));
  await evaluar(p, `document.querySelector('#modales .modal [data-ref=quitar]').click()`);
  await esperarHasta(p, `document.querySelectorAll('#modales .modal-fondo').length === 2`);
  await evaluar(p, `[...document.querySelectorAll('#modales .modal-fondo')].at(-1).querySelector('[data-ref=opciones] button').click()`);
  ok('quitar: el bloque desaparece, la O.T. vuelve a la bandeja (6) y Ane se queda sin avisos', await esperarHasta(p, `!(${bloque(numGaraio)}) && document.querySelector('[data-ref=n-bandeja]').textContent === '6' && !document.querySelector('.plan-cab[data-tecnico="${ane.id}"] .chip-aviso')`) && await sinModal(p));

  // --- Vista Semana ------------------------------------------------------------------------------------------------------
  await evaluar(p, `document.querySelector('[data-modo=semana]').click()`);
  ok('vista Semana: tabla con 7 días (hoy resaltado), una fila por técnico y bloques compactos', await esperarHasta(p, `(() => { const t = document.querySelector('.plan-semana'); return !!t && t.querySelectorAll('thead th[data-dia]').length === 7 && t.querySelectorAll('thead th.hoy').length === 1 && t.querySelectorAll('tbody tr').length === 3 && t.querySelectorAll('.bloque.compacto').length >= 3; })()`));
  const celdaAneHoy = `document.querySelector('.plan-celda[data-tecnico="${ane.id}"][data-dia="' + hoyISO() + '"]')`;
  const r3 = await arrastrar(p, tarjetaBandeja('Garaio'), celdaAneHoy);
  ok('Semana: soltar en una celda abre el mini-modal con ese técnico, ese día y el siguiente hueco (10:00)', r3 === 'ok' && await esperarHasta(p, `(() => { const m = document.querySelector('#modales .modal'); if (!m) return false; const f = m.querySelector('form'); return f.elements.tecnico_id.value === '${ane.id}' && f.elements.dia.value === hoyISO() && f.elements.hora_inicio.value === '10:00'; })()`), r3);
  await evaluar(p, `document.querySelector('#modales .modal form').requestSubmit()`);
  ok('…y la celda de Ane de hoy queda con 2 bloques y "4 h"', await esperarHasta(p, `(() => { const c = ${celdaAneHoy}; return c.querySelectorAll('.bloque.compacto').length === 2 && /^4 h/.test(c.querySelector('.plan-carga').textContent.trim()); })()`) && await sinModal(p));
  await captura(p, '04-semana');
  await evaluar(p, `document.querySelector('.plan-semana thead th.hoy [data-ir]').click()`);
  ok('clic en la cabecera de un día vuelve a la vista Día de esa fecha', await esperarHasta(p, `document.querySelectorAll('.plan-col').length === 3 && document.querySelector('[data-modo=dia]').classList.contains('activo')`));

  // Detalle: botón para planificar desde la O.T.
  await evaluar(p, `${tarjetaBandeja('Lezama')}.click()`);
  ok('detalle de una O.T. de la bandeja: fila "Planificación" con el botón Planificar', await esperarHasta(p, `(() => { const b = document.querySelector('.modal [data-ref=bloques] [data-accion=planificar]'); return !!b && b.textContent === 'Planificar'; })()`));
  await escape(p);
  await sinModal(p);

  // El Tablero enseña el próximo bloque
  await evaluar(p, `location.hash = 'kanban'`);
  ok('Tablero: la tarjeta planificada lleva "📅 fecha hora · técnico"', await esperarHasta(p, `(() => { const t = [...document.querySelectorAll('.columna .tarjeta')].find(x => x.textContent.includes('${numGaraio}')); return !!t && /📅 .* 10:00 · Ane Zubiaurre/.test(t.querySelector('.proximo')?.textContent || '') && t.closest('.columna').dataset.fase === 'planificada'; })()`));

  // --- Gerencia: ve el Planificador, no puede tocar ----------------------------------------------------------------------
  await salir(p);
  await entrar(p, 'gerencia1', 'prueba123');
  ok('gerencia: Planificador por defecto, sin nada arrastrable', await esperarHasta(p, `document.querySelector('#nav button.activo')?.textContent === 'Planificador' && document.querySelectorAll('.bloque').length >= 3`) && (await evaluar(p, `document.querySelectorAll('.bloque[draggable=true]').length === 0 && document.querySelectorAll('.tarjeta-bandeja[draggable=true]').length === 0 && !document.querySelector('.b-tirador')`)));
  await evaluar(p, `document.querySelector('.bloque').click()`);
  ok('gerencia: el modal del bloque abre en solo lectura (sin Guardar ni Quitar)', await esperarHasta(p, `(() => { const m = document.querySelector('#modales .modal'); return !!m && m.querySelector('[data-ref=guardar]').classList.contains('oculto') && m.querySelector('[data-ref=quitar]').classList.contains('oculto') && m.querySelector('form').elements.dia.disabled; })()`));
  await escape(p);
  await sinModal(p);

  // --- Administrativo: su home sigue siendo el Tablero, con la pestaña Planificador ----------------------------------------
  await salir(p);
  await entrar(p, 'admin_prueba', 'clave-prueba-123');
  ok('administrativo: Tablero por defecto y pestaña Planificador la primera', await esperarHasta(p, `document.querySelector('#nav button.activo')?.textContent === 'Tablero'`) && (await evaluar(p, `document.querySelector('#nav button').textContent`)) === 'Planificador');

  p.cerrar();
  console.log(res.join('\n'));
  console.log('\nConsola (errores/avisos):', consola.length ? '\n  ' + consola.join('\n  ') : 'ninguno');
  console.log('Respuestas 4xx/5xx:', red.length ? '\n  ' + red.join('\n  ') : 'ninguna');
  if (consola.length) res.push('FALLO consola con errores');
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); console.log('Consola:', consola); process.exit(1); });
