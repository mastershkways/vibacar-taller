// app.js — Gestión de Taller Vibacar. Interfaz de una sola página, sin frameworks.
//
// Arranque: GET /api/sesion + GET /api/estados → estado global `S` → vista según el rol.
//   admontaller            → Tablero (Kanban) con polling cada 10 s (ETag / 304)
//   tecnico, sat           → Mis O.T. (tablet: tarjetas y botones grandes)
//   recambista, financiero, comercial → Listado (tabla); Tablero si el rol tiene kanban.ver
// Las vistas son <template> del index.html que se clonan en <main id="app">.
// Lo que se pinta depende de los permisos que devuelve el servidor; la barrera real está en la API.

'use strict';

const S = {
  sesion: null,            // { usuario, rol, alcance, permisos }
  permisos: new Set(),
  fases: [],               // todas (abierta=1 y 0)
  estados: [],
  estadoPor: {},           // codigo → estado
  transiciones: [],        // [{origen, destino}] ya filtradas por el rol
  vista: null,
  kanban: { etag: null, datos: null, timer: null, cargando: false },
  listado: { pagina: 1, limite: 100 },
  tecnicos: null,
};

const POLLING_MS = 10000;
const PRIORIDADES = { 1: 'Alta', 2: 'Media', 3: 'Baja' };
const app = document.getElementById('app');

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const ref = (nombre, el) => el.querySelector(`[data-ref="${nombre}"]`);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function puede(accion) { return S.permisos.has(accion); }

function fecha(iso) {
  if (!iso) return '';
  const [d, h] = String(iso).split(' ');
  const [a, m, dia] = d.split('-');
  return `${dia}/${m}/${a}${h ? ' ' + h.slice(0, 5) : ''}`;
}

function textoMaquina(o) {
  if (!o.maquina_id) return '';
  const partes = [o.maquina_marca, o.maquina_modelo].filter(Boolean).join(' ');
  const ident = o.maquina_flota ? `flota ${o.maquina_flota}` : (o.maquina_bastidor ? `bast. ${o.maquina_bastidor}` : '');
  return [partes, ident].filter(Boolean).join(' · ');
}

function tpl(id) {
  const t = document.getElementById(id);
  if (!t) throw new Error(`Falta la plantilla ${id}`);
  return t.content.firstElementChild.cloneNode(true);
}

// Oculta los elementos con data-permiso="x" si el usuario no tiene ese permiso.
function aplicarPermisos(nodo) {
  for (const el of $$('[data-permiso]', nodo)) if (!puede(el.dataset.permiso)) el.classList.add('oculto');
}

function toast(mensaje, tipo = '') {
  const el = document.createElement('div');
  el.className = `toast ${tipo ? 'toast-' + tipo : ''}`;
  el.textContent = mensaje;
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), tipo === 'error' ? 7000 : 4000);
}

function aviso(contenedor, mensaje, tipo = 'error', botonTexto = null, botonFn = null) {
  contenedor.innerHTML = '';
  if (!mensaje) return;
  const el = document.createElement('div');
  el.className = `aviso aviso-${tipo}`;
  el.innerHTML = `<span>${esc(mensaje)}</span>`;
  if (botonTexto) {
    const b = document.createElement('button');
    b.className = 'btn btn-pequeno';
    b.type = 'button';
    b.textContent = botonTexto;
    b.onclick = botonFn;
    el.append(b);
  }
  contenedor.append(el);
}

// fetch con JSON, errores como excepción { status, mensaje, datos }. 401 → pantalla de acceso.
async function api(url, { method = 'GET', body, headers = {} } = {}) {
  const opciones = { method, headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    opciones.headers['Content-Type'] = 'application/json';
    opciones.body = JSON.stringify(body);
  }
  let r;
  try {
    r = await fetch(url, opciones);
  } catch (e) {
    throw Object.assign(new Error('Sin conexión con el servidor'), { status: 0 });
  }
  if (r.status === 401) {
    location.href = `/acceso?volver=${encodeURIComponent(location.pathname + location.hash)}`;
    throw Object.assign(new Error('Sesión caducada'), { status: 401 });
  }
  if (r.status === 304) return { _304: true };
  const datos = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (!r.ok) {
    throw Object.assign(new Error((datos && datos.error) || `Error ${r.status}`), { status: r.status, datos });
  }
  if (datos === null || typeof datos !== 'object') return datos;
  return Object.defineProperty(datos, '_etag', { value: r.headers.get('ETag'), enumerable: false });
}

// ---------------------------------------------------------------------------
// Modales
// ---------------------------------------------------------------------------
function abrirModal(nodo) {
  const capa = document.getElementById('modales');
  capa.append(nodo);
  aplicarPermisos(nodo);
  for (const b of $$('[data-accion="cerrar"]', nodo)) b.onclick = () => nodo.remove();
  nodo.addEventListener('click', (e) => { if (e.target === nodo) nodo.remove(); });
  const primero = $('input:not([type=hidden]), select, textarea, button', $('.modal-cuerpo', nodo) || nodo);
  if (primero) setTimeout(() => primero.focus(), 50);
  return nodo;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const abiertos = $$('#modales > .modal-fondo');
    if (abiertos.length) abiertos[abiertos.length - 1].remove();
  }
});

// Pregunta entre varias opciones (botones). Devuelve el valor elegido o null.
function elegir(titulo, opciones) {
  return new Promise((resolver) => {
    const nodo = tpl('tpl-elegir');
    ref('titulo', nodo).textContent = titulo;
    const cont = ref('opciones', nodo);
    for (const op of opciones) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = op.etiqueta;
      if (op.color) b.style.borderColor = op.color;
      b.onclick = () => { nodo.remove(); resolver(op.valor); };
      cont.append(b);
    }
    abrirModal(nodo);
    const obs = new MutationObserver(() => { if (!nodo.isConnected) { obs.disconnect(); resolver(null); } });
    obs.observe(document.getElementById('modales'), { childList: true });
  });
}

// ---------------------------------------------------------------------------
// Estados y transiciones (datos de /api/estados)
// ---------------------------------------------------------------------------
function destinosDesde(codigoEstado) {
  return S.transiciones.filter((t) => t.origen === codigoEstado).map((t) => S.estadoPor[t.destino]).filter(Boolean);
}

function chipEstado(o) {
  const e = S.estadoPor[o.estado] || {};
  return `<span class="chip" style="background:${esc(e.color || o.estado_color || '#6b7280')}">${esc(e.nombre || o.estado_nombre || o.estado)}</span>`;
}

function chipPrioridad(p) {
  return `<span class="prio prio-${p}" title="Prioridad ${PRIORIDADES[p] || p}"></span>`;
}

// Cambio de estado con bloqueo optimista. Devuelve true si se hizo.
async function cambiarEstado(ot, destino, nota, contenedorAvisos, alRecargar = null) {
  try {
    await api(`/api/ot/${ot.id}/estado`, { method: 'POST', body: { estado: destino, nota: nota || undefined, version: ot.version } });
    toast(`${ot.numero} → ${S.estadoPor[destino]?.nombre || destino}`, 'ok');
    return true;
  } catch (e) {
    mostrarErrorAccion(e, contenedorAvisos, alRecargar);
    return false;
  }
}

function mostrarErrorAccion(e, contenedorAvisos, alRecargar = null) {
  if (e.status === 409) {
    const msg = e.datos && e.datos.version
      ? `${e.message} (ahora va por la versión ${e.datos.version})`
      : e.message;
    if (contenedorAvisos) aviso(contenedorAvisos, msg, 'conflicto', alRecargar ? 'Recargar la O.T.' : null, alRecargar);
    toast(msg, 'aviso');
  } else if (e.status === 403) {
    if (contenedorAvisos) aviso(contenedorAvisos, e.message, 'error');
    toast(e.message, 'error');
  } else if (e.status !== 401) {
    if (contenedorAvisos) aviso(contenedorAvisos, e.message, 'error');
    toast(e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Arranque y navegación
// ---------------------------------------------------------------------------
const VISTAS = {
  kanban: { titulo: 'Tablero', visible: () => puede('kanban.ver'), pintar: pintarKanban },
  misot: { titulo: 'Mis O.T.', visible: () => S.sesion.alcance === 'asignadas', pintar: pintarMisOT },
  listado: { titulo: 'Listado', visible: () => puede('ot.ver'), pintar: pintarListado },
};

function vistaPorDefecto() {
  if (S.sesion.alcance === 'asignadas') return 'misot';
  if (S.sesion.usuario.rol === 'admontaller' && puede('kanban.ver')) return 'kanban';
  return 'listado';
}

function pintarCabecera() {
  $('#usuario-nombre').textContent = S.sesion.usuario.nombre;
  $('#usuario-rol').textContent = S.sesion.rol;
  const nav = $('#nav');
  nav.innerHTML = '';
  for (const [nombre, v] of Object.entries(VISTAS)) {
    if (!v.visible()) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.vista = nombre;
    b.textContent = v.titulo;
    b.onclick = () => { location.hash = nombre; };
    nav.append(b);
  }
}

function mostrarVista(nombre) {
  if (!VISTAS[nombre] || !VISTAS[nombre].visible()) nombre = vistaPorDefecto();
  pararPolling();
  S.vista = nombre;
  for (const b of $$('#nav button')) b.classList.toggle('activo', b.dataset.vista === nombre);
  app.innerHTML = '';
  // Las plantillas de vista tienen varios hijos de primer nivel: se clona el fragmento entero.
  app.append(document.getElementById(`tpl-${nombre}`).content.cloneNode(true));
  aplicarPermisos(app);
  for (const b of $$('[data-accion="nueva"]', app)) b.onclick = abrirNuevaOT;
  VISTAS[nombre].pintar();
}

// Rutas por hash: #kanban | #misot | #listado | #ot/123 (detalle sobre la vista actual)
function enrutar() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^ot\/(\d+)$/);
  if (m) {
    if (!S.vista) mostrarVista(vistaPorDefecto());
    abrirDetalle(Number(m[1]));
    return;
  }
  mostrarVista(h || vistaPorDefecto());
}

async function iniciar() {
  try {
    const [sesion, estados] = await Promise.all([api('/api/sesion'), api('/api/estados')]);
    S.sesion = sesion;
    S.permisos = new Set(sesion.permisos || []);
    S.fases = estados.fases;
    S.estados = estados.estados;
    S.estadoPor = Object.fromEntries(estados.estados.map((e) => [e.codigo, e]));
    S.transiciones = estados.transiciones;
  } catch (e) {
    if (e.status !== 401) app.innerHTML = `<div class="vacio">No se ha podido cargar la aplicación: ${esc(e.message)}</div>`;
    return;
  }
  pintarCabecera();
  window.addEventListener('hashchange', enrutar);
  document.addEventListener('visibilitychange', () => {
    if (S.vista !== 'kanban') return;
    if (document.hidden) pararPolling(); else { cargarKanban(); arrancarPolling(); }
  });
  enrutar();
}

// ---------------------------------------------------------------------------
// Vista: Kanban
// ---------------------------------------------------------------------------
function arrancarPolling() {
  pararPolling();
  S.kanban.timer = setInterval(cargarKanban, POLLING_MS);
}

function pararPolling() {
  if (S.kanban.timer) clearInterval(S.kanban.timer);
  S.kanban.timer = null;
}

function pintarKanban() {
  $('[data-accion="recargar"]', app).onclick = () => { S.kanban.etag = null; cargarKanban(); };
  const cont = ref('columnas', app);
  cont.innerHTML = '';
  for (const f of S.fases.filter((x) => x.abierta)) {
    const col = document.createElement('div');
    col.className = 'columna';
    col.dataset.fase = f.codigo;
    col.innerHTML = `<h3>${esc(f.nombre)} <span data-ref="n">0</span></h3><div class="cuerpo" data-ref="cuerpo"></div>`;
    prepararSoltar(col);
    cont.append(col);
  }
  S.kanban.etag = null;
  cargarKanban();
  arrancarPolling();
}

async function cargarKanban() {
  if (S.vista !== 'kanban' || S.kanban.cargando) return;
  S.kanban.cargando = true;
  try {
    const datos = await api('/api/kanban', { headers: S.kanban.etag ? { 'If-None-Match': S.kanban.etag } : {} });
    if (datos._304) return;
    S.kanban.etag = datos._etag;
    S.kanban.datos = datos;
    pintarColumnas();
  } catch (e) {
    if (e.status !== 401) toast(`Tablero: ${e.message}`, 'error');
  } finally {
    S.kanban.cargando = false;
  }
}

function pintarColumnas() {
  const datos = S.kanban.datos;
  if (!datos || S.vista !== 'kanban') return;
  const cont = ref('contador', app);
  if (cont) cont.textContent = `${datos.total} O.T. abiertas · ${fecha(datos.generado)}`;
  for (const f of datos.fases) {
    const col = $(`.columna[data-fase="${f.codigo}"]`, app);
    if (!col) continue;
    ref('n', col).textContent = f.ots.length;
    const cuerpo = ref('cuerpo', col);
    cuerpo.innerHTML = '';
    for (const o of f.ots) cuerpo.append(tarjetaKanban(o));
  }
}

function tarjetaKanban(o) {
  const el = document.createElement('div');
  el.className = 'tarjeta';
  el.dataset.id = o.id;
  el.style.borderLeftColor = (S.estadoPor[o.estado] || {}).color || '#6b7280';
  el.innerHTML = `
    <div class="num">${chipPrioridad(o.prioridad)}${esc(o.numero)} <small>${esc(o.tipo)}</small></div>
    <div class="cliente">${esc(o.cliente_nombre)}</div>
    ${o.maquina_id ? `<div class="maquina">${esc(textoMaquina(o))}</div>` : ''}
    ${o.sintoma ? `<div class="sintoma" title="${esc(o.sintoma)}">${esc(o.sintoma)}</div>` : ''}
    ${o.tecnico_nombre ? `<div class="tecnico">${esc(o.tecnico_nombre)}</div>` : ''}`;
  el.onclick = () => abrirDetalle(o.id);
  if (puede('ot.cambiar_estado') && destinosDesde(o.estado).length) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(o.id));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('arrastrando');
      marcarColumnasDestino(o);
    });
    el.addEventListener('dragend', () => { el.classList.remove('arrastrando'); desmarcarColumnas(); });
  }
  return el;
}

function otDelKanban(id) {
  for (const f of (S.kanban.datos?.fases || [])) for (const o of f.ots) if (o.id === id) return o;
  return null;
}

function marcarColumnasDestino(o) {
  const destinos = destinosDesde(o.estado);
  for (const col of $$('.columna', app)) {
    if (col.dataset.fase === o.fase) continue;
    col.classList.add(destinos.some((d) => d.fase === col.dataset.fase) ? 'destino-ok' : 'destino-no');
  }
}

function desmarcarColumnas() {
  for (const col of $$('.columna', app)) col.classList.remove('destino-ok', 'destino-no');
}

function prepararSoltar(col) {
  col.addEventListener('dragover', (e) => {
    if (col.classList.contains('destino-ok')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }
  });
  col.addEventListener('drop', async (e) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain'));
    desmarcarColumnas();
    const o = otDelKanban(id);
    if (!o) return;
    const fase = col.dataset.fase;
    if (fase === o.fase) return;
    const candidatos = destinosDesde(o.estado).filter((d) => d.fase === fase);
    if (!candidatos.length) { toast('Tu rol no puede mover esta O.T. a esa fase', 'error'); return; }
    let destino = candidatos[0].codigo;
    if (candidatos.length > 1) {
      destino = await elegir(`${o.numero}: ¿a qué estado?`, candidatos.map((d) => ({ etiqueta: d.nombre, valor: d.codigo, color: d.color })));
      if (!destino) return;
    }
    // Movimiento optimista: la tarjeta cambia de columna; si el servidor dice que no, se repinta tal como estaba.
    const tarjeta = $(`.tarjeta[data-id="${id}"]`, app);
    if (tarjeta) ref('cuerpo', col).prepend(tarjeta);
    const ok = await cambiarEstado(o, destino, null, null);
    S.kanban.etag = null;
    if (!ok) pintarColumnas();
    cargarKanban();
  });
}

// ---------------------------------------------------------------------------
// Vista: Mis O.T. (tablet)
// ---------------------------------------------------------------------------
async function pintarMisOT() {
  $('[data-accion="recargar"]', app).onclick = pintarMisOT;
  const lista = ref('lista', app);
  lista.classList.add('cargando');
  try {
    const datos = await api('/api/ot?abiertas=1&limite=200');
    ref('contador', app).textContent = `${datos.total} asignadas`;
    lista.innerHTML = '';
    if (!datos.ots.length) lista.innerHTML = '<div class="vacio">No tienes ninguna O.T. asignada.</div>';
    for (const o of datos.ots) lista.append(tarjetaGrande(o));
  } catch (e) {
    if (e.status !== 401) lista.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
  } finally {
    lista.classList.remove('cargando');
  }
}

function tarjetaGrande(o) {
  const el = document.createElement('div');
  el.className = 'tarjeta-grande';
  el.style.borderTopColor = (S.estadoPor[o.estado] || {}).color || '#6b7280';
  const destinos = puede('ot.cambiar_estado') ? destinosDesde(o.estado) : [];
  el.innerHTML = `
    <div class="num"><span>${chipPrioridad(o.prioridad)}${esc(o.numero)}</span>${chipEstado(o)}</div>
    <div class="cliente">${esc(o.cliente_nombre)}</div>
    ${o.maquina_id ? `<div class="maquina">${esc(textoMaquina(o))}</div>` : ''}
    ${o.sintoma ? `<div class="sintoma">${esc(o.sintoma)}</div>` : ''}
    <div class="botones">
      ${destinos.map((d) => `<button type="button" class="btn btn-grande" data-destino="${esc(d.codigo)}" style="border-color:${esc(d.color)}">${esc(d.nombre)}</button>`).join('')}
      <button type="button" class="btn btn-grande ancho" data-accion="detalle">Ver detalle</button>
    </div>`;
  $('[data-accion="detalle"]', el).onclick = () => abrirDetalle(o.id);
  for (const b of $$('[data-destino]', el)) {
    b.onclick = () => abrirParte(o, b.dataset.destino, pintarMisOT);
  }
  return el;
}

// Modal "parte": nota grande (dictado) + confirmar el cambio de estado.
function abrirParte(o, destino, alTerminar) {
  const nodo = tpl('tpl-parte');
  const d = S.estadoPor[destino] || { nombre: destino };
  ref('titulo', nodo).textContent = `${o.numero}: pasar a "${d.nombre}"`;
  const boton = $('[data-accion="confirmar"]', nodo);
  boton.textContent = d.nombre;
  boton.onclick = async () => {
    boton.disabled = true;
    const ok = await cambiarEstado(o, destino, ref('nota', nodo).value.trim(), ref('avisos', nodo));
    boton.disabled = false;
    if (ok) { nodo.remove(); alTerminar && alTerminar(); }
  };
  abrirModal(nodo);
  ref('nota', nodo).focus();
}

// ---------------------------------------------------------------------------
// Vista: Listado (tabla)
// ---------------------------------------------------------------------------
function pintarListado() {
  const form = ref('filtros', app);
  const selFase = ref('fase', form);
  for (const f of S.fases) selFase.insertAdjacentHTML('beforeend', `<option value="${esc(f.codigo)}">${esc(f.nombre)}</option>`);
  form.onsubmit = (e) => { e.preventDefault(); S.listado.pagina = 1; cargarListado(); };
  for (const sel of $$('select', form)) sel.onchange = () => { S.listado.pagina = 1; cargarListado(); };
  cargarListado();
}

async function cargarListado() {
  const form = ref('filtros', app);
  const filas = ref('filas', app);
  const params = new URLSearchParams(new FormData(form));
  params.set('pagina', S.listado.pagina);
  params.set('limite', S.listado.limite);
  for (const [k, v] of Array.from(params.entries())) if (v === '') params.delete(k);
  filas.classList.add('cargando');
  try {
    const datos = await api(`/api/ot?${params}`);
    ref('contador', app).textContent = `${datos.total} O.T.`;
    filas.innerHTML = '';
    if (!datos.ots.length) filas.innerHTML = '<tr><td colspan="8" class="vacio">Sin resultados</td></tr>';
    for (const o of datos.ots) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="num">${esc(o.numero)}</td>
        <td>${esc(o.cliente_nombre)}</td>
        <td>${esc(textoMaquina(o))}</td>
        <td>${esc(o.sintoma || '')}</td>
        <td>${chipEstado(o)}</td>
        <td>${chipPrioridad(o.prioridad)}${esc(PRIORIDADES[o.prioridad] || '')}</td>
        <td>${esc(o.tecnico_nombre || '')}</td>
        <td>${esc(fecha(o.creado))}</td>`;
      tr.onclick = () => abrirDetalle(o.id);
      filas.append(tr);
    }
    const pag = ref('paginacion', app);
    const paginas = Math.max(1, Math.ceil(datos.total / datos.limite));
    pag.innerHTML = `<span>Página ${datos.pagina} de ${paginas}</span>
      <button class="btn btn-pequeno" type="button" data-accion="ant" ${datos.pagina <= 1 ? 'disabled' : ''}>‹</button>
      <button class="btn btn-pequeno" type="button" data-accion="sig" ${datos.pagina >= paginas ? 'disabled' : ''}>›</button>`;
    $('[data-accion="ant"]', pag).onclick = () => { S.listado.pagina--; cargarListado(); };
    $('[data-accion="sig"]', pag).onclick = () => { S.listado.pagina++; cargarListado(); };
  } catch (e) {
    if (e.status !== 401) filas.innerHTML = `<tr><td colspan="8" class="vacio">${esc(e.message)}</td></tr>`;
  } finally {
    filas.classList.remove('cargando');
  }
}

// Refresca la vista de fondo tras un cambio hecho desde un modal.
function refrescarVista() {
  if (S.vista === 'kanban') { S.kanban.etag = null; cargarKanban(); }
  else if (S.vista === 'misot') pintarMisOT();
  else if (S.vista === 'listado') cargarListado();
}

// ---------------------------------------------------------------------------
// Detalle de O.T. (modal)
// ---------------------------------------------------------------------------
async function cargarTecnicos() {
  if (S.tecnicos) return S.tecnicos;
  S.tecnicos = await api('/api/tecnicos');
  return S.tecnicos;
}

async function abrirDetalle(id) {
  let ot;
  try {
    ot = await api(`/api/ot/${id}`);
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    return;
  }
  const existente = $(`#modales [data-ot-id="${id}"]`);
  if (existente) existente.remove();
  const nodo = tpl('tpl-detalle');
  nodo.dataset.otId = id;
  abrirModal(nodo);
  pintarDetalle(nodo, ot);
}

function pintarDetalle(nodo, ot) {
  const avisos = ref('avisos', nodo);
  const editable = puede('ot.editar') && !ot.es_final;

  ref('numero', nodo).textContent = ot.numero;
  const chip = ref('estado', nodo);
  chip.textContent = ot.estado_nombre;
  chip.style.background = ot.estado_color || '#6b7280';
  ref('prioridad', nodo).textContent = `Prioridad ${PRIORIDADES[ot.prioridad] || ot.prioridad}`;
  ref('cliente', nodo).textContent = ot.cliente_nombre + (ot.exige_pedido ? ' · exige Nº pedido' : '');
  ref('maquina', nodo).textContent = textoMaquina(ot) || '—';
  ref('tecnico', nodo).textContent = ot.tecnico_nombre || 'Sin asignar';
  ref('creado', nodo).textContent = `${fecha(ot.creado)}${ot.creado_por_nombre ? ' · ' + ot.creado_por_nombre : ''}`;

  // Datos editables (PUT con version → 409 si otro la cambió).
  const form = ref('form-datos', nodo);
  form.elements.tipo.value = ot.tipo;
  form.elements.prioridad.value = String(ot.prioridad);
  form.elements.origen.value = ot.origen;
  form.elements.sintoma.value = ot.sintoma || '';
  form.elements.descripcion.value = ot.descripcion || '';
  form.elements.notas_internas.value = ot.notas_internas || '';
  for (const el of $$('select, textarea', form)) el.disabled = !editable;
  ref('acciones-datos', nodo).classList.toggle('oculto', !editable);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const boton = $('button[type=submit]', form);
    boton.disabled = true;
    aviso(avisos, null);
    try {
      const body = {
        version: ot.version,
        tipo: form.elements.tipo.value,
        prioridad: Number(form.elements.prioridad.value),
        origen: form.elements.origen.value,
        sintoma: form.elements.sintoma.value.trim(),
        descripcion: form.elements.descripcion.value.trim(),
        notas_internas: form.elements.notas_internas.value.trim(),
      };
      const nueva = await api(`/api/ot/${ot.id}`, { method: 'PUT', body });
      toast('Cambios guardados', 'ok');
      pintarDetalle(nodo, nueva);
      refrescarVista();
    } catch (err) {
      mostrarErrorAccion(err, avisos, () => recargarDetalle(nodo, ot.id));
    } finally {
      boton.disabled = false;
    }
  };

  // Cambio de estado: botones de las transiciones que el servidor permite a este rol.
  const secEstado = ref('sec-estado', nodo);
  const cont = ref('transiciones', nodo);
  cont.innerHTML = '';
  const nota = ref('nota-estado', nodo);
  if (ot.transiciones && ot.transiciones.length && !ot.es_final) {
    secEstado.classList.remove('oculto');
    for (const t of ot.transiciones) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.style.borderColor = t.color || '#6b7280';
      b.textContent = `→ ${t.nombre}`;
      b.onclick = async () => {
        b.disabled = true;
        aviso(avisos, null);
        const ok = await cambiarEstado(ot, t.codigo, nota.value.trim(), avisos, () => recargarDetalle(nodo, ot.id));
        b.disabled = false;
        if (ok) { await recargarDetalle(nodo, ot.id); refrescarVista(); }
      };
      cont.append(b);
    }
  } else {
    secEstado.classList.add('oculto');
  }

  // Asignación.
  const secAsig = ref('sec-asignacion', nodo);
  const puedeProponer = puede('ot.asignar') && !ot.es_final;
  const puedeAprobar = puede('ot.aprobar_asignacion') && !ot.es_final;
  const pendientes = (ot.asignaciones || []).filter((a) => a.estado === 'propuesta');
  const propuestas = ref('propuestas', nodo);
  propuestas.innerHTML = '';
  for (const a of pendientes) {
    const div = document.createElement('div');
    div.className = 'propuesta';
    div.innerHTML = `<b>Propuesta: ${esc(a.tecnico_nombre)}</b><span>${esc(a.propuesto_por_nombre || '')} · ${esc(fecha(a.fecha))}${a.nota ? ' · ' + esc(a.nota) : ''}</span>`;
    if (puedeAprobar) {
      for (const [txt, aprobar, cls] of [['Aprobar', true, 'btn-primario'], ['Rechazar', false, 'btn-peligro']]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `btn btn-pequeno ${cls}`;
        b.textContent = txt;
        b.onclick = async () => {
          b.disabled = true;
          try {
            await api(`/api/ot/${ot.id}/asignacion/${a.id}/aprobar`, { method: 'POST', body: { aprobar } });
            toast(aprobar ? `Asignada a ${a.tecnico_nombre}` : 'Propuesta rechazada', 'ok');
            await recargarDetalle(nodo, ot.id);
            refrescarVista();
          } catch (err) { mostrarErrorAccion(err, avisos); b.disabled = false; }
        };
        div.append(b);
      }
    }
    propuestas.append(div);
  }
  if (!pendientes.length && !puedeProponer) propuestas.innerHTML = '<div class="pista">Sin propuestas pendientes.</div>';

  const formAsig = ref('form-asignar', nodo);
  if (puedeProponer && !pendientes.length) {
    formAsig.classList.remove('oculto');
    secAsig.classList.remove('oculto');
    cargarTecnicos().then((tecnicos) => {
      const sel = ref('tecnicos', formAsig);
      sel.innerHTML = tecnicos.length
        ? tecnicos.map((t) => `<option value="${t.id}">${esc(t.nombre)} (${esc(t.rol)})</option>`).join('')
        : '<option value="">No hay técnicos activos</option>';
      if (ot.tecnico_id) sel.value = String(ot.tecnico_id);
    }).catch((err) => mostrarErrorAccion(err, avisos));
    const enviar = async (aprobar) => {
      const tecnicoId = Number(formAsig.elements.tecnico_id.value);
      if (!tecnicoId) { toast('Elige un técnico', 'aviso'); return; }
      aviso(avisos, null);
      try {
        await api(`/api/ot/${ot.id}/asignar`, { method: 'POST', body: { tecnico_id: tecnicoId, nota: formAsig.elements.nota.value.trim() || undefined, aprobar } });
        toast(aprobar ? 'Técnico asignado' : 'Propuesta registrada', 'ok');
        await recargarDetalle(nodo, ot.id);
        refrescarVista();
      } catch (err) { mostrarErrorAccion(err, avisos); }
    };
    formAsig.onsubmit = (e) => { e.preventDefault(); enviar(false); };
    $('[data-accion="asignar-ya"]', formAsig).onclick = () => enviar(true);
  } else {
    formAsig.classList.add('oculto');
    secAsig.classList.toggle('oculto', !pendientes.length && !puedeProponer && !puedeAprobar);
  }

  // Historial.
  const hist = ref('historial', nodo);
  hist.innerHTML = '';
  for (const h of [...(ot.historial || [])].reverse()) {
    const cambio = h.estado_anterior && h.estado_anterior !== h.estado_nuevo
      ? `${esc(h.estado_anterior_nombre || h.estado_anterior)} → <b>${esc(h.estado_nuevo_nombre || h.estado_nuevo)}</b>`
      : `<b>${esc(h.estado_nuevo_nombre || h.estado_nuevo)}</b>`;
    hist.insertAdjacentHTML('beforeend', `<li><span class="fecha">${esc(fecha(h.fecha))}</span><span>${cambio} · ${esc(h.usuario_nombre || '')}${h.nota ? `<div class="nota">${esc(h.nota)}</div>` : ''}</span></li>`);
  }
}

async function recargarDetalle(nodo, id) {
  try {
    const ot = await api(`/api/ot/${id}`);
    pintarDetalle(nodo, ot);
    aviso(ref('avisos', nodo), null);
  } catch (e) { mostrarErrorAccion(e, ref('avisos', nodo)); }
}

// ---------------------------------------------------------------------------
// Nueva O.T. (modal)
// ---------------------------------------------------------------------------
async function abrirNuevaOT() {
  const nodo = tpl('tpl-nueva');
  abrirModal(nodo);
  const avisos = ref('avisos', nodo);
  const form = ref('form', nodo);
  const selClientes = ref('clientes', nodo);
  const selMaquinas = ref('maquinas', nodo);
  let clientes = [];

  const pintarClientes = (filtro = '') => {
    const f = filtro.trim().toLowerCase();
    const actual = selClientes.value;
    selClientes.innerHTML = '';
    for (const c of clientes) {
      if (f && !c.nombre.toLowerCase().includes(f) && !(c.cif || '').toLowerCase().includes(f)) continue;
      selClientes.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.nombre)}${c.cif ? ' · ' + esc(c.cif) : ''}</option>`);
    }
    if (actual && $(`option[value="${actual}"]`, selClientes)) selClientes.value = actual;
  };

  const cargarMaquinas = async () => {
    selMaquinas.innerHTML = '<option value="">Sin máquina</option>';
    const clienteId = selClientes.value;
    if (!clienteId) return;
    try {
      const maquinas = await api(`/api/maquinas?cliente_id=${clienteId}`);
      for (const m of maquinas) selMaquinas.insertAdjacentHTML('beforeend', `<option value="${m.id}">${esc(textoMaquina({ maquina_id: m.id, maquina_marca: m.marca, maquina_modelo: m.modelo, maquina_bastidor: m.bastidor, maquina_flota: m.num_flota }))}</option>`);
    } catch (e) { mostrarErrorAccion(e, avisos); }
  };

  try {
    clientes = await api('/api/clientes');
  } catch (e) { mostrarErrorAccion(e, avisos); }
  pintarClientes();
  if (!clientes.length) aviso(avisos, 'No hay clientes todavía. Crea el primero aquí abajo.', 'conflicto');

  ref('buscar-cliente', nodo).oninput = (e) => pintarClientes(e.target.value);
  selClientes.onchange = cargarMaquinas;

  const btnCliente = $('[data-accion="crear-cliente"]', nodo);
  if (btnCliente) btnCliente.onclick = async () => {
    const nombre = ref('nuevo-cliente', nodo).value.trim();
    if (!nombre) { toast('Escribe el nombre del cliente', 'aviso'); return; }
    try {
      const c = await api('/api/clientes', { method: 'POST', body: { nombre } });
      clientes.push(c);
      clientes.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      ref('buscar-cliente', nodo).value = '';
      ref('nuevo-cliente', nodo).value = '';
      pintarClientes();
      selClientes.value = String(c.id);
      aviso(avisos, null);
      toast(`Cliente "${c.nombre}" creado`, 'ok');
      cargarMaquinas();
    } catch (e) { mostrarErrorAccion(e, avisos); }
  };

  const btnMaquina = $('[data-accion="crear-maquina"]', nodo);
  if (btnMaquina) btnMaquina.onclick = async () => {
    const clienteId = Number(selClientes.value);
    if (!clienteId) { toast('Elige antes el cliente', 'aviso'); return; }
    const marca = ref('nueva-marca', nodo).value.trim();
    const modelo = ref('nuevo-modelo', nodo).value.trim();
    const bastidor = ref('nuevo-bastidor', nodo).value.trim();
    try {
      const m = await api('/api/maquinas', { method: 'POST', body: { cliente_id: clienteId, marca, modelo, bastidor } });
      await cargarMaquinas();
      selMaquinas.value = String(m.id);
      for (const r of ['nueva-marca', 'nuevo-modelo', 'nuevo-bastidor']) ref(r, nodo).value = '';
      toast('Máquina creada', 'ok');
    } catch (e) { mostrarErrorAccion(e, avisos); }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const clienteId = Number(selClientes.value);
    if (!clienteId) { aviso(avisos, 'Elige un cliente', 'error'); return; }
    const boton = $('button[type=submit]', form);
    boton.disabled = true;
    aviso(avisos, null);
    try {
      const body = {
        cliente_id: clienteId,
        maquina_id: selMaquinas.value ? Number(selMaquinas.value) : null,
        tipo: form.elements.tipo.value,
        origen: form.elements.origen.value,
        prioridad: form.elements.prioridad.value ? Number(form.elements.prioridad.value) : undefined,
        sintoma: form.elements.sintoma.value.trim() || undefined,
        descripcion: form.elements.descripcion.value.trim() || undefined,
        notas_internas: form.elements.notas_internas.value.trim() || undefined,
      };
      const ot = await api('/api/ot', { method: 'POST', body });
      toast(`O.T. ${ot.numero} abierta`, 'ok');
      nodo.remove();
      refrescarVista();
      abrirDetalle(ot.id);
    } catch (err) {
      mostrarErrorAccion(err, avisos);
    } finally {
      boton.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------------
iniciar();
