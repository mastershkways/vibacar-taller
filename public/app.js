// app.js — Gestión de Taller Vibacar. Interfaz de una sola página, sin frameworks.
//
// Arranque: GET /api/sesion + GET /api/estados → estado global `S` → vista según el rol.
//   responsable_st, operativo, gerencia → Planificador (calendario de bloques por técnico y día; F4-02)
//   administrativo          → Tablero (verticales por estado) con polling cada 10 s (ETag / 304)
//   tecnico, sat           → Mi día (móvil y tablet: sus tareas, cronómetro y checklist; F4-05 / F4-06) y la ficha de trabajo
//   recambista              → Tablero (su vertical es Pausada); comercial, comercial_jefe → Listado (tabla)
// Las vistas son <template> del index.html que se clonan en <main id="app">.
// Lo que se pinta depende de los permisos que devuelve el servidor; la barrera real está en la API.

'use strict';

const S = {
  sesion: null,            // { usuario, rol, alcance, permisos }
  permisos: new Set(),
  fases: [],               // todas (abierta=1 y 0)
  estados: [],             // verticales del Tablero (F4-04), con `responsables`
  estadoPor: {},           // codigo → estado
  etiquetas: [],           // etiquetas dentro de cada vertical (F4-01)
  etiquetaPor: {},
  flujo: { libre: true, destinos_asignadas: [], puede_cerrar: false },
  vista: null,
  kanban: { etag: null, datos: null, timer: null, cargando: false },
  tablero: { filtros: {} },  // filtros del Tablero (operario, zona, etiqueta, prioridad, texto, "solo mi vertical")
  // Planificador (F4-02): modo dia | semana, fecha de referencia, datos del último GET, arrastre en curso y filtros de la bandeja
  plan: { modo: 'dia', fecha: null, datos: null, etag: null, timer: null, cargando: false, pendiente: false, arrastre: null, redimension: false, recienArrastrado: false, vIni: 0, filtros: {} },
  listado: { pagina: 1, limite: 100 },
  clientes: { pagina: 1, limite: 50 },
  maquinas: { pagina: 1, limite: 50 },
  tecnicos: null,
  // Técnico (F4-05 / F4-06): datos de GET /api/mi-dia, O.T. de la ficha de trabajo abierta, sondeo y contador de segundos
  tec: { datos: null, etag: null, timer: null, tic: null, cargando: false, otId: null, ot: null },
  // Fichajes (F4-07 / F4-08): mes y técnico de "Mis horas" (tecnicoId solo cuando mira la oficina), día que abrir al entrar,
  // y la vista Fichajes de la oficina (mes, pestaña, datos de GET /api/jornadas y filtros de las incidencias)
  horas: { mes: null, tecnicoId: null, datos: null, abrir: null },
  fich: { mes: null, pestana: 'jornadas', datos: null, filtros: { estado: 'pendiente', tecnico_id: '' } },
};

const DIAS_CERRADAS = 0;     // F4-04: las cerradas desaparecen del Tablero (gerencia 2026-11-06); con N > 0 vuelve la columna con las de esos días
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

// Técnico de la O.T.; si no hay usuario local pero viene de Karve, el operario de Karve como referencia (F3.6-01).
function nombreTecnico(o) {
  return o.tecnico_nombre || (o.karve_operario ? `${o.karve_operario} (Karve)` : '');
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
  const quitar = () => {
    if (!el.isConnected || el.classList.contains('saliendo')) return;
    el.classList.add('saliendo');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400); // por si el navegador no anima
  };
  el.onclick = quitar;
  setTimeout(quitar, tipo === 'error' ? 7000 : 4000);
  return el; // quien lo cree puede quitarlo antes (p. ej. "Sincronizando…")
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
  for (const b of $$('[data-accion="cerrar"]', nodo)) b.onclick = () => cerrarModal(nodo);
  nodo.addEventListener('click', (e) => { if (e.target === nodo) cerrarModal(nodo); });
  const primero = $('input:not([type=hidden]), select, textarea, button', $('.modal-cuerpo', nodo) || nodo);
  if (primero) setTimeout(() => primero.focus(), 50);
  return nodo;
}

// Cierra con la animación de salida (clase .cerrando) y quita el nodo al terminar.
function cerrarModal(nodo) {
  if (!nodo || !nodo.isConnected || nodo.classList.contains('cerrando')) return;
  nodo.classList.add('cerrando');
  nodo.addEventListener('animationend', () => nodo.remove(), { once: true });
  setTimeout(() => nodo.remove(), 300); // por si el navegador no anima
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const abiertos = $$('#modales > .modal-fondo:not(.cerrando)');
    if (abiertos.length) cerrarModal(abiertos[abiertos.length - 1]);
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
      b.onclick = () => { cerrarModal(nodo); resolver(op.valor); };
      cont.append(b);
    }
    abrirModal(nodo);
    const obs = new MutationObserver(() => { if (!nodo.isConnected) { obs.disconnect(); resolver(null); } });
    obs.observe(document.getElementById('modales'), { childList: true });
  });
}

// ---------------------------------------------------------------------------
// Estados (verticales), etiquetas y flujo libre (datos de /api/estados). F4-04.
// ---------------------------------------------------------------------------
// Estados a los que este usuario puede llevar la O.T. (misma regla que el servidor: técnico/SAT a un subconjunto; cerrar exige ot.cerrar).
function destinosDesde(o) {
  if (!puede('ot.cambiar_estado')) return [];
  const estado = typeof o === 'string' ? o : o.estado;
  const esFinal = !!((typeof o === 'object' && o.es_final !== undefined) ? o.es_final : (S.estadoPor[estado] || {}).es_final);
  if (esFinal && !S.flujo.puede_cerrar) return [];
  const asignadas = S.sesion.alcance === 'asignadas';
  return S.estados.filter((e) => e.codigo !== estado && (!asignadas || S.flujo.destinos_asignadas.includes(e.codigo)) && (!e.es_final || S.flujo.puede_cerrar));
}

function etiquetasDe(estado) { return S.etiquetas.filter((t) => t.estado === estado); }

// Mi rol es responsable de esa vertical ("cada uno limpia su vertical").
function esMiVertical(codigoEstado) {
  const e = S.estadoPor[codigoEstado];
  return !!(e && (e.responsables || []).includes(S.sesion.usuario.rol));
}

function chipEstado(o) {
  const e = S.estadoPor[o.estado] || {};
  return `<span class="chip" style="background:${esc(e.color || o.estado_color || '#6b7280')}">${esc(e.nombre || o.estado_nombre || o.estado)}</span>`;
}

function chipEtiqueta(o) {
  if (!o.etiqueta) return '';
  const t = S.etiquetaPor[o.etiqueta] || { nombre: o.etiqueta_nombre || o.etiqueta, color: o.etiqueta_color };
  return `<span class="chip chip-etiqueta" style="background:${esc(t.color || '#6b7280')}">${esc(t.nombre)}</span>`;
}

function chipPrioridad(p) {
  return `<span class="prio prio-${p}" title="Prioridad ${PRIORIDADES[p] || p}"></span>`;
}

// Modal de cambio de estado (F4-04): dos preguntas según el destino (motivo/etiqueta o técnico, y nota) y confirmación.
// Devuelve una promesa con true si se hizo el cambio; false si se canceló o falló.
function abrirCambioEstado(ot, destino, { alTerminar = null, contenedorAvisos = null } = {}) {
  return new Promise((resolver) => {
    const d = S.estadoPor[destino] || { nombre: destino };
    const nodo = tpl('tpl-cambio-estado');
    ref('titulo', nodo).textContent = `${ot.numero} → ${d.nombre}`;
    ref('desde', nodo).textContent = `Ahora: ${(S.estadoPor[ot.estado] || {}).nombre || ot.estado}${ot.etiqueta ? ' · ' + ((S.etiquetaPor[ot.etiqueta] || {}).nombre || ot.etiqueta) : ''}`;
    if (S.sesion.alcance === 'asignadas' && destino === 'pausada') ref('desde', nodo).textContent += ' · Al pausar, la O.T. sale de tu tablero hasta que la oficina la vuelva a planificar.';
    const p1 = ref('pregunta-1', nodo);
    const sel = ref('opcion', nodo);
    const etiquetas = etiquetasDe(destino);
    let modo = 'ninguna';
    if (etiquetas.length) {
      modo = 'etiqueta';
      ref('etiqueta-1', nodo).textContent = destino === 'cerrada' ? '¿Cómo se cierra?' : destino === 'finalizada' ? '¿En qué situación queda?' : `¿Por qué pasa a ${d.nombre.toLowerCase()}?`;
      const sinEtiqueta = destino === 'finalizada' ? 'Trabajo terminado, pendiente de revisar' : destino === 'en_curso' ? 'Técnico propio' : '— Elige el motivo —';
      sel.innerHTML = `<option value="">${esc(sinEtiqueta)}</option>` + etiquetas.map((t) => `<option value="${esc(t.codigo)}">${esc(t.nombre)}</option>`).join('');
      sel.required = destino === 'pausada' || destino === 'cerrada';
    } else if (destino === 'planificada' && puede('ot.asignar')) {
      modo = 'tecnico';
      ref('etiqueta-1', nodo).textContent = '¿Qué técnico la hace?';
      sel.innerHTML = '<option value="">— Sin cambiar —</option>';
      cargarTecnicos().then((ts) => {
        for (const t of ts) sel.insertAdjacentHTML('beforeend', `<option value="${t.id}">${esc(t.nombre)} (${esc(t.rol)})</option>`);
        if (ot.tecnico_id) sel.value = String(ot.tecnico_id);
      }).catch(() => {});
    } else {
      p1.classList.add('oculto');
    }
    const nota = ref('nota', nodo);
    const notaObligatoria = destino === 'finalizada' || destino === 'pausada';
    ref('etiqueta-2', nodo).textContent = destino === 'finalizada' ? 'Trabajo realizado' : destino === 'pausada' ? '¿Qué falta para seguir?' : 'Nota del cambio (opcional)';
    if (S.sesion.alcance === 'asignadas') nodo.classList.add('tablet');
    const boton = ref('confirmar', nodo);
    boton.textContent = `Confirmar: ${d.nombre}`;
    if (d.color) boton.style.borderColor = d.color;
    const avisos = ref('avisos', nodo);
    let hecho = false;
    let forzar = false;                                   // F4-05/F4-06: la oficina puede finalizar sin tiempo de trabajo o sin checklist
    boton.onclick = async () => {
      if (modo === 'etiqueta' && sel.required && !sel.value) { aviso(avisos, 'Elige el motivo', 'error'); sel.focus(); return; }
      if (notaObligatoria && !nota.value.trim()) { aviso(avisos, 'Escribe la nota', 'error'); nota.focus(); return; }
      boton.disabled = true;
      const body = { estado: destino, nota: nota.value.trim() || undefined, version: ot.version };
      if (modo === 'etiqueta') body.etiqueta = sel.value || null;
      if (modo === 'tecnico' && sel.value) body.tecnico_id = Number(sel.value);
      if (forzar) body.forzar = true;
      try {
        await api(`/api/ot/${ot.id}/estado`, { method: 'POST', body });
        toast(`${ot.numero} → ${d.nombre}`, 'ok');
        hecho = true;
        cerrarModal(nodo);
        if (alTerminar) alTerminar();
        resolver(true);
      } catch (e) {
        boton.disabled = false;
        if (e.status === 422 && e.datos && e.datos.puede_forzar && !forzar) {
          forzar = true;
          boton.textContent = `Forzar: ${d.nombre}`;
          aviso(avisos, `${e.message}. Si aun así hay que darla por terminada, pulsa "Forzar": quedará anotado en el historial.`, 'error');
          return;
        }
        mostrarErrorAccion(e, avisos);
        if (e.status === 409 || e.status === 403) { hecho = true; cerrarModal(nodo); if (contenedorAvisos) mostrarErrorAccion(e, contenedorAvisos); resolver(false); }
      }
    };
    abrirModal(nodo);
    const obs = new MutationObserver(() => { if (!nodo.isConnected) { obs.disconnect(); if (!hecho) resolver(false); } });
    obs.observe(document.getElementById('modales'), { childList: true });
  });
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
  planificador: { titulo: 'Planificador', visible: () => puede('planificador.ver'), pintar: pintarPlanificador },
  kanban: { titulo: 'Tablero', visible: () => puede('kanban.ver'), pintar: pintarKanban },
  midia: { titulo: 'Mi día', visible: () => S.sesion.alcance === 'asignadas', pintar: pintarMiDia },
  horas: { titulo: 'Mis horas', visible: () => S.sesion.alcance === 'asignadas', pintar: () => { S.horas.tecnicoId = null; pintarHoras(); } },
  listado: { titulo: 'Listado', visible: () => puede('ot.ver'), pintar: pintarListado },
  fichajes: { titulo: 'Fichajes', visible: () => puede('fichajes.ver') && S.sesion.alcance !== 'asignadas', pintar: pintarFichajes },
  // Maestros: roles de oficina con clientes.ver / maquinas.ver; no en la tablet del técnico/SAT.
  clientes: { titulo: 'Clientes', grupo: 'Maestros', visible: () => puede('clientes.ver') && S.sesion.alcance !== 'asignadas', pintar: pintarClientes },
  maquinas: { titulo: 'Máquinas', grupo: 'Maestros', visible: () => puede('maquinas.ver') && S.sesion.alcance !== 'asignadas', pintar: pintarMaquinas },
  usuarios: { titulo: 'Usuarios', visible: () => puede('usuarios.gestionar'), pintar: pintarUsuarios },
};

function vistaPorDefecto() {
  if (S.sesion.alcance === 'asignadas') return 'midia';
  // Home por rol (F4-02): quien reparte el trabajo (responsable, operativo) y gerencia entran en el Planificador;
  // administración y recambista, en el Tablero (cada uno con su vertical resaltada); comerciales, en el Listado.
  if (['responsable_st', 'operativo', 'gerencia'].includes(S.sesion.usuario.rol) && puede('planificador.ver')) return 'planificador';
  if (['administrativo', 'recambista'].includes(S.sesion.usuario.rol) && puede('kanban.ver')) return 'kanban';
  return 'listado';
}

function pintarCabecera() {
  $('#usuario-nombre').textContent = S.sesion.usuario.nombre;
  $('#usuario-rol').textContent = S.sesion.rol;
  const nav = $('#nav');
  nav.innerHTML = '';
  const menus = new Map();
  const botonVista = (nombre, titulo) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.vista = nombre;
    b.textContent = titulo;
    b.onclick = () => { cerrarMenus(); location.hash = nombre; };
    return b;
  };
  for (const [nombre, v] of Object.entries(VISTAS)) {
    if (!v.visible()) continue;
    if (!v.grupo) { nav.append(botonVista(nombre, v.titulo)); continue; }
    // Vistas agrupadas (F3-02): un desplegable por grupo, p. ej. "Maestros" con Clientes y Máquinas.
    if (!menus.has(v.grupo)) {
      const menu = document.createElement('div');
      menu.className = 'menu';
      menu.dataset.grupo = v.grupo;
      menu.innerHTML = `<button type="button" class="menu-boton" aria-haspopup="true" aria-expanded="false">${esc(v.grupo)} <span class="flecha">▾</span></button><div class="menu-lista" role="menu"></div>`;
      $('.menu-boton', menu).onclick = (e) => { e.stopPropagation(); alternarMenu(menu); };
      nav.append(menu);
      menus.set(v.grupo, menu);
    }
    $('.menu-lista', menus.get(v.grupo)).append(botonVista(nombre, v.titulo));
  }
  // F3.5-03: sincronización manual con Karve, al final del desplegable Maestros (administrativo y responsable_st).
  if (menus.has('Maestros') && puede('karve.sincronizar')) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.accion = 'sincronizar-karve';
    b.className = 'menu-extra';
    b.textContent = '⟳ Sincronizar Karve';
    b.onclick = () => { cerrarMenus(); sincronizarKarve(); };
    $('.menu-lista', menus.get('Maestros')).append(b);
  }
}

// Lanza la sincronización con Karve (clientes, contactos y máquinas) y muestra el resumen.
async function sincronizarKarve() {
  const r = await elegir('¿Sincronizar clientes, contactos y máquinas desde Karve? Karve manda en los datos que trae; lo rellenado a mano se conserva. Puede tardar unos segundos.', [{ etiqueta: 'Sincronizar', valor: 1 }]);
  if (!r) return;
  const aviso = toast('Sincronizando con Karve…', 'aviso');
  let resumen;
  try {
    resumen = await api('/api/karve/sincronizar', { method: 'POST', body: {} });
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    return;
  } finally {
    if (aviso && aviso.remove) aviso.remove();
  }
  const nodo = tpl('tpl-karve');
  const fila = (n, x) => `<div><span>${n}</span>${x.nuevos} nuevos · ${x.actualizados} actualizados · ${x.sin_cambios} sin cambios<br><small class="suave">${x.leidos} leídos en Karve</small></div>`;
  ref('resumen', nodo).innerHTML = `
    ${fila('Clientes', resumen.clientes)}
    ${fila('Contactos', resumen.contactos)}
    ${fila('Máquinas', resumen.maquinas)}
    <div><span>Duración</span>${(resumen.duracion_ms / 1000).toFixed(1)} s</div>`;
  const ul = ref('alertas', nodo);
  if (!resumen.avisos.length) ref('bloque-alertas', nodo).classList.add('oculto');
  for (const a of resumen.avisos) ul.insertAdjacentHTML('beforeend', `<li><span>${esc(a)}</span></li>`);
  abrirModal(nodo);
  toast(`Karve: ${resumen.clientes.nuevos + resumen.maquinas.nuevos} altas y ${resumen.clientes.actualizados + resumen.maquinas.actualizados} cambios`, 'ok');
  refrescarVista();
}

// Desplegables de la cabecera: la lista va en position:fixed para que el scroll horizontal del nav no la recorte.
function alternarMenu(menu) {
  const abrir = !menu.classList.contains('abierto');
  cerrarMenus();
  if (!abrir) return;
  menu.classList.add('abierto');
  const boton = $('.menu-boton', menu);
  boton.setAttribute('aria-expanded', 'true');
  boton.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // en pantallas estrechas el nav se desplaza y el botón puede quedar fuera
  const r = boton.getBoundingClientRect();
  const lista = $('.menu-lista', menu);
  lista.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - lista.offsetWidth - 8)))}px`; // siempre dentro de la pantalla
  lista.style.top = `${Math.round(r.bottom + 6)}px`;
}
function cerrarMenus() {
  for (const m of $$('#nav .menu.abierto')) { m.classList.remove('abierto'); $('.menu-boton', m).setAttribute('aria-expanded', 'false'); }
}
document.addEventListener('click', (e) => { if (!e.target.closest('#nav .menu')) cerrarMenus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cerrarMenus(); });

function mostrarVista(nombre) {
  if (!VISTAS[nombre] || !VISTAS[nombre].visible()) nombre = vistaPorDefecto();
  pararPolling();
  pararPollingPlan();
  pararTecnico();
  S.vista = nombre;
  for (const b of $$('#nav button[data-vista]')) b.classList.toggle('activo', b.dataset.vista === nombre);
  for (const m of $$('#nav .menu')) m.classList.toggle('activo', !!$(`button[data-vista="${nombre}"]`, m));
  app.innerHTML = '';
  // Las plantillas de vista tienen varios hijos de primer nivel: se clona el fragmento entero.
  app.append(document.getElementById(`tpl-${nombre}`).content.cloneNode(true));
  app.classList.remove('entra'); void app.offsetWidth; app.classList.add('entra'); // reinicia la animación
  aplicarPermisos(app);
  for (const b of $$('[data-accion="nueva"]', app)) b.onclick = abrirNuevaOT;
  VISTAS[nombre].pintar();
  refrescarContadorFichajes();
}

// Rutas por hash: #kanban | #midia | #listado | #ot/123 (detalle sobre la vista actual) | #trabajo/123 (ficha de trabajo del técnico)
// | #horas (las del técnico) | #horas/12 (las de un técnico, para la oficina) | #fichajes
function enrutar() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^ot\/(\d+)$/);
  if (m) {
    if (!S.vista) mostrarVista(vistaPorDefecto());
    abrirDetalle(Number(m[1]));
    return;
  }
  const t = h.match(/^trabajo\/(\d+)$/);
  if (t) { mostrarTrabajo(Number(t[1])); return; }
  const hh = h.match(/^horas\/(\d+)$/);
  if (hh) { mostrarHorasDe(Number(hh[1])); return; }
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
    S.etiquetas = estados.etiquetas || [];
    S.etiquetaPor = Object.fromEntries(S.etiquetas.map((t) => [t.codigo, t]));
    S.flujo = estados.flujo || S.flujo;
  } catch (e) {
    if (e.status !== 401) app.innerHTML = `<div class="vacio">No se ha podido cargar la aplicación: ${esc(e.message)}</div>`;
    return;
  }
  pintarCabecera();
  window.addEventListener('hashchange', enrutar);
  document.addEventListener('visibilitychange', () => {
    if (S.vista === 'planificador' && !document.hidden) recargarPlan(false);
    if (S.vista === 'midia' && !document.hidden) cargarMiDia(false);
    if (S.vista === 'trabajo' && !document.hidden) cargarTrabajo();
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
  // Filtros (se aplican en el navegador sobre los datos del polling): operario, zona, etiqueta, prioridad, texto y "solo mi vertical".
  const form = ref('filtros', app);
  const selEt = ref('f-etiqueta', form);
  for (const e of S.estados) {
    const lista = etiquetasDe(e.codigo);
    if (!lista.length) continue;
    const grupo = document.createElement('optgroup');
    grupo.label = e.nombre;
    for (const t of lista) grupo.insertAdjacentHTML('beforeend', `<option value="${esc(t.codigo)}">${esc(t.nombre)}</option>`);
    selEt.append(grupo);
  }
  selEt.insertAdjacentHTML('beforeend', '<option value="-">Sin etiqueta</option>');
  const selTec = ref('f-tecnico', form);
  selTec.insertAdjacentHTML('beforeend', '<option value="-">Sin técnico</option>');
  cargarTecnicos().then((ts) => { for (const t of ts) selTec.insertAdjacentHTML('beforeend', `<option value="${t.id}">${esc(t.nombre)}</option>`); if (S.tablero.filtros.tecnico) selTec.value = S.tablero.filtros.tecnico; }).catch(() => {});
  if (!S.estados.some((e) => esMiVertical(e.codigo))) ref('f-vertical', form).closest('div').classList.add('oculto');
  for (const [k, v] of Object.entries(S.tablero.filtros)) if (form.elements[k]) form.elements[k].value = v;
  const aplicar = () => { S.tablero.filtros = Object.fromEntries(new FormData(form)); pintarColumnas(); };
  let temporizador = null;
  form.oninput = (e) => { if (e.target.name === 'q') { clearTimeout(temporizador); temporizador = setTimeout(aplicar, 200); } else aplicar(); };
  form.onsubmit = (e) => { e.preventDefault(); aplicar(); };
  $('[data-accion="limpiar-filtros"]', form).onclick = () => { form.reset(); aplicar(); };

  const cont = ref('columnas', app);
  cont.innerHTML = '';
  for (const f of S.fases) {
    if (!f.abierta && !DIAS_CERRADAS) continue; // F4-04: las cerradas no se muestran
    const col = document.createElement('div');
    col.className = 'columna';
    col.dataset.fase = f.codigo;
    if (!f.abierta) col.classList.add('cerradas');
    const mia = esMiVertical(f.codigo);
    if (mia) col.classList.add('mia');
    col.innerHTML = `<h3><span class="titulo-col">${esc(f.nombre)}${mia ? ' <small class="mia-marca" title="Tu rol es responsable de esta vertical">tu vertical</small>' : ''}</span><span data-ref="n">0</span>${f.abierta ? '' : `<small>últimos ${DIAS_CERRADAS} días</small>`}</h3><div class="cuerpo" data-ref="cuerpo"></div>`;
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
    const datos = await api(`/api/kanban?cerradas=${DIAS_CERRADAS}`, { headers: S.kanban.etag ? { 'If-None-Match': S.kanban.etag } : {} });
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

function pasaFiltros(o) {
  const f = S.tablero.filtros;
  if (f.q) {
    const txt = `${o.numero} ${o.cliente_nombre} ${textoMaquina(o)} ${o.sintoma || ''} ${nombreTecnico(o)} ${o.karve_estado || ''}`.toLowerCase();
    if (!txt.includes(f.q.toLowerCase())) return false;
  }
  if (f.tecnico && (f.tecnico === '-' ? o.tecnico_id : String(o.tecnico_id) !== f.tecnico)) return false;
  if (f.zona && (o.cliente_zona || '') !== f.zona) return false;
  if (f.etiqueta && (f.etiqueta === '-' ? o.etiqueta : o.etiqueta !== f.etiqueta)) return false;
  if (f.prioridad && String(o.prioridad) !== f.prioridad) return false;
  return true;
}

function pintarColumnas() {
  const datos = S.kanban.datos;
  if (!datos || S.vista !== 'kanban') return;
  const f = S.tablero.filtros;
  const selZona = ref('f-zona', app);
  if (selZona && selZona.options.length <= 1) {
    const zonas = [...new Set(datos.fases.flatMap((fa) => fa.ots.map((o) => o.cliente_zona)).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es'));
    for (const z of zonas) selZona.insertAdjacentHTML('beforeend', `<option value="${esc(z)}">${esc(z)}</option>`);
    if (f.zona) selZona.value = f.zona;
  }
  const soloMias = f.vertical === 'mias';
  const cerradas = datos.fases.filter((fa) => !fa.abierta).reduce((n, fa) => n + fa.ots.length, 0);
  let visibles = 0, urgentes = 0;
  for (const fa of datos.fases) {
    const col = $(`.columna[data-fase="${fa.codigo}"]`, app);
    if (!col) continue;
    const ocultar = soloMias && !esMiVertical(fa.codigo);
    col.classList.toggle('oculto', ocultar);
    const lista = fa.ots.filter(pasaFiltros);
    ref('n', col).textContent = lista.length === fa.ots.length ? String(fa.ots.length) : `${lista.length}/${fa.ots.length}`;
    const cuerpo = ref('cuerpo', col);
    cuerpo.innerHTML = '';
    for (const o of lista) cuerpo.append(tarjetaKanban(o));
    if (!ocultar) { visibles += lista.length; urgentes += lista.filter((o) => o.prioridad === 1).length; }
  }
  const cont = ref('contador', app);
  if (cont) {
    const abiertas = datos.total - cerradas;
    cont.textContent = `${abiertas} O.T. abiertas${visibles !== abiertas ? ` · ${visibles} en pantalla` : ''}${urgentes ? ` · ${urgentes} urgentes` : ''}${cerradas ? ` · ${cerradas} cerradas en ${datos.dias_cerradas} días` : ''} · ${fecha(datos.generado)}`;
  }
}

function tarjetaKanban(o) {
  const el = document.createElement('div');
  el.className = `tarjeta${o.prioridad === 1 ? ' urgente' : ''}`;
  el.dataset.id = o.id;
  el.style.borderLeftColor = (S.estadoPor[o.estado] || {}).color || '#6b7280';
  el.innerHTML = `
    <div class="num">${chipPrioridad(o.prioridad)}${esc(o.numero)} <small>${o.prioridad === 1 ? '<span class="urgente-texto">Urgente</span> · ' : ''}${esc(o.tipo)}${o.karve_estado ? ' · ' + esc(o.karve_estado) : ''}</small></div>
    <div class="cliente">${esc(o.cliente_nombre)}${o.cliente_zona ? ` <small class="zona">${esc(o.cliente_zona)}</small>` : ''}</div>
    ${o.maquina_id ? `<div class="maquina">${esc(textoMaquina(o))}</div>` : ''}
    ${o.sintoma ? `<div class="sintoma" title="${esc(o.sintoma)}">${esc(o.sintoma)}</div>` : ''}
    ${o.etiqueta ? `<div class="etiquetas">${chipEtiqueta(o)}</div>` : ''}
    ${nombreTecnico(o) ? `<div class="tecnico">${esc(nombreTecnico(o))}</div>` : ''}
    ${o.crono_tipo && FASES[o.crono_tipo] ? `<div><span class="dato-chip fase-${esc(o.crono_tipo)}" title="Cronómetro en marcha">${FASES[o.crono_tipo].icono} ${esc(FASES[o.crono_tipo].nombre)} desde las ${esc(horaCorta(o.crono_inicio))}</span></div>` : ''}
    ${o.proximo_bloque
      ? `<div class="prevista proximo">📅 ${esc(fecha(o.proximo_bloque))}${o.proximo_tecnico ? ' · ' + esc(o.proximo_tecnico) : ''}${o.bloques_futuros > 1 ? ` <b title="Bloques planificados">+${o.bloques_futuros - 1}</b>` : ''}</div>`
      : (o.fecha_prevista ? `<div class="prevista">Prevista ${esc(fecha(o.fecha_prevista))}</div>` : '')}`;
  el.onclick = () => abrirDetalle(o.id);
  if (destinosDesde(o).length) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(o.id));
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('agarrada');                                 // así se captura la imagen de arrastre
      setTimeout(() => { el.classList.remove('agarrada'); el.classList.add('arrastrando'); }, 0); // y el hueco queda atenuado
      marcarColumnasDestino(o);
    });
    el.addEventListener('dragend', () => { el.classList.remove('agarrada', 'arrastrando'); desmarcarColumnas(); });
  }
  return el;
}

function otDelKanban(id) {
  for (const f of (S.kanban.datos?.fases || [])) for (const o of f.ots) if (o.id === id) return o;
  return null;
}

function marcarColumnasDestino(o) {
  const destinos = destinosDesde(o);
  for (const col of $$('.columna', app)) {
    if (col.dataset.fase === o.fase) continue;
    col.classList.add(destinos.some((d) => d.fase === col.dataset.fase) ? 'destino-ok' : 'destino-no');
  }
}

function desmarcarColumnas() {
  for (const col of $$('.columna', app)) col.classList.remove('destino-ok', 'destino-no');
}

// Soltar una tarjeta en otra vertical abre el modal de dos preguntas; la tarjeta solo se mueve si el servidor confirma.
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
    const candidatos = destinosDesde(o).filter((d) => d.fase === fase);
    if (!candidatos.length) { toast('Tu rol no puede mover esta O.T. a esa vertical', 'error'); return; }
    const ok = await abrirCambioEstado(o, candidatos[0].codigo);
    S.kanban.etag = null;
    if (ok) { const tarjeta = $(`.tarjeta[data-id="${id}"]`, app); if (tarjeta) ref('cuerpo', col).prepend(tarjeta); }
    cargarKanban();
  });
}

// ---------------------------------------------------------------------------
// Vista: Planificador (F4-02 + F4-03). Calendario Día / Semana con bloques por técnico y bandeja de O.T. sin planificar.
// El Tablero dice en qué punto está cada O.T. y por qué; el Planificador, quién la hace y cuándo. Aquí el estado solo se
// mueve entre "pendiente de planificar" y "planificada" (lo decide el servidor al crear o quitar bloques).
// ---------------------------------------------------------------------------
const PLAN_POLLING_MS = 15000;
const PX_HORA = 56;                 // alto de una hora en la vista Día
const PASO_MIN = 15;                // el arrastre se ajusta a cuartos de hora
const DURACIONES = [30, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480];
const DIAS_SEMANA = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const PROPUESTAS = { repuesto: 'Repuesto recibido', presupuesto: 'Presupuesto aceptado', ok_presupuesto: 'Presupuesto aceptado', num_pedido: 'Nº de pedido recibido', espera_cliente: 'Cliente disponible' };

const dosDigitos = (n) => String(n).padStart(2, '0');
const fechaLocal = (iso) => { const [a, m, d] = iso.split('-').map(Number); return new Date(a, m - 1, d); };
const isoDe = (f) => `${f.getFullYear()}-${dosDigitos(f.getMonth() + 1)}-${dosDigitos(f.getDate())}`;
const hoyISO = () => isoDe(new Date());
const sumarDias = (iso, n) => { const f = fechaLocal(iso); f.setDate(f.getDate() + n); return isoDe(f); };
const lunesDe = (iso) => sumarDias(iso, -((fechaLocal(iso).getDay() + 6) % 7));
const diaLargo = (iso) => { const t = fechaLocal(iso).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); return t.charAt(0).toUpperCase() + t.slice(1); };
const minutosDe = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const horaDe = (min) => `${dosDigitos(Math.floor(min / 60))}:${dosDigitos(min % 60)}`;
const textoDuracion = (min) => `${(min / 60).toLocaleString('es-ES', { maximumFractionDigits: 2 })} h`;
const textoPropuesta = (o) => (o.propuesta ? (PROPUESTAS[o.propuesta] || 'Lista para planificar') : '');

function rangoPlan() {
  if (S.plan.modo === 'semana') { const lunes = lunesDe(S.plan.fecha); return [lunes, sumarDias(lunes, 6)]; }
  return [S.plan.fecha, S.plan.fecha];
}

function pararPollingPlan() {
  if (S.plan.timer) clearInterval(S.plan.timer);
  S.plan.timer = null;
}

function pintarPlanificador() {
  if (!S.plan.fecha) S.plan.fecha = hoyISO();
  const mover = (n) => { S.plan.fecha = sumarDias(S.plan.fecha, n * (S.plan.modo === 'semana' ? 7 : 1)); recargarPlan(true); };
  $('[data-accion="anterior"]', app).onclick = () => mover(-1);
  $('[data-accion="siguiente"]', app).onclick = () => mover(1);
  $('[data-accion="hoy"]', app).onclick = () => { S.plan.fecha = hoyISO(); recargarPlan(true); };
  $('[data-accion="recargar"]', app).onclick = () => recargarPlan(true);
  const inputFecha = ref('fecha', app);
  inputFecha.onchange = () => { if (inputFecha.value) { S.plan.fecha = inputFecha.value; recargarPlan(true); } };
  for (const b of $$('[data-modo]', app)) b.onclick = () => { S.plan.modo = b.dataset.modo; recargarPlan(true); };

  const form = ref('filtros-bandeja', app);
  const f = S.plan.filtros;
  form.elements.q.value = f.q || '';
  form.elements.agrupar.value = f.agrupar || '';
  form.elements.pausadas.checked = !!f.pausadas;
  let temporizador = null;
  form.oninput = (e) => {
    S.plan.filtros = { q: form.elements.q.value, zona: form.elements.zona.value, agrupar: form.elements.agrupar.value, pausadas: form.elements.pausadas.checked };
    if (e.target.name === 'pausadas') recargarPlan(true);
    else if (e.target.name === 'q') { clearTimeout(temporizador); temporizador = setTimeout(pintarBandeja, 200); }
    else pintarBandeja();
  };
  form.onsubmit = (e) => e.preventDefault();
  if (puede('planificador.editar')) prepararSoltarBandeja(ref('lista-bandeja', app));
  S.plan.datos = null;
  recargarPlan(true);
  pararPollingPlan();
  S.plan.timer = setInterval(() => recargarPlan(false), PLAN_POLLING_MS);
}

// forzar = true: lo pide el usuario o acaba de cambiar algo (ignora el ETag). El polling no repinta bajo un arrastre o un modal.
async function recargarPlan(forzar) {
  if (S.vista !== 'planificador') return;
  if (S.plan.cargando) { if (forzar) S.plan.pendiente = true; return; }
  if (!forzar && (document.hidden || S.plan.arrastre || S.plan.redimension || $('#modales .modal-fondo'))) return;
  S.plan.cargando = true;
  if (forzar) S.plan.etag = null;
  const [desde, hasta] = rangoPlan();
  try {
    const datos = await api(`/api/planificador?desde=${desde}&hasta=${hasta}${S.plan.filtros.pausadas ? '&pausadas=1' : ''}`, { headers: S.plan.etag ? { 'If-None-Match': S.plan.etag } : {} });
    if (!datos._304) {
      S.plan.etag = datos._etag;
      S.plan.datos = datos;
      pintarPlan();
    }
  } catch (e) {
    if (e.status !== 401) toast(`Planificador: ${e.message}`, 'error');
  } finally {
    S.plan.cargando = false;
    if (S.plan.pendiente) { S.plan.pendiente = false; recargarPlan(true); }
  }
}

function indiceAvisos(d) {
  const por = new Map();
  for (const a of d.avisos) { const k = `${a.tecnico_id}|${a.dia}`; if (!por.has(k)) por.set(k, []); por.get(k).push(a); }
  return { por, ids: new Set(d.avisos.flatMap((a) => a.bloques)) };
}

function chipsAviso(lista) {
  const nombre = { horas: 'horas', zonas: 'zonas', solape: 'solape' };
  return lista.map((a) => `<span class="chip chip-aviso" data-aviso="${esc(a.tipo)}" title="${esc(a.texto)}">⚠ ${nombre[a.tipo] || esc(a.tipo)}</span>`).join(' ');
}

function pintarPlan() {
  const d = S.plan.datos;
  if (!d || S.vista !== 'planificador') return;
  ref('fecha', app).value = S.plan.fecha;
  for (const b of $$('[data-modo]', app)) b.classList.toggle('activo', b.dataset.modo === S.plan.modo);
  ref('titulo-rango', app).textContent = S.plan.modo === 'semana' ? `Semana del ${fecha(d.desde)} al ${fecha(d.hasta)}` : diaLargo(d.desde);
  const total = d.bloques.reduce((n, b) => n + b.duracion_min, 0);
  ref('contador', app).textContent = `${d.bloques.length} bloque${d.bloques.length === 1 ? '' : 's'} · ${textoDuracion(total)}${d.avisos.length ? ` · ${d.avisos.length} aviso${d.avisos.length === 1 ? '' : 's'}` : ''}`;
  pintarBandeja();
  const cal = ref('calendario', app);
  const [arriba, izquierda] = [cal.scrollTop, cal.scrollLeft];
  cal.innerHTML = '';
  if (!d.tecnicos.length) {
    cal.innerHTML = '<div class="vacio">No hay técnicos activos. Crea en Usuarios los técnicos internos y los SAT externos (con su código de operario de Karve) y aparecerá una columna por cada uno.</div>';
    return;
  }
  if (S.plan.modo === 'semana') pintarSemana(cal, d); else pintarDia(cal, d);
  cal.scrollTop = arriba;
  cal.scrollLeft = izquierda;
}

// --- Bandeja -------------------------------------------------------------------------------------------------------------
function pintarBandeja() {
  const d = S.plan.datos;
  if (!d || S.vista !== 'planificador') return;
  const f = S.plan.filtros;
  const selZona = ref('b-zona', app);
  if (selZona.options.length <= 1) {
    const zonas = [...new Set(d.bandeja.map((o) => o.cliente_zona).filter(Boolean))].sort((x, y) => x.localeCompare(y, 'es'));
    for (const z of zonas) selZona.insertAdjacentHTML('beforeend', `<option value="${esc(z)}">${esc(z)}</option>`);
    if (f.zona) selZona.value = f.zona;
  }
  const q = (f.q || '').toLowerCase();
  const lista = d.bandeja.filter((o) => (!q || `${o.numero} ${o.cliente_nombre} ${textoMaquina(o)} ${o.sintoma || ''} ${o.karve_operario || ''}`.toLowerCase().includes(q)) && (!f.zona || (o.cliente_zona || '') === f.zona));
  ref('n-bandeja', app).textContent = lista.length === d.bandeja_total ? String(d.bandeja_total) : `${lista.length}/${d.bandeja_total}`;
  const cont = ref('lista-bandeja', app);
  const arriba = cont.scrollTop;
  cont.innerHTML = '';
  if (!lista.length) { cont.innerHTML = '<div class="vacio">Nada pendiente de planificar.</div>'; return; }
  const porCliente = {};
  for (const o of d.bandeja) porCliente[o.cliente_id] = (porCliente[o.cliente_id] || 0) + 1;
  const titulo = (t, n) => cont.insertAdjacentHTML('beforeend', `<div class="bandeja-grupo">${esc(t)} <span>${n}</span></div>`);
  const propuestas = lista.filter((o) => o.propuesta);
  const resto = lista.filter((o) => !o.propuesta);
  if (propuestas.length) { titulo('Listas para planificar', propuestas.length); for (const o of propuestas) cont.append(tarjetaBandeja(o, porCliente)); }
  if (f.agrupar) {
    const clave = (o) => (f.agrupar === 'zona' ? (o.cliente_zona || 'Sin zona') : o.cliente_nombre);
    const grupos = new Map();
    for (const o of resto) { const k = clave(o); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(o); }
    for (const [k, os] of [...grupos.entries()].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0], 'es'))) { titulo(k, os.length); for (const o of os) cont.append(tarjetaBandeja(o, porCliente)); }
  } else {
    if (propuestas.length && resto.length) titulo('Resto', resto.length);
    for (const o of resto) cont.append(tarjetaBandeja(o, porCliente));
  }
  if (d.bandeja_total > d.bandeja.length) cont.insertAdjacentHTML('beforeend', `<div class="pista">Se muestran las ${d.bandeja.length} primeras de ${d.bandeja_total}. Usa el buscador o la zona para acotar.</div>`);
  cont.scrollTop = arriba;
}

function tarjetaBandeja(o, porCliente) {
  const el = document.createElement('div');
  el.className = `tarjeta tarjeta-bandeja${o.prioridad === 1 ? ' urgente' : ''}${o.propuesta ? ' propuesta' : ''}`;
  el.dataset.id = o.id;
  el.style.borderLeftColor = o.estado_color || '#6b7280';
  const otras = (porCliente[o.cliente_id] || 1) - 1;
  const karve = [o.fecha_prevista ? `Prevista ${fecha(o.fecha_prevista)}` : '', o.karve_operario ? `${o.karve_operario} (Karve)` : ''].filter(Boolean).join(' · ');
  el.innerHTML = `
    <div class="num">${chipPrioridad(o.prioridad)}${esc(o.numero)} <small>${o.prioridad === 1 ? '<span class="urgente-texto">Urgente</span> · ' : ''}${esc(o.tipo)}</small></div>
    <div class="cliente">${esc(o.cliente_nombre)}${o.cliente_zona ? ` <small class="zona">${esc(o.cliente_zona)}</small>` : ''}</div>
    ${o.maquina_id ? `<div class="maquina">${esc(textoMaquina(o))}</div>` : ''}
    ${o.sintoma ? `<div class="sintoma" title="${esc(o.sintoma)}">${esc(o.sintoma)}</div>` : ''}
    <div class="etiquetas">${o.propuesta ? `<span class="chip chip-ok" data-propuesta="${esc(o.propuesta)}">${esc(textoPropuesta(o))}</span>` : ''}${o.estado !== 'pendiente_planificar' ? chipEstado(o) : ''}${chipEtiqueta(o)}${o.bloque_vencido ? '<span class="chip chip-claro" title="Su último bloque ya pasó y la O.T. sigue abierta">bloque vencido</span>' : ''}</div>
    ${o.propuesta && otras > 0 ? `<div class="prevista">+${otras} O.T. del mismo cliente en la bandeja</div>` : ''}
    ${karve ? `<div class="prevista">${esc(karve)}</div>` : ''}`;
  el.onclick = () => abrirDetalle(o.id);
  if (puede('planificador.editar')) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', `ot:${o.id}`); e.dataTransfer.effectAllowed = 'move'; }
      S.plan.arrastre = { tipo: 'ot', ot: o, duracion: (S.plan.datos && S.plan.datos.duracion_defecto) || 120, desfase: 0 };
      setTimeout(() => el.classList.add('arrastrando'), 0);
      document.body.classList.add('plan-arrastrando');
    });
    el.addEventListener('dragend', () => finArrastrePlan(el));
  }
  return el;
}

function finArrastrePlan(el) {
  if (el) el.classList.remove('arrastrando');
  S.plan.arrastre = null;
  document.body.classList.remove('plan-arrastrando');
  quitarSombra();
  for (const z of $$('.soltar-aqui', app)) z.classList.remove('soltar-aqui');
}

function quitarSombra() { for (const s of $$('.plan-sombra', app)) s.remove(); }

// Soltar un bloque del calendario sobre la bandeja = quitarlo (con confirmación).
function prepararSoltarBandeja(lista) {
  lista.addEventListener('dragover', (e) => { const a = S.plan.arrastre; if (!a || a.tipo !== 'bloque') return; e.preventDefault(); lista.classList.add('soltar-aqui'); });
  lista.addEventListener('dragleave', (e) => { if (!lista.contains(e.relatedTarget)) lista.classList.remove('soltar-aqui'); });
  lista.addEventListener('drop', async (e) => {
    const a = S.plan.arrastre;
    if (!a || a.tipo !== 'bloque') return;
    e.preventDefault();
    finArrastrePlan(null);
    await quitarBloque(a.bloque);
  });
}

// --- Bloques ---------------------------------------------------------------------------------------------------------------
function elementoBloque(b, { conAviso = false, editable = false, compacto = false } = {}) {
  const el = document.createElement('div');
  const fin = minutosDe(b.hora_inicio) + b.duracion_min;
  el.className = `bloque${compacto ? ' compacto' : ''}${b.prioridad === 1 ? ' urgente' : ''}${b.fuera_alcance ? ' ajeno' : ''}${conAviso ? ' con-aviso' : ''}${b.dia < S.plan.datos.hoy ? ' pasado' : ''}`;
  el.dataset.bloque = b.id;
  el.dataset.ot = b.ot_id;
  el.style.borderLeftColor = b.estado_color || '#6b7280';
  el.title = `${b.numero} · ${b.cliente_nombre}${b.sintoma ? ' · ' + b.sintoma : ''}${b.nota ? ' · Nota: ' + b.nota : ''}${b.real_seg ? ' · Fichado: ' + duracionSeg(b.real_seg) : ''}${b.origen === 'karve' ? ' · Bloque automático (importación de Karve)' : ''}`;
  // F4-13 / F4-06: "auto" si lo puso la importación de Karve; punto latiendo si la O.T. tiene el cronómetro en marcha.
  const marcas = `${b.origen === 'karve' ? '<span class="b-auto">auto</span>' : ''}${b.crono_tipo && FASES[b.crono_tipo] ? `<span class="crono-punto fase-${esc(b.crono_tipo)}" title="Cronómetro en marcha: ${esc(FASES[b.crono_tipo].nombre)}"></span>` : ''}`;
  el.innerHTML = compacto
    ? `<span class="b-hora">${b.hora_inicio} · ${textoDuracion(b.duracion_min)}${marcas}</span><b class="b-num">${esc(b.numero)}</b><span class="b-cliente">${esc(b.cliente_nombre)}</span>${b.cliente_zona ? `<small class="zona">${esc(b.cliente_zona)}</small>` : ''}`
    : `<div class="b-hora">${b.hora_inicio}–${horaDe(fin)} · ${textoDuracion(b.duracion_min)}${b.prioridad === 1 ? ' · <span class="urgente-texto">Urgente</span>' : ''}${marcas}</div>
       <div class="b-num">${esc(b.numero)}${b.estado !== 'planificada' ? ` <small>${esc(b.estado_nombre)}</small>` : ''}</div>
       <div class="b-cliente">${esc(b.cliente_nombre)}${b.cliente_zona ? ` <small class="zona">${esc(b.cliente_zona)}</small>` : ''}</div>
       ${b.maquina_id ? `<div class="b-maquina">${esc(textoMaquina(b))}</div>` : ''}
       ${b.etiqueta ? chipEtiqueta(b) : ''}${b.nota ? `<div class="b-nota">${esc(b.nota)}</div>` : ''}`;
  el.onclick = () => { if (!S.plan.recienArrastrado) abrirBloque({ bloque: b }); };
  if (editable && !b.fuera_alcance) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      if (S.plan.redimension) { e.preventDefault(); return; }
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', `bloque:${b.id}`); e.dataTransfer.effectAllowed = 'move'; }
      const r = el.getBoundingClientRect();
      S.plan.arrastre = { tipo: 'bloque', bloque: b, duracion: b.duracion_min, desfase: compacto ? 0 : Math.max(0, Math.round(((e.clientY - r.top) / PX_HORA) * 60)) };
      setTimeout(() => el.classList.add('arrastrando'), 0);
      document.body.classList.add('plan-arrastrando');
    });
    el.addEventListener('dragend', () => finArrastrePlan(el));
  }
  return el;
}

// Bloques que se pisan en la misma columna: se reparten en carriles para que se vean todos.
function repartirCarriles(bloques) {
  const orden = [...bloques].sort((x, y) => minutosDe(x.hora_inicio) - minutosDe(y.hora_inicio) || x.id - y.id);
  const salida = [];
  let grupo = [];
  let finGrupo = -1;
  const cerrar = () => {
    const carriles = Math.max(...grupo.map((g) => g.carril)) + 1;
    for (const g of grupo) salida.push({ b: g.b, carril: g.carril, carriles });
    grupo = [];
    finGrupo = -1;
  };
  for (const b of orden) {
    const ini = minutosDe(b.hora_inicio);
    const fin = ini + b.duracion_min;
    if (grupo.length && ini >= finGrupo) cerrar();
    const ocupados = new Set(grupo.filter((g) => g.fin > ini).map((g) => g.carril));
    let carril = 0;
    while (ocupados.has(carril)) carril++;
    grupo.push({ b, carril, fin });
    finGrupo = Math.max(finGrupo, fin);
  }
  if (grupo.length) cerrar();
  return salida;
}

// Tirador inferior del bloque (vista Día): alarga o acorta en tramos de 15 minutos.
function ponerTirador(el, b) {
  const t = document.createElement('div');
  t.className = 'b-tirador';
  t.title = 'Arrastra para cambiar la duración';
  t.addEventListener('mousedown', (e) => e.preventDefault()); // que no empiece el arrastre del bloque
  t.addEventListener('click', (e) => e.stopPropagation());
  t.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    S.plan.redimension = true;
    const arriba = el.getBoundingClientRect().top;
    const inicio = minutosDe(b.hora_inicio);
    let dur = b.duracion_min;
    const mover = (ev) => {
      dur = Math.round((((ev.clientY - arriba) / PX_HORA) * 60) / PASO_MIN) * PASO_MIN;
      dur = Math.max(PASO_MIN, Math.min(dur, 24 * 60 - inicio, 720));
      el.style.height = `${(dur / 60) * PX_HORA - 2}px`;
      const h = $('.b-hora', el);
      if (h) h.textContent = `${b.hora_inicio}–${horaDe(inicio + dur)} · ${textoDuracion(dur)}`;
    };
    const soltar = async () => {
      document.removeEventListener('pointermove', mover);
      document.removeEventListener('pointerup', soltar);
      S.plan.recienArrastrado = true;
      setTimeout(() => { S.plan.recienArrastrado = false; }, 200);
      S.plan.redimension = false;
      if (dur !== b.duracion_min) await moverBloque(b, { duracion_min: dur }, `ahora dura ${textoDuracion(dur)}`);
    };
    document.addEventListener('pointermove', mover);
    document.addEventListener('pointerup', soltar);
  });
  el.append(t);
}

async function moverBloque(b, body, mensaje) {
  try {
    const r = await api(`/api/ot/${b.ot_id}/bloques/${b.id}`, { method: 'PUT', body });
    toast(`${b.numero}: ${mensaje}`, 'ok');
    for (const av of r.avisos || []) toast(av.texto, 'aviso');
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
  }
  recargarPlan(true);
}

async function quitarBloque(b) {
  const r = await elegir(`¿Quitar el bloque de ${b.numero} (${fecha(b.dia)} ${b.hora_inicio})? Si era su único bloque futuro, la O.T. vuelve a la bandeja.`, [{ etiqueta: 'Sí, quitar', valor: 1, color: '#dc2626' }]);
  if (!r) return false;
  try {
    await api(`/api/ot/${b.ot_id}/bloques/${b.id}`, { method: 'DELETE' });
    toast(`${b.numero}: bloque quitado`, 'ok');
    recargarPlan(true);
    return true;
  } catch (e) {
    if (e.status !== 401) toast(e.message, 'error');
    return false;
  }
}

// Lo que se suelta en el calendario: una O.T. de la bandeja (abre el mini-modal con la celda elegida) o un bloque (se mueve ya).
function soltarEnPlan(a, destino) {
  finArrastrePlan(null);
  if (a.tipo === 'ot') { abrirBloque({ ot: a.ot, ...destino }); return; }
  const b = a.bloque;
  const body = {};
  if (destino.tecnico_id !== b.tecnico_id) body.tecnico_id = destino.tecnico_id;
  if (destino.dia !== b.dia) body.dia = destino.dia;
  if (destino.hora_inicio && destino.hora_inicio !== b.hora_inicio) body.hora_inicio = destino.hora_inicio;
  if (!Object.keys(body).length) return;
  const tecnico = (S.plan.datos.tecnicos.find((t) => t.id === destino.tecnico_id) || {}).nombre || '';
  moverBloque(b, body, `movido al ${fecha(destino.dia)} ${destino.hora_inicio || b.hora_inicio}${tecnico ? ' · ' + tecnico : ''}`);
}

// --- Vista Día: una columna por técnico, eje de horas, alto proporcional a la duración ----------------------------------------
function minutoEnColumna(col, clientY) {
  const a = S.plan.arrastre;
  const r = col.getBoundingClientRect();
  let min = S.plan.vIni + ((clientY - r.top) / PX_HORA) * 60 - (a.desfase || 0);
  min = Math.round(min / PASO_MIN) * PASO_MIN;
  return Math.max(0, Math.min(24 * 60 - a.duracion, min));
}

function prepararSoltarColumna(col) {
  col.addEventListener('dragover', (e) => {
    const a = S.plan.arrastre;
    if (!a) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const min = minutoEnColumna(col, e.clientY);
    let s = $('.plan-sombra', col);
    if (!s) { quitarSombra(); s = document.createElement('div'); s.className = 'plan-sombra'; col.append(s); }
    s.style.top = `${((min - S.plan.vIni) / 60) * PX_HORA}px`;
    s.style.height = `${(a.duracion / 60) * PX_HORA - 2}px`;
    s.textContent = `${horaDe(min)}–${horaDe(min + a.duracion)}`;
  });
  col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) quitarSombra(); });
  col.addEventListener('drop', (e) => {
    const a = S.plan.arrastre;
    if (!a) return;
    e.preventDefault();
    soltarEnPlan(a, { tecnico_id: Number(col.dataset.tecnico), dia: col.dataset.dia, hora_inicio: horaDe(minutoEnColumna(col, e.clientY)) });
  });
}

function pintarDia(cal, d) {
  const dia = d.desde;
  const { por, ids } = indiceAvisos(d);
  const editable = puede('planificador.editar');
  // Rango visible: la jornada del .env, ampliada si hay bloques fuera de ella.
  let vIni = minutosDe(d.jornada.inicio);
  let vFin = minutosDe(d.jornada.fin);
  for (const b of d.bloques) {
    const ini = minutosDe(b.hora_inicio);
    vIni = Math.min(vIni, Math.floor(ini / 60) * 60);
    vFin = Math.max(vFin, Math.ceil((ini + b.duracion_min) / 60) * 60);
  }
  S.plan.vIni = vIni;
  const alto = ((vFin - vIni) / 60) * PX_HORA;
  const rejilla = document.createElement('div');
  rejilla.className = 'plan-dia';
  rejilla.style.gridTemplateColumns = `52px repeat(${d.tecnicos.length}, minmax(190px, 1fr))`;
  rejilla.insertAdjacentHTML('beforeend', '<div class="plan-esquina"></div>');
  for (const t of d.tecnicos) {
    const min = d.bloques.filter((b) => b.tecnico_id === t.id).reduce((n, b) => n + b.duracion_min, 0);
    const avisos = por.get(`${t.id}|${dia}`) || [];
    rejilla.insertAdjacentHTML('beforeend', `<div class="plan-cab${avisos.length ? ' con-aviso' : ''}" data-tecnico="${t.id}"><b>${esc(t.nombre)}</b>${t.rol === 'sat' ? ' <span class="chip chip-azul">SAT</span>' : ''}${t.inactivo ? ' <span class="chip chip-claro">de baja</span>' : ''}<div class="plan-carga${min > d.jornada.horas_dia * 60 ? ' sobre' : ''}">${textoDuracion(min)} / ${d.jornada.horas_dia} h ${chipsAviso(avisos)}</div></div>`);
  }
  const horas = document.createElement('div');
  horas.className = 'plan-horas';
  horas.style.height = `${alto}px`;
  for (let m = vIni; m < vFin; m += 60) horas.insertAdjacentHTML('beforeend', `<span style="top:${((m - vIni) / 60) * PX_HORA}px">${horaDe(m)}</span>`);
  rejilla.append(horas);
  const ahoraMin = new Date().getHours() * 60 + new Date().getMinutes();
  for (const t of d.tecnicos) {
    const col = document.createElement('div');
    col.className = 'plan-col';
    col.dataset.tecnico = t.id;
    col.dataset.dia = dia;
    col.style.height = `${alto}px`;
    col.style.backgroundSize = `100% ${PX_HORA}px`;
    for (const { b, carril, carriles } of repartirCarriles(d.bloques.filter((x) => x.tecnico_id === t.id))) {
      const el = elementoBloque(b, { conAviso: ids.has(b.id), editable });
      el.style.top = `${((minutosDe(b.hora_inicio) - vIni) / 60) * PX_HORA}px`;
      el.style.height = `${Math.max(20, (b.duracion_min / 60) * PX_HORA - 2)}px`;
      el.style.left = `calc(${(carril / carriles) * 100}% + 2px)`;
      el.style.width = `calc(${100 / carriles}% - 4px)`;
      if (editable && !b.fuera_alcance) ponerTirador(el, b);
      col.append(el);
    }
    if (dia === d.hoy && ahoraMin >= vIni && ahoraMin <= vFin) col.insertAdjacentHTML('beforeend', `<div class="plan-ahora" style="top:${((ahoraMin - vIni) / 60) * PX_HORA}px"></div>`);
    if (editable) prepararSoltarColumna(col);
    rejilla.append(col);
  }
  cal.append(rejilla);
}

// --- Vista Semana: una fila por técnico, una celda por día, tarjetas compactas -----------------------------------------------
function siguienteHueco(tecnicoId, dia) {
  const d = S.plan.datos;
  let fin = Math.max(minutosDe('08:00'), minutosDe(d.jornada.inicio));
  for (const b of d.bloques) if (b.tecnico_id === tecnicoId && b.dia === dia) fin = Math.max(fin, minutosDe(b.hora_inicio) + b.duracion_min);
  return horaDe(Math.min(fin, 24 * 60 - d.duracion_defecto));
}

function prepararSoltarCelda(td) {
  td.addEventListener('dragover', (e) => { if (!S.plan.arrastre) return; e.preventDefault(); td.classList.add('soltar-aqui'); });
  td.addEventListener('dragleave', (e) => { if (!td.contains(e.relatedTarget)) td.classList.remove('soltar-aqui'); });
  td.addEventListener('drop', (e) => {
    const a = S.plan.arrastre;
    if (!a) return;
    e.preventDefault();
    const tecnicoId = Number(td.dataset.tecnico);
    const dia = td.dataset.dia;
    soltarEnPlan(a, { tecnico_id: tecnicoId, dia, hora_inicio: a.tipo === 'ot' ? siguienteHueco(tecnicoId, dia) : null });
  });
}

function pintarSemana(cal, d) {
  const { por, ids } = indiceAvisos(d);
  const editable = puede('planificador.editar');
  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(d.desde, i));
  const tabla = document.createElement('table');
  tabla.className = 'plan-semana';
  tabla.innerHTML = `<thead><tr><th class="plan-esquina">Técnico</th>${dias.map((dia, i) => `<th data-dia="${dia}" class="${dia === d.hoy ? 'hoy' : ''}${i > 4 ? ' finde' : ''}"><button type="button" class="enlace" data-ir="${dia}" title="Ver este día">${DIAS_SEMANA[i]} ${Number(dia.slice(8))}/${Number(dia.slice(5, 7))}</button></th>`).join('')}</tr></thead><tbody></tbody>`;
  const tbody = $('tbody', tabla);
  for (const t of d.tecnicos) {
    const tr = document.createElement('tr');
    tr.dataset.tecnico = t.id;
    const minSemana = d.bloques.filter((b) => b.tecnico_id === t.id).reduce((n, b) => n + b.duracion_min, 0);
    tr.innerHTML = `<th><b>${esc(t.nombre)}</b>${t.rol === 'sat' ? ' <span class="chip chip-azul">SAT</span>' : ''}${t.inactivo ? ' <span class="chip chip-claro">de baja</span>' : ''}<div class="plan-carga">${textoDuracion(minSemana)} en la semana</div></th>`;
    dias.forEach((dia, i) => {
      const td = document.createElement('td');
      td.className = `plan-celda${dia === d.hoy ? ' hoy' : ''}${i > 4 ? ' finde' : ''}`;
      td.dataset.tecnico = t.id;
      td.dataset.dia = dia;
      const suyos = d.bloques.filter((b) => b.tecnico_id === t.id && b.dia === dia);
      for (const b of suyos) td.append(elementoBloque(b, { conAviso: ids.has(b.id), editable, compacto: true }));
      if (suyos.length) {
        const min = suyos.reduce((n, b) => n + b.duracion_min, 0);
        td.insertAdjacentHTML('beforeend', `<div class="plan-carga${min > d.jornada.horas_dia * 60 ? ' sobre' : ''}">${textoDuracion(min)} ${chipsAviso(por.get(`${t.id}|${dia}`) || [])}</div>`);
      }
      if (editable) prepararSoltarCelda(td);
      tr.append(td);
    });
    tbody.append(tr);
  }
  for (const b of $$('[data-ir]', tabla)) b.onclick = () => { S.plan.fecha = b.dataset.ir; S.plan.modo = 'dia'; recargarPlan(true); };
  cal.append(tabla);
}

// --- Mini-modal de bloque: planificar una O.T. (de la bandeja, del detalle o "+ Otro bloque") o editar/quitar un bloque -----------
async function abrirBloque({ ot = null, bloque = null, tecnico_id = null, dia = null, hora_inicio = null, duracion_min = null, alTerminar = null } = {}) {
  const o = bloque || ot;
  const otId = bloque ? bloque.ot_id : ot.id;
  const editable = puede('planificador.editar') && !(bloque && bloque.fuera_alcance);
  const enPlan = S.vista === 'planificador' && S.plan.datos;
  let tecnicos = [];
  try { tecnicos = enPlan ? S.plan.datos.tecnicos.filter((t) => !t.inactivo) : await cargarTecnicos(); }
  catch (e) { if (e.status !== 401) toast(e.message, 'error'); return; }
  const nodo = tpl('tpl-bloque');
  const form = ref('form', nodo);
  const avisos = ref('avisos', nodo);
  ref('titulo', nodo).textContent = bloque ? `Bloque de ${o.numero}` : `Planificar ${o.numero}`;
  ref('resumen', nodo).textContent = [o.cliente_nombre, o.cliente_zona, textoMaquina(o), o.sintoma].filter(Boolean).join(' · ');
  const selT = form.elements.tecnico_id;
  selT.innerHTML = '<option value="">— Elige técnico —</option>' + tecnicos.map((t) => `<option value="${t.id}">${esc(t.nombre)}${t.rol === 'sat' ? ' (SAT)' : ''}</option>`).join('');
  const tecnicoInicial = bloque ? bloque.tecnico_id : (tecnico_id || o.tecnico_id || '');
  if (tecnicoInicial && !$(`option[value="${tecnicoInicial}"]`, selT)) selT.insertAdjacentHTML('beforeend', `<option value="${tecnicoInicial}">${esc((bloque && bloque.tecnico_nombre) || o.tecnico_nombre || 'Técnico actual')} · de baja</option>`);
  selT.value = tecnicoInicial ? String(tecnicoInicial) : '';
  form.elements.dia.value = bloque ? bloque.dia : (dia || (enPlan && S.plan.modo === 'dia' ? S.plan.fecha : hoyISO()));
  form.elements.hora_inicio.value = bloque ? bloque.hora_inicio : (hora_inicio || '08:00');
  const dur = bloque ? bloque.duracion_min : (duracion_min || (enPlan && S.plan.datos.duracion_defecto) || 120);
  const selD = form.elements.duracion_min;
  selD.innerHTML = [...new Set([...DURACIONES, dur])].sort((x, y) => x - y).map((m) => `<option value="${m}">${textoDuracion(m)}</option>`).join('');
  selD.value = String(dur);
  form.elements.nota.value = bloque ? (bloque.nota || '') : '';
  const guardar = ref('guardar', nodo);
  guardar.textContent = bloque ? 'Guardar' : 'Planificar';
  ref('ver-ot', nodo).onclick = () => abrirDetalle(otId);
  const terminar = () => {
    cerrarModal(nodo);
    if (alTerminar) alTerminar();
    if (S.vista === 'planificador') recargarPlan(true); else refrescarVista();
  };
  if (!editable) {
    for (const el of $$('input, select', form)) el.disabled = true;
    guardar.classList.add('oculto');
  }
  if (bloque && editable) {
    const quitar = ref('quitar', nodo);
    quitar.classList.remove('oculto');
    quitar.onclick = async () => { if (await quitarBloque(bloque)) terminar(); };
    const partir = ref('partir', nodo);
    partir.classList.remove('oculto');
    partir.onclick = () => {
      cerrarModal(nodo);
      abrirBloque({ ot: { ...o, id: otId }, tecnico_id: bloque.tecnico_id, dia: sumarDias(bloque.dia, 1), hora_inicio: bloque.hora_inicio, duracion_min: bloque.duracion_min, alTerminar });
    };
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!editable) return;
    const body = { tecnico_id: Number(selT.value), dia: form.elements.dia.value, hora_inicio: form.elements.hora_inicio.value.slice(0, 5), duracion_min: Number(selD.value), nota: form.elements.nota.value.trim() || null };
    if (!body.tecnico_id) { aviso(avisos, 'Elige el técnico', 'error'); selT.focus(); return; }
    guardar.disabled = true;
    try {
      const r = await api(`/api/ot/${otId}/bloques${bloque ? '/' + bloque.id : ''}`, { method: bloque ? 'PUT' : 'POST', body });
      toast(`${o.numero}: ${bloque ? 'bloque guardado' : `planificada el ${fecha(body.dia)} a las ${body.hora_inicio}`}`, 'ok');
      for (const av of r.avisos || []) toast(av.texto, 'aviso');
      terminar();
    } catch (err) {
      mostrarErrorAccion(err, avisos);
      guardar.disabled = false;
    }
  };
  abrirModal(nodo);
}

// ---------------------------------------------------------------------------
// Técnico (F4-05 + F4-06): "Mi día" y ficha de trabajo con cronómetro y checklist. Pensado para móvil y tablet.
//
// - Mi día (#midia): su cronómetro en marcha (si lo tiene), el resumen de horas del día y sus tareas: en curso, las de hoy por
//   hora y las atrasadas. Un botón por momento: Salir → He llegado → Empezar trabajo → Abrir ficha.
// - Ficha de trabajo (#trabajo/ID): a pantalla completa, con el cronómetro fijo arriba (tres fases: desplazamiento, espera de
//   acceso, trabajo), los datos del aviso, el checklist y, fijos abajo, Parar por hoy / Pausar / Terminar.
// La hora es la del servidor: aquí solo se pinta lo transcurrido desde el último dato (`segundos` + reloj local).
// ---------------------------------------------------------------------------
const TEC_POLLING_MS = 15000;
const FASES = {
  desplazamiento: { nombre: 'Desplazamiento', icono: '🚗' },
  espera: { nombre: 'Espera de acceso', icono: '⏳' },
  trabajo: { nombre: 'Trabajo', icono: '🔧' },
};
const GRUPOS_TAREA = [['en_curso', 'En curso'], ['hoy', 'Hoy'], ['atrasada', 'Atrasadas o sin fecha']];
const RESULTADOS_PUNTO = [['hecho', '✓ Hecho'], ['no_aplica', 'No aplica'], ['incidencia', '⚠ Incidencia']];

const dosCifras = (n) => String(n).padStart(2, '0');
function reloj(seg) {
  seg = Math.max(0, Math.floor(seg));
  return `${dosCifras(Math.floor(seg / 3600))}:${dosCifras(Math.floor((seg % 3600) / 60))}:${dosCifras(seg % 60)}`;
}
function duracionSeg(seg) {
  const min = Math.floor(Math.max(0, seg) / 60);
  const h = Math.floor(min / 60);
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`;
}
const horaCorta = (fechaHora) => String(fechaHora || '').slice(11, 16);

// Contadores que avanzan solos: el elemento guarda los segundos que llevaba al recibir el dato y cuándo se recibió.
function ponerTic(el, base, formato) {
  el.dataset.tic = formato;
  el.dataset.base = String(base || 0);
  el.dataset.t0 = String(Date.now());
  pintarTic(el);
}
function quitarTic(el, texto) {
  delete el.dataset.tic;
  el.textContent = texto;
}
function pintarTic(el) {
  const s = Number(el.dataset.base) + (Date.now() - Number(el.dataset.t0)) / 1000;
  el.textContent = el.dataset.tic === 'reloj' ? reloj(s) : duracionSeg(s);
}
function pararTecnico() {
  if (S.tec.timer) clearInterval(S.tec.timer);
  if (S.tec.tic) clearInterval(S.tec.tic);
  S.tec.timer = S.tec.tic = null;
  document.body.classList.remove('modo-ficha');
}
function arrancarTecnico(recargar) {
  S.tec.timer = setInterval(() => { if (!document.hidden && !$('#modales .modal-fondo')) recargar(); }, TEC_POLLING_MS);
  S.tec.tic = setInterval(() => { for (const el of $$('[data-tic]', app)) pintarTic(el); }, 1000);
}

// Pide una nota en un modal (opcional u obligatoria). Devuelve el texto ('' si se deja vacía) o null si se cancela.
function pedirNota({ titulo, pista = '', etiqueta = 'Nota', obligatoria = false, boton = 'Guardar' }) {
  return new Promise((resolver) => {
    const nodo = tpl('tpl-nota');
    ref('titulo', nodo).textContent = titulo;
    ref('pista', nodo).textContent = pista;
    ref('etiqueta', nodo).textContent = etiqueta;
    const nota = ref('nota', nodo);
    const confirmar = ref('confirmar', nodo);
    confirmar.textContent = boton;
    let hecho = false;
    confirmar.onclick = () => {
      const texto = nota.value.trim();
      if (obligatoria && !texto) { aviso(ref('avisos', nodo), 'Escribe la nota', 'error'); nota.focus(); return; }
      hecho = true;
      cerrarModal(nodo);
      resolver(texto);
    };
    abrirModal(nodo);
    const obs = new MutationObserver(() => { if (!nodo.isConnected) { obs.disconnect(); if (!hecho) resolver(null); } });
    obs.observe(document.getElementById('modales'), { childList: true });
  });
}

// Empieza o cambia de fase, o para por hoy. Si tiene el cronómetro en otra O.T., pregunta antes de pararlo. Devuelve la respuesta o null.
async function ficharCrono(otId, accion, nota) {
  const enviar = (extra = {}) => api(`/api/ot/${otId}/crono`, { method: 'POST', body: { accion, nota: nota || undefined, ...extra } });
  try {
    return await enviar();
  } catch (e) {
    if (e.status === 409 && e.datos && e.datos.abierto) {
      const si = await elegir(`${e.message}. ¿Lo paras y empiezas en esta?`, [{ etiqueta: 'Sí, pararlo y empezar aquí', valor: 1 }]);
      if (!si) return null;
      try { return await enviar({ cerrar_otra: true }); } catch (e2) { if (e2.status !== 401) toast(e2.message, 'error'); return null; }
    }
    if (e.status !== 401) toast(e.message, 'error');
    return null;
  }
}

// --- Mi día -------------------------------------------------------------------
function pintarMiDia() {
  pararTecnico();
  S.tec.etag = null;
  $('[data-accion="recargar"]', app).onclick = () => cargarMiDia(true);
  cargarMiDia(true);
  arrancarTecnico(() => cargarMiDia(false));
}

async function cargarMiDia(forzar) {
  if (S.vista !== 'midia' || S.tec.cargando) return;
  S.tec.cargando = true;
  try {
    const d = await api('/api/mi-dia', { headers: !forzar && S.tec.etag ? { 'If-None-Match': S.tec.etag } : {} });
    if (d._304) return;
    S.tec.etag = d._etag;
    S.tec.datos = d;
    if (S.vista === 'midia') renderMiDia();
  } catch (e) {
    if (e.status === 401 || S.vista !== 'midia') return;
    const lista = ref('lista', app);
    if (lista && !S.tec.datos) lista.innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
    else toast(`Mi día: ${e.message}`, 'error');
  } finally {
    S.tec.cargando = false;
  }
}

function renderMiDia() {
  const d = S.tec.datos;
  ref('fecha', app).textContent = diaLargo(d.dia);

  // Cronómetro en marcha: siempre a la vista, lleva a la ficha de esa O.T.
  const banner = ref('crono-banner', app);
  if (d.crono) {
    const f = faseDe(d.crono.tipo);
    const otroDia = d.crono.otro_dia ? `<small>Abierto desde el ${esc(fecha(d.crono.inicio))}: ciérralo</small>` : '';
    banner.className = `crono-banner fase-${d.crono.tipo}${d.crono.otro_dia ? ' otro-dia' : ''}`;
    if (d.crono.comodin) {   // comodín: no hay ficha a la que ir; el aviso lleva el botón de parar
      banner.href = '#midia';
      banner.innerHTML = `<span class="cb-texto">${f.icono} <b>${esc(f.nombre)}</b> · ${esc(d.crono.nombre)}${otroDia}</span><b class="crono-tiempo" data-ref="banner-reloj"></b><span class="btn btn-fase" role="button" data-accion="parar-comodin">■ Parar</span>`;
      banner.onclick = (e) => { e.preventDefault(); if (e.target.closest('[data-accion="parar-comodin"]')) pararComodin(); };
    } else {
      banner.onclick = null;
      banner.href = `#trabajo/${d.crono.ot_id}`;
      banner.innerHTML = `<span class="cb-texto">${f.icono} <b>${esc(f.nombre)}</b> · O.T. ${esc(d.crono.numero)}${d.crono.otro_dia ? `<small>Abierto desde el ${esc(fecha(d.crono.inicio))}: ciérralo</small>` : ''}</span><b class="crono-tiempo" data-ref="banner-reloj"></b><span class="ir">Abrir ›</span>`;
    }
    ponerTic(ref('banner-reloj', banner), d.crono.segundos, 'reloj');
  } else {
    banner.onclick = null;
    banner.className = 'crono-banner oculto';
    banner.innerHTML = '';
  }

  // Resumen de horas del día: las tres fases y el total frente a la jornada.
  const r = d.resumen;
  const resumen = ref('resumen', app);
  const conComodin = r.comodin > 0 || !!(d.crono && d.crono.comodin);
  resumen.classList.toggle('con-comodin', conComodin);
  resumen.innerHTML = [...Object.entries(FASES), ...(conComodin ? [['comodin', FASE_COMODIN]] : [])].map(([tipo, f]) =>
    `<div class="pill fase-${tipo}${d.crono && d.crono.tipo === tipo ? ' activa' : ''}"><span>${f.icono} ${esc(f.nombre)}</span><b data-total="${tipo}">${duracionSeg(r[tipo])}</b></div>`).join('')
    + `<div class="pill total"><span>Fichado hoy</span><b data-total="total">${duracionSeg(r.total)}</b><small>de ${r.horas_dia} h${r.previsto_min ? ` · previsto ${textoDuracion(r.previsto_min)}` : ''}</small></div>`;
  if (d.crono && !d.crono.otro_dia) {
    ponerTic($(`[data-total="${d.crono.tipo}"]`, resumen), r[d.crono.tipo], 'dur');
    ponerTic($('[data-total="total"]', resumen), r.total, 'dur');
  }

  // Tareas por grupo.
  const lista = ref('lista', app);
  lista.innerHTML = '';
  const avisoJ = avisoJornada(d);
  if (avisoJ) lista.append(avisoJ);
  for (const [grupo, titulo] of GRUPOS_TAREA) {
    const tareas = d.tareas.filter((t) => t.grupo === grupo).sort((a, b) => (b.crono ? 1 : 0) - (a.crono ? 1 : 0));   // la del cronómetro en marcha, la primera
    if (!tareas.length) continue;
    const sec = document.createElement('section');
    sec.className = 'grupo';
    sec.dataset.grupo = grupo;
    sec.innerHTML = `<h3>${esc(titulo)} <span class="chip chip-claro">${tareas.length}</span></h3><div class="tareas"></div>`;
    for (const t of tareas) $('.tareas', sec).append(tarjetaTarea(t));
    lista.append(sec);
  }
  if (!d.tareas.length) lista.insertAdjacentHTML('beforeend', '<div class="vacio">No tienes nada para hoy.</div>');
  lista.append(tarjetaComodin(d));

  // Próximos días (solo consulta).
  if (d.proximos.length) {
    const det = document.createElement('details');
    det.className = 'proximos';
    const porDia = new Map();
    for (const p of d.proximos) { if (!porDia.has(p.dia)) porDia.set(p.dia, []); porDia.get(p.dia).push(p); }
    det.innerHTML = `<summary>Próximos días <span class="chip chip-claro">${d.proximos.length}</span></summary>`
      + [...porDia.entries()].map(([dia, ps]) => `<div class="proximo-dia"><h4>${esc(diaLargo(dia).replace(/ de \d{4}$/, ''))}</h4>${ps.map((p) =>
        `<div class="proximo"><b>${esc(p.hora_inicio)}</b><span>${esc(p.cliente_nombre)}${p.sintoma ? ` · <small>${esc(p.sintoma)}</small>` : ''}</span><small>${esc(textoDuracion(p.duracion_min))}</small></div>`).join('')}</div>`).join('');
    lista.append(det);
  }
}

// Botón principal de una tarea según el momento: Salir → He llegado → Empezar trabajo → (ficha).
function siguientePaso(t) {
  if (t.crono) {
    if (t.crono.tipo === 'desplazamiento') return { fase: 'espera', texto: '📍 He llegado' };
    if (t.crono.tipo === 'espera') return { fase: 'trabajo', texto: '🔧 Empezar trabajo' };
    return { fase: null, texto: 'Abrir la ficha' };
  }
  if (t.estado === 'planificada') return { fase: 'desplazamiento', texto: '🚗 Salir hacia el cliente' };
  return { fase: null, texto: '▶ Continuar' };
}

function tarjetaTarea(t) {
  const el = document.createElement('article');
  el.className = `tarea${t.prioridad === 1 ? ' urgente' : ''}${t.crono ? ` con-crono fase-${t.crono.tipo}` : ''}`;
  el.dataset.id = t.id;
  const hora = t.bloque
    ? `${esc(t.bloque.hora_inicio)} <small>${esc(textoDuracion(t.bloque.duracion_min))}</small>`
    : (t.grupo === 'atrasada' ? `<small>${t.bloque_anterior ? 'Era el ' + esc(fecha(t.bloque_anterior)) : 'Sin fecha'}</small>` : '<small>Sin hora hoy</small>');
  const chips = [];
  if (t.crono) chips.push(`<span class="dato-chip fase-${t.crono.tipo}">${FASES[t.crono.tipo].icono} ${esc(FASES[t.crono.tipo].nombre)} <b data-ref="crono"></b></span>`);
  if (t.tiempo.total > 0) chips.push(`<span class="dato-chip">⏱ ${duracionSeg(t.tiempo.total)} fichados</span>`);
  if (t.checklist.total) chips.push(`<span class="dato-chip${t.checklist.respondidos >= t.checklist.total ? ' completo' : ''}">☑ Checklist ${t.checklist.respondidos}/${t.checklist.total}</span>`);
  if (t.tipo === 'preventivo') chips.push('<span class="dato-chip">Preventivo</span>');
  const paso = siguientePaso(t);
  el.innerHTML = `
    <div class="tarea-cab"><span class="tarea-hora">${hora}</span>${t.prioridad === 1 ? '<span class="chip urgente-chip">Urgente</span>' : ''}<span class="tarea-num">${esc(t.numero)}</span></div>
    <div class="tarea-cliente">${esc(t.cliente_nombre)}${t.cliente_zona ? ` <small class="zona">${esc(t.cliente_zona)}</small>` : ''}</div>
    ${t.maquina_id ? `<div class="tarea-maquina">${esc(textoMaquina(t))}</div>` : ''}
    ${t.sintoma ? `<div class="tarea-sintoma">${esc(t.sintoma)}</div>` : ''}
    ${t.bloque && t.bloque.nota ? `<div class="tarea-nota">Nota de oficina: ${esc(t.bloque.nota)}</div>` : ''}
    ${chips.length ? `<div class="tarea-pie">${chips.join('')}</div>` : ''}
    <div class="tarea-botones">
      <button type="button" class="btn btn-grande ${paso.fase ? `btn-fase fase-${paso.fase}` : 'btn-primario'}" data-accion="principal">${esc(paso.texto)}</button>
      ${paso.fase ? '<button type="button" class="btn btn-grande" data-accion="ficha">Ficha</button>' : ''}
    </div>`;
  if (t.crono) ponerTic(ref('crono', el), t.crono.segundos, 'reloj');
  const abrir = () => { location.hash = `trabajo/${t.id}`; };
  el.onclick = (e) => { if (!e.target.closest('button')) abrir(); };
  const ficha = $('[data-accion="ficha"]', el);
  if (ficha) ficha.onclick = abrir;
  const principal = $('[data-accion="principal"]', el);
  principal.onclick = async () => {
    if (!paso.fase) { abrir(); return; }
    principal.disabled = true;
    const r = await ficharCrono(t.id, paso.fase);
    principal.disabled = false;
    if (r) { toast(`${t.numero}: ${FASES[paso.fase].nombre.toLowerCase()}`, 'ok'); await cargarMiDia(true); }
  };
  return el;
}

// --- Ficha de trabajo ---------------------------------------------------------
function mostrarTrabajo(id) {
  if (S.sesion.alcance !== 'asignadas') { location.hash = `ot/${id}`; return; }   // la oficina usa el detalle de siempre
  pararPolling();
  pararPollingPlan();
  pararTecnico();
  S.vista = 'trabajo';
  S.tec.otId = id;
  S.tec.ot = null;
  for (const b of $$('#nav button[data-vista]')) b.classList.toggle('activo', b.dataset.vista === 'midia');
  app.innerHTML = '';
  app.append(document.getElementById('tpl-trabajo').content.cloneNode(true));
  app.classList.remove('entra');   // sin animación de entrada: su transform descolocaría la barra fija de acciones mientras dura
  document.body.classList.add('modo-ficha');
  window.scrollTo(0, 0);
  $('[data-accion="volver"]', app).onclick = () => { location.hash = 'midia'; };
  cargarTrabajo();
  arrancarTecnico(cargarTrabajo);
}

async function cargarTrabajo() {
  const id = S.tec.otId;
  try {
    const [ot, dia] = await Promise.all([api(`/api/ot/${id}`), api('/api/mi-dia').catch(() => null)]);
    if (S.vista !== 'trabajo' || S.tec.otId !== id) return;
    S.tec.ot = ot;
    if (dia && !dia._304) { S.tec.datos = dia; S.tec.etag = dia._etag; }
    renderTrabajo();
  } catch (e) {
    if (e.status === 401 || S.vista !== 'trabajo') return;
    if (e.status === 404) { toast('Esa O.T. ya no está entre las tuyas', 'aviso'); location.hash = 'midia'; return; }
    toast(e.message, 'error');
  }
}

function renderTrabajo() {
  const ot = S.tec.ot;
  const yo = S.sesion.usuario.id;
  const ficha = ref('ficha', app);
  if (!ficha) return;
  const abierto = ot.tiempos.find((t) => !t.fin && t.tecnico_id === yo) || null;
  const activa = !ot.es_final && ['planificada', 'en_curso'].includes(ot.estado);
  const hoyIso = S.tec.datos ? S.tec.datos.hoy : null;

  ref('numero', ficha).textContent = ot.numero;
  ref('chips', ficha).innerHTML = `${chipEstado(ot)} ${chipEtiqueta(ot)}${ot.prioridad === 1 ? ' <span class="chip urgente-chip">Urgente</span>' : ''}`;

  // Cronómetro: fase en marcha y reloj; cada fase con su total. La fase activa va rellena.
  const crono = ref('crono', ficha);
  crono.className = `crono${abierto ? ` fase-${abierto.tipo} en-marcha` : ''}`;
  const etiquetaFase = ref('fase', ficha);
  const relojEl = ref('reloj', ficha);
  if (abierto) {
    etiquetaFase.textContent = `${FASES[abierto.tipo].icono} ${FASES[abierto.tipo].nombre} · desde las ${horaCorta(abierto.inicio)}${abierto.inicio.slice(0, 10) !== hoyIso && hoyIso ? ` del ${fecha(abierto.inicio.slice(0, 10))}` : ''}`;
    ponerTic(relojEl, abierto.segundos, 'reloj');
  } else {
    etiquetaFase.textContent = ot.tiempo.total ? 'Cronómetro parado · total fichado' : 'Sin empezar';
    quitarTic(relojEl, reloj(ot.tiempo.total));
  }
  for (const b of $$('[data-fase]', ficha)) {
    const tipo = b.dataset.fase;
    const total = $('[data-total]', b);
    if (abierto && abierto.tipo === tipo) ponerTic(total, ot.tiempo[tipo], 'dur'); else quitarTic(total, duracionSeg(ot.tiempo[tipo]));
    b.classList.toggle('activa', !!abierto && abierto.tipo === tipo);
    b.setAttribute('aria-pressed', abierto && abierto.tipo === tipo ? 'true' : 'false');
    b.disabled = !activa;
    b.onclick = async () => {
      if (abierto && abierto.tipo === tipo) return;
      for (const x of $$('[data-fase]', ficha)) x.disabled = true;
      const r = await ficharCrono(ot.id, tipo);
      if (r) { S.tec.ot = r.ot; if (S.tec.datos) S.tec.datos.crono = r.crono; }
      if (S.vista === 'trabajo') renderTrabajo();
    };
  }
  ref('pista', ficha).textContent = !activa ? ''
    : !abierto ? (ot.estado === 'planificada' ? 'Pulsa Desplazamiento al salir hacia el cliente (o Trabajo si ya estás con la máquina).' : 'Cronómetro parado. Pulsa la fase que toque para seguir.')
      : abierto.tipo === 'desplazamiento' ? 'Al llegar: Espera de acceso si aún no puedes entrar, o Trabajo si empiezas ya.'
        : abierto.tipo === 'espera' ? 'Cuando puedas ponerte con la máquina, pulsa Trabajo.'
          : 'Al acabar, Terminar. Si te vas sin acabar: Parar por hoy o Pausar.';

  // Avisos: cronómetro en otra O.T. o la O.T. ya no admite fichaje.
  const avisos = ref('avisos', ficha);
  const otro = S.tec.datos && S.tec.datos.crono && S.tec.datos.crono.ot_id !== ot.id ? S.tec.datos.crono : null;
  if (!activa) aviso(avisos, `Esta O.T. está en "${ot.estado_nombre}": ya no se ficha en ella.`, 'info');
  else if (otro && otro.comodin) aviso(avisos, `Tienes el cronómetro en marcha en el comodín (${otro.nombre}).`, 'conflicto', 'Ir a Mi día', () => { location.hash = 'midia'; });
  else if (otro) aviso(avisos, `Tienes el cronómetro en marcha en la O.T. ${otro.numero} (${String(otro.nombre).toLowerCase()}).`, 'conflicto', 'Ir a esa O.T.', () => { location.hash = `trabajo/${otro.ot_id}`; });
  else avisos.innerHTML = '';

  // Cliente y máquina.
  const fila = (etiqueta, html) => (html ? `<div><span class="et">${esc(etiqueta)}</span><span>${html}</span></div>` : '');
  const telefono = (n) => (n ? `<a href="tel:${esc(String(n).replace(/[^\d+]/g, ''))}">${esc(n)}</a>` : '');
  const miBloque = (ot.bloques || []).filter((b) => b.tecnico_id === yo && (!hoyIso || b.dia >= hoyIso))[0];
  ref('datos', ficha).innerHTML = [
    fila('Cliente', `<b>${esc(ot.cliente_nombre)}</b>${ot.cliente_zona ? ` <small class="zona">${esc(ot.cliente_zona)}</small>` : ''}`),
    fila('Dirección', ot.cliente_direccion ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ot.cliente_direccion)}" target="_blank" rel="noopener">${esc(ot.cliente_direccion)}</a>` : ''),
    fila('Contacto', [ot.contacto_nombre ? esc(ot.contacto_nombre) : '', telefono(ot.contacto_telefono)].filter(Boolean).join(' · ')),
    fila('Teléfono', telefono(ot.cliente_telefono)),
    fila('Máquina', ot.maquina_id ? `${esc(textoMaquina(ot))}${ot.maquina_bastidor && ot.maquina_flota ? `<br><small>Bastidor ${esc(ot.maquina_bastidor)}</small>` : ''}` : ''),
    fila('Previsto', miBloque ? `${esc(fecha(miBloque.dia))} a las ${esc(miBloque.hora_inicio)} · ${esc(textoDuracion(miBloque.duracion_min))}${miBloque.nota ? `<br><small>Nota de oficina: ${esc(miBloque.nota)}</small>` : ''}` : ''),
    fila('Tipo', esc(ot.tipo === 'preventivo' ? 'Mantenimiento preventivo' : 'Correctivo')),
  ].join('');

  // Aviso del cliente.
  const secAviso = ref('sec-aviso', ficha);
  secAviso.classList.toggle('oculto', !ot.sintoma && !ot.descripcion);
  ref('aviso', ficha).innerHTML = `${ot.sintoma ? `<div class="sintoma">${esc(ot.sintoma)}</div>` : ''}${ot.descripcion && ot.descripcion !== ot.sintoma ? `<div class="descripcion">${esc(ot.descripcion)}</div>` : ''}`;

  // Checklist.
  const puntos = ot.checklist || [];
  ref('sec-checklist', ficha).classList.toggle('oculto', !puntos.length);
  const req = ot.requisitos;
  const progreso = ref('progreso', ficha);
  progreso.textContent = `${req.checklist.respondidos} de ${req.checklist.total}`;
  progreso.className = `chip ${req.checklist.completo ? 'chip-ok' : 'chip-claro'}`;
  const lista = ref('checklist', ficha);
  lista.innerHTML = '';
  const editable = !ot.es_final && puede('ot.checklist');
  for (const p of puntos) {
    const el = document.createElement('div');
    el.className = 'punto';
    el.dataset.punto = p.id;
    el.dataset.resultado = p.resultado || '';
    el.innerHTML = `
      <div class="punto-texto">${esc(p.texto)}</div>
      <div class="punto-botones">${RESULTADOS_PUNTO.map(([res, texto]) => `<button type="button" class="btn${p.resultado === res ? ' elegido' : ''}" data-res="${res}" aria-pressed="${p.resultado === res}"${editable ? '' : ' disabled'}>${texto}</button>`).join('')}</div>
      ${p.nota ? `<div class="punto-nota">${esc(p.nota)}</div>` : ''}
      ${p.resultado && p.usuario_nombre ? `<div class="punto-meta">${esc(p.usuario_nombre)} · ${esc(fecha(p.fecha))}</div>` : ''}`;
    for (const b of $$('[data-res]', el)) {
      b.onclick = async () => {
        let resultado = b.dataset.res;
        let nota;
        if (p.resultado === resultado) resultado = null;                    // pulsar el elegido lo deja sin responder
        else if (resultado === 'incidencia') {
          nota = await pedirNota({ titulo: p.texto, pista: 'Di qué has encontrado. Quedará en la O.T.', etiqueta: '¿Qué pasa?', obligatoria: true, boton: 'Guardar incidencia' });
          if (nota === null) return;
        }
        for (const x of $$('[data-res]', el)) x.disabled = true;
        try {
          const r = await api(`/api/ot/${ot.id}/checklist/${p.id}`, { method: 'PUT', body: { resultado, nota } });
          S.tec.ot.checklist = r.checklist;
          S.tec.ot.requisitos = r.requisitos;
        } catch (e) {
          if (e.status !== 401) toast(e.message, 'error');
        }
        if (S.vista === 'trabajo') renderTrabajo();
      };
    }
    lista.append(el);
  }

  // Tiempos fichados (tramos).
  const tramos = ref('tramos', ficha);
  ref('n-tramos', ficha).textContent = ot.tiempos.length ? `${ot.tiempos.length}` : '';
  tramos.innerHTML = ot.tiempos.length
    ? ot.tiempos.map((t) => `<li class="fase-${esc(t.tipo)}"><span class="punto-fase"></span><span>${esc(fecha(t.inicio.slice(0, 10)).slice(0, 5))} ${horaCorta(t.inicio)}–${t.fin ? horaCorta(t.fin) : 'ahora'}</span><span>${esc((FASES[t.tipo] || {}).nombre || t.tipo)}${t.tecnico_id !== yo ? ` · ${esc(t.tecnico_nombre)}` : ''}${t.nota ? ` · <small>${esc(t.nota)}</small>` : ''}${t.origen === 'manual' ? ' · <small>corregido</small>' : ''}</span><b>${t.fin ? duracionSeg(t.segundos) : 'en marcha'}</b></li>`).join('')
    : '<li class="suave">Todavía no has fichado nada en esta O.T.</li>';

  // Acciones fijas: Parar por hoy (necesita el cronómetro en marcha), Pausar y Terminar (bloqueado si falta algo).
  const parar = $('[data-accion="parar"]', ficha);
  const pausar = $('[data-accion="pausar"]', ficha);
  const terminar = $('[data-accion="terminar"]', ficha);
  parar.disabled = !abierto;
  pausar.disabled = !activa;
  terminar.disabled = !activa || !req.completo;
  const falta = ref('falta', ficha);
  const textos = { trabajo: 'fichar tiempo de Trabajo', checklist: `responder el checklist (${req.checklist.respondidos} de ${req.checklist.total})` };
  falta.classList.toggle('oculto', !activa || !!req.completo);
  falta.textContent = req.completo ? '' : `Para terminar falta: ${req.faltan.map((f) => textos[f.codigo] || f.texto).join(' y ')}.`;
  parar.onclick = async () => {
    const nota = await pedirNota({ titulo: 'Parar por hoy', pista: 'Se para el cronómetro y la O.T. sigue en tu tablero para continuar otro día. Si lo que pasa es que falta un repuesto o el cliente, usa Pausar.', etiqueta: 'Nota (opcional)', boton: 'Parar por hoy' });
    if (nota === null) return;
    const r = await ficharCrono(ot.id, 'parar', nota);
    if (r) { toast(`${ot.numero}: parada por hoy. Sigue en tu tablero.`, 'ok'); location.hash = 'midia'; }
  };
  pausar.onclick = async () => {
    if (await abrirCambioEstado(S.tec.ot, 'pausada')) location.hash = 'midia';
    else if (S.vista === 'trabajo') cargarTrabajo();
  };
  terminar.onclick = async () => {
    if (await abrirCambioEstado(S.tec.ot, 'finalizada')) location.hash = 'midia';
    else if (S.vista === 'trabajo') cargarTrabajo();
  };
}

// ---------------------------------------------------------------------------
// Fichajes (F4-07 + F4-08): O.T. comodín, jornadas e incidencias de fichaje.
//
// - En "Mi día": aviso de los días recientes que no llegan a la jornada y la tarjeta "Horas sin O.T." (el comodín del mes:
//   taller, formación, sin trabajo asignado…), con el mismo cronómetro que las O.T.
// - Mis horas (#horas): el mes del técnico día a día, con sus fichajes; desde ahí pide correcciones (corregir, quitar o
//   añadir tiempo), que la oficina aprueba o rechaza. La oficina ve la misma pantalla de cualquier técnico (#horas/ID) y,
//   si puede gestionar, corrige directamente.
// - Fichajes (#fichajes, oficina): una fila por técnico y una celda por día con las horas fichadas, y las incidencias.
// ---------------------------------------------------------------------------
const FASE_COMODIN = { nombre: 'Sin O.T.', icono: '🗂' };
const faseDe = (tipo) => FASES[tipo] || (tipo === 'comodin' ? FASE_COMODIN : { nombre: tipo, icono: '⏱' });
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS_ABREV = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const ESTADOS_INCIDENCIA = { pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', anulada: 'Retirada' };
const mesLargo = (mes) => { const [a, m] = mes.split('-').map(Number); return `${MESES[m - 1][0].toUpperCase()}${MESES[m - 1].slice(1)} de ${a}`; };   // "Noviembre de 2026"
const sumarMes = (mes, n) => { const [a, m] = mes.split('-').map(Number); const f = new Date(a, m - 1 + n, 1); return `${f.getFullYear()}-${dosDigitos(f.getMonth() + 1)}`; };
const finDeMes = (mes) => { const [a, m] = mes.split('-').map(Number); return isoDe(new Date(a, m, 0)); };
const diaSemana = (iso) => `${DIAS_ABREV[fechaLocal(iso).getDay()]} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;   // "jue 12/11"
const horasDec = (seg) => (seg / 3600).toLocaleString('es-ES', { maximumFractionDigits: 1 });

// Contador de incidencias pendientes: en el botón "Fichajes" de la cabecera y en la pestaña de la vista.
function ponerContadorFichajes(n) {
  const b = $('#nav button[data-vista="fichajes"]');
  if (b) {
    let c = $('.nav-contador', b);
    if (!n) { if (c) c.remove(); } else {
      if (!c) { c = document.createElement('span'); c.className = 'nav-contador'; b.append(c); }
      c.textContent = String(n);
    }
  }
  const v = S.vista === 'fichajes' ? ref('n-pend', app) : null;
  if (v) v.textContent = n ? String(n) : '';
}
async function refrescarContadorFichajes() {
  if (!VISTAS.fichajes.visible()) return;
  try { ponerContadorFichajes((await api('/api/incidencias/pendientes')).n); } catch { /* sin contador */ }
}

// --- Mi día: aviso de jornadas y comodín ---------------------------------------
function avisoJornada(d) {
  const bajas = d.jornadas_bajas || [];
  if (!bajas.length && !d.incidencias_pendientes) return null;
  const sec = document.createElement('section');
  sec.className = 'aviso-jornada';
  sec.dataset.ref = 'aviso-jornada';
  let html = '';
  if (bajas.length) {
    html += `<h3>⚠ ${bajas.length === 1 ? 'Un día no llega' : `${bajas.length} días no llegan`} a las ${d.resumen.horas_dia} h</h3><div class="dias-bajos">`
      + bajas.map((b) => `<button type="button" class="dia-bajo" data-dia="${esc(b.dia)}"><b>${esc(diaSemana(b.dia))}</b><span>${b.estado === 'sin_fichar' ? 'sin fichar' : `${duracionSeg(b.total)} fichados`}</span><small>faltan ${duracionSeg(b.falta)}</small></button>`).join('')
      + '</div>';
  }
  if (d.incidencias_pendientes) {
    html += `<div class="pendientes">⏳ ${d.incidencias_pendientes === 1 ? 'Tienes una corrección pendiente' : `Tienes ${d.incidencias_pendientes} correcciones pendientes`} de que la apruebe la oficina.</div>`;
    if (!bajas.length) html += '<div><button type="button" class="btn" data-accion="mis-horas">Ver mis horas</button></div>';
  }
  sec.innerHTML = html;
  for (const b of $$('.dia-bajo', sec)) b.onclick = () => { S.horas.abrir = b.dataset.dia; location.hash = 'horas'; };
  const mh = $('[data-accion="mis-horas"]', sec);
  if (mh) mh.onclick = () => { location.hash = 'horas'; };
  return sec;
}

function tarjetaComodin(d) {
  const cm = d.comodin;
  if (!cm || d.dia !== d.hoy) return document.createDocumentFragment();
  const enMarcha = d.crono && d.crono.comodin ? d.crono : null;
  const sec = document.createElement('section');
  sec.className = 'seccion-comodin';
  sec.dataset.ref = 'comodin';
  sec.innerHTML = `<h3>Horas sin O.T.</h3>
    <article class="comodin-tarjeta${enMarcha ? ' con-crono fase-comodin' : ''}">
      <div class="comodin-titulo">${enMarcha ? `<span>${FASE_COMODIN.icono} ${esc(enMarcha.nombre)}</span><b class="crono-tiempo" data-ref="crono"></b>` : '<span>Taller, formación, sin trabajo asignado…</span>'}</div>
      <div class="tarea-pie"><span class="dato-chip">Hoy <b>${duracionSeg(cm.dia_seg)}</b></span><span class="dato-chip">Este mes <b>${duracionSeg(cm.mes_seg)}</b></span><span class="dato-chip" title="O.T. comodín del mes">${esc(cm.codigo)}</span></div>
      <div class="tarea-botones">${enMarcha
        ? '<button type="button" class="btn btn-grande btn-fase fase-comodin" data-accion="parar-comodin">■ Parar</button><button type="button" class="btn btn-grande" data-accion="empezar-comodin">Cambiar</button>'
        : '<button type="button" class="btn btn-grande" data-accion="empezar-comodin">＋ Imputar horas sin O.T.</button>'}</div>
    </article>`;
  if (enMarcha) ponerTic(ref('crono', sec), enMarcha.segundos, 'reloj');
  $('[data-accion="empezar-comodin"]', sec).onclick = empezarComodin;
  const parar = $('[data-accion="parar-comodin"]', sec);
  if (parar) parar.onclick = pararComodin;
  return sec;
}

// Elige el concepto y arranca el cronómetro del comodín. Si lo tiene en una O.T., pregunta antes de pararlo.
async function empezarComodin() {
  const d = S.tec.datos;
  if (!d || !d.comodin) return;
  const actual = d.crono && d.crono.comodin ? d.crono.concepto : null;
  const codigo = await elegir('¿A qué dedicas este tiempo?', d.comodin.conceptos.filter((c) => c.codigo !== actual).map((c) => ({ etiqueta: c.nombre, valor: c.codigo })));
  if (!codigo) return;
  const c = d.comodin.conceptos.find((x) => x.codigo === codigo);
  let nota;
  if (c.pide_nota) {
    nota = await pedirNota({ titulo: c.nombre, pista: 'Di en pocas palabras qué vas a hacer.', etiqueta: 'Qué es', obligatoria: true, boton: 'Empezar' });
    if (nota === null) return;
  }
  const enviar = (extra = {}) => api('/api/comodin/crono', { method: 'POST', body: { accion: 'empezar', concepto: codigo, nota: nota || undefined, ...extra } });
  try {
    await enviar();
  } catch (e) {
    if (e.status === 409 && e.datos && e.datos.abierto) {
      const si = await elegir(`${e.message}. ¿Lo paras y empiezas con "${c.nombre}"?`, [{ etiqueta: 'Sí, pararlo y empezar', valor: 1 }]);
      if (!si) return;
      try { await enviar({ cerrar_otra: true }); } catch (e2) { if (e2.status !== 401) toast(e2.message, 'error'); return; }
    } else { if (e.status !== 401) toast(e.message, 'error'); return; }
  }
  toast(`Sin O.T.: ${c.nombre}`, 'ok');
  await cargarMiDia(true);
}

async function pararComodin() {
  try {
    await api('/api/comodin/crono', { method: 'POST', body: { accion: 'parar' } });
    toast('Cronómetro parado', 'ok');
  } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
  await cargarMiDia(true);
}

// --- Incidencias: tarjeta y diálogo de corrección -------------------------------
function tarjetaIncidencia(i, { oficina = false, gestionar = false, alCambiar = null } = {}) {
  const el = document.createElement('article');
  el.className = `incidencia e-${i.estado}`;
  el.dataset.id = i.id;
  const cambio = i.accion === 'anadir' ? `＋ ${esc(i.propuesta_texto)}`
    : i.accion === 'quitar' ? `− <s>${esc(i.antes_texto)}</s>`
      : `<s>${esc(i.antes_texto)}</s> → ${esc(i.propuesta_texto)}`;
  const pie = [`${i.directa ? 'Corregida' : 'Pedida'} el ${esc(fecha(i.creado))} por ${esc(i.solicitante_nombre)}`];
  if (i.estado !== 'pendiente' && !i.directa) pie.push(`${ESTADOS_INCIDENCIA[i.estado]} el ${esc(fecha(i.resuelto))}${i.estado === 'anulada' ? '' : ` por ${esc(i.resuelto_por_nombre || '')}`}`);
  el.innerHTML = `
    <div class="inc-cab"><b>${esc(i.accion_nombre)}</b><span>${esc(diaSemana(i.dia))}${i.ot_numero ? ` · O.T. ${esc(i.ot_numero)}` : ''}</span>${oficina ? `<span class="suave">· ${esc(i.tecnico_nombre)}</span>` : ''}<span class="chip e-${i.estado}">${esc(ESTADOS_INCIDENCIA[i.estado] || i.estado)}</span></div>
    <div class="inc-cambio">${cambio}</div>
    <div class="inc-motivo">${esc(i.motivo)}</div>
    ${i.respuesta ? `<div class="inc-pie"><b>Respuesta:</b> ${esc(i.respuesta)}</div>` : ''}
    <div class="inc-pie">${pie.join(' · ')}</div>
    <div class="inc-botones"></div>`;
  const botones = $('.inc-botones', el);
  const boton = (accion, texto, clase, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${clase}`;
    b.dataset.accion = accion;
    b.textContent = texto;
    b.onclick = async () => { b.disabled = true; try { await fn(); } finally { b.disabled = false; } };
    botones.append(b);
  };
  if (i.estado === 'pendiente' && gestionar) {
    boton('aprobar', '✓ Aprobar', 'btn-primario', () => resolverIncidencia(i, true, alCambiar));
    boton('rechazar', 'Rechazar', '', () => resolverIncidencia(i, false, alCambiar));
  }
  if (i.estado === 'pendiente' && i.solicitante_id === S.sesion.usuario.id) {
    boton('retirar', 'Retirar', '', async () => {
      try { await api(`/api/incidencias/${i.id}`, { method: 'DELETE' }); toast('Corrección retirada', 'ok'); } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
      if (alCambiar) await alCambiar();
    });
  }
  if (!botones.children.length) botones.remove();
  return el;
}

async function resolverIncidencia(i, aprobar, alCambiar) {
  let respuesta;
  if (!aprobar) {
    respuesta = await pedirNota({ titulo: 'Rechazar la corrección', pista: `${i.tecnico_nombre}: ${i.motivo}`, etiqueta: 'Por qué se rechaza', obligatoria: true, boton: 'Rechazar' });
    if (respuesta === null) return;
  }
  try {
    const r = await api(`/api/incidencias/${i.id}/resolver`, { method: 'POST', body: { aprobar, respuesta } });
    toast(aprobar ? 'Corrección aprobada y aplicada' : 'Corrección rechazada', 'ok');
    ponerContadorFichajes(r.pendientes);
  } catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
  if (alCambiar) await alCambiar();
}

const textoTramoPlano = (t) => `${horaCorta(t.inicio)}–${horaCorta(t.fin)} ${t.comodin_id ? `sin O.T. (${t.concepto_nombre || t.concepto})` : `${faseDe(t.tipo).nombre.toLowerCase()}, O.T. ${t.numero}`}`;

// Pide (técnico) o aplica (oficina con fichajes.gestionar) una corrección. accion: anadir | modificar | quitar.
// `detalle` es la respuesta de GET /api/jornadas/dia (técnico, día, O.T. imputables y conceptos).
function abrirCorreccion({ accion, tramo = null, detalle, oficina = false, alTerminar = null }) {
  const nodo = tpl('tpl-correccion');
  const form = ref('form', nodo);
  const titulos = oficina
    ? { anadir: 'Añadir un fichaje', modificar: 'Corregir el fichaje', quitar: 'Quitar el fichaje' }
    : { anadir: 'Pedir que se añada tiempo', modificar: 'Pedir una corrección', quitar: 'Pedir que se quite un fichaje' };
  ref('titulo', nodo).textContent = titulos[accion];
  ref('resumen', nodo).textContent = `${oficina ? `${detalle.tecnico.nombre} · ` : ''}${diaLargo(detalle.dia)}${tramo ? ` · ${textoTramoPlano(tramo)}` : ''}. `
    + (oficina ? 'Se aplica en el momento y queda anotado.' : 'La oficina tiene que aprobarla: hasta entonces el fichaje no cambia.');
  ref('guardar', nodo).textContent = oficina ? (accion === 'quitar' ? 'Quitar el fichaje' : 'Guardar') : 'Enviar a la oficina';
  const destino = form.elements.destino, tipo = form.elements.tipo, numero = form.elements.ot_numero;
  const ponerTipos = () => {
    const comodin = accion === 'anadir' ? destino.value === 'comodin' : !!(tramo && tramo.comodin_id);
    ref('et-tipo', nodo).textContent = comodin ? 'Concepto' : 'Tipo de tiempo';
    tipo.innerHTML = comodin
      ? detalle.conceptos.map((c) => `<option value="${esc(c.codigo)}">${esc(c.nombre)}</option>`).join('')
      : Object.entries(FASES).map(([k, f]) => `<option value="${k}">${esc(f.nombre)}</option>`).join('');
    if (!comodin && accion === 'anadir') tipo.value = 'trabajo';
    numero.classList.toggle('oculto', destino.value !== 'numero');
    numero.required = destino.value === 'numero';
  };
  // Ausencias (vacaciones, baja, festivo): al elegir una con las horas vacías se propone la jornada entera.
  tipo.onchange = () => {
    const c = accion === 'anadir' && destino.value === 'comodin' ? detalle.conceptos.find((x) => x.codigo === tipo.value) : null;
    if (!c || !c.ausencia || form.elements.inicio.value || form.elements.fin.value) return;
    form.elements.inicio.value = '08:00';
    form.elements.fin.value = horaDe(Math.min(8 * 60 + Math.round(detalle.horas_dia * 60), 23 * 60 + 59));
  };
  if (accion === 'anadir') {
    destino.innerHTML = detalle.ots.map((o) => `<option value="ot:${o.id}">O.T. ${esc(o.numero)} · ${esc(o.cliente_nombre)}</option>`).join('')
      + '<option value="comodin">Sin O.T. (comodín)</option>'
      + (oficina ? '<option value="numero">Otra O.T. (por número)…</option>' : '');
    destino.onchange = ponerTipos;
  } else ref('bloque-destino', nodo).classList.add('oculto');
  ponerTipos();
  if (accion === 'modificar') {
    tipo.value = tramo.comodin_id ? tramo.concepto : tramo.tipo;
    form.elements.inicio.value = horaCorta(tramo.inicio);
    form.elements.fin.value = horaCorta(tramo.fin);
  }
  if (accion === 'quitar') {
    ref('bloque-tipo', nodo).classList.add('oculto');
    ref('bloque-horas', nodo).classList.add('oculto');
    form.elements.inicio.required = form.elements.fin.required = false;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const body = { accion, motivo: form.elements.motivo.value.trim() };
    if (oficina) body.tecnico_id = detalle.tecnico.id;
    if (accion !== 'anadir') body.tramo_id = tramo.id;
    if (accion !== 'quitar') { body.inicio = form.elements.inicio.value; body.fin = form.elements.fin.value; }
    if (accion === 'anadir') {
      body.dia = detalle.dia;
      if (destino.value === 'comodin') { body.comodin = true; body.concepto = tipo.value; }
      else {
        body.tipo = tipo.value;
        if (destino.value === 'numero') body.ot_numero = numero.value.trim(); else body.ot_id = Number(destino.value.slice(3));
      }
    } else if (accion === 'modificar') {
      if (tramo.comodin_id) body.concepto = tipo.value; else body.tipo = tipo.value;
    }
    const guardar = ref('guardar', nodo);
    guardar.disabled = true;
    try {
      const r = await api('/api/incidencias', { method: 'POST', body });
      cerrarModal(nodo);
      toast(r.incidencia.estado === 'aprobada' ? 'Fichaje corregido' : 'Corrección enviada: la oficina tiene que aprobarla', 'ok');
      if (alTerminar) await alTerminar();
    } catch (err) {
      if (err.status !== 401) aviso(ref('avisos', nodo), err.message, 'error');
    } finally {
      guardar.disabled = false;
    }
  };
  abrirModal(nodo);
}

// --- Mis horas / horas de un técnico ---------------------------------------------
// La oficina llega aquí desde Fichajes con #horas/ID (no es una vista del menú para ella).
function mostrarHorasDe(id) {
  if (S.sesion.alcance === 'asignadas') { location.hash = 'horas'; return; }
  if (!puede('fichajes.ver')) { mostrarVista(vistaPorDefecto()); return; }
  pararPolling();
  pararPollingPlan();
  pararTecnico();
  S.vista = 'horas';
  S.horas.tecnicoId = id;
  for (const b of $$('#nav button[data-vista]')) b.classList.toggle('activo', b.dataset.vista === 'fichajes');
  for (const m of $$('#nav .menu')) m.classList.remove('activo');
  app.innerHTML = '';
  app.append(document.getElementById('tpl-horas').content.cloneNode(true));
  app.classList.remove('entra'); void app.offsetWidth; app.classList.add('entra');
  pintarHoras();
}

function pintarHoras() {
  const h = S.horas;
  if (h.abrir) h.mes = h.abrir.slice(0, 7);
  if (!h.mes) h.mes = hoyISO().slice(0, 7);
  h.datos = null;
  const volver = $('[data-accion="volver"]', app);
  volver.classList.toggle('oculto', !h.tecnicoId);
  volver.onclick = () => { location.hash = 'fichajes'; };
  $('[data-accion="mes-ant"]', app).onclick = () => { h.mes = sumarMes(h.mes, -1); cargarHoras(); };
  $('[data-accion="mes-sig"]', app).onclick = () => { h.mes = sumarMes(h.mes, 1); cargarHoras(); };
  cargarHoras();
}

async function cargarHoras() {
  const h = S.horas;
  if (S.vista !== 'horas') return;
  const mes = h.mes, tec = h.tecnicoId ? `&tecnico_id=${h.tecnicoId}` : '';
  ref('mes', app).textContent = mesLargo(mes);
  try {
    const [j, inc] = await Promise.all([api(`/api/jornadas?mes=${mes}${tec}`), api(`/api/incidencias?estado=todas&desde=${mes}-01&hasta=${finDeMes(mes)}${tec}`)]);
    if (S.vista !== 'horas' || h.mes !== mes) return;
    h.datos = { j, incidencias: inc.incidencias };
    if (h.tecnicoId) ponerContadorFichajes(j.incidencias_pendientes);
    renderHoras();
  } catch (e) {
    if (e.status === 401 || S.vista !== 'horas') return;
    ref('dias', app).innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
  }
}

function renderHoras() {
  const h = S.horas, { j, incidencias } = h.datos;
  const t = j.tecnicos[0];
  const oficina = !!h.tecnicoId;
  const dias = ref('dias', app), resumen = ref('resumen', app), cajaInc = ref('incidencias', app);
  ref('titulo', app).textContent = oficina ? `Horas de ${t ? t.nombre : '…'}` : 'Mis horas';
  if (!t) { resumen.innerHTML = ''; cajaInc.innerHTML = ''; dias.innerHTML = '<div class="vacio">Técnico no encontrado.</div>'; return; }

  // Resumen del mes.
  const tt = t.totales;
  const pill = (clase, etiqueta, valor, pie = '') => `<div class="pill ${clase}"><span>${etiqueta}</span><b>${valor}</b>${pie ? `<small>${pie}</small>` : ''}</div>`;
  resumen.innerHTML = pill('total', 'Fichado en el mes', duracionSeg(tt.total))
    + Object.entries(FASES).map(([k, f]) => pill(`fase-${k}`, `${f.icono} ${esc(f.nombre)}`, duracionSeg(tt[k]))).join('')
    + pill('fase-comodin', `${FASE_COMODIN.icono} Sin O.T.`, duracionSeg(tt.comodin))
    + (t.rol === 'tecnico'
      ? pill(`falta${tt.dias_bajos ? '' : ' bien'}`, `Días por debajo de ${j.horas_dia} h`, String(tt.dias_bajos), tt.falta ? `faltan ${duracionSeg(tt.falta)}` : 'todo justificado')
      : pill('falta bien', 'Jornada', '—', 'el SAT no la justifica'));

  // Correcciones del mes (pendientes arriba).
  const pend = incidencias.filter((i) => i.estado === 'pendiente').length;
  const estabaAbierto = !!$('details[open]', cajaInc);
  cajaInc.innerHTML = '';
  if (incidencias.length) {
    const det = document.createElement('details');
    det.open = pend > 0 || estabaAbierto;
    det.innerHTML = `<summary>Correcciones del mes <span class="chip chip-claro">${incidencias.length}</span><span class="n-pend">${pend || ''}</span></summary><div class="incidencias"></div>`;
    for (const i of incidencias) $('.incidencias', det).append(tarjetaIncidencia(i, { oficina: false, gestionar: oficina && !!j.puede_gestionar, alCambiar: cargarHoras }));
    cajaInc.append(det);
  }

  // Días: hasta hoy, los laborables y los que tengan fichajes; el más reciente arriba.
  const abiertos = new Set($$('.dia[open]', dias).map((d) => d.dataset.dia));
  if (h.abrir) abiertos.add(h.abrir);
  const laborable = new Set(j.dias.filter((d) => d.laborable).map((d) => d.dia));
  const lista = t.dias.filter((d) => d.estado !== 'futuro' && (d.tramos > 0 || laborable.has(d.dia))).reverse();
  dias.innerHTML = lista.length ? '' : '<div class="vacio">Este mes aún no tiene días que mostrar.</div>';
  const objetivo = j.horas_dia * 3600;
  for (const d of lista) {
    const det = document.createElement('details');
    det.className = `dia e-${d.estado}`;
    det.dataset.dia = d.dia;
    const base = Math.max(objetivo, d.total);
    const barra = ['desplazamiento', 'espera', 'trabajo', 'comodin'].filter((k) => d[k] > 0).map((k) => `<i class="fase-${k}" style="width:${((d[k] / base) * 100).toFixed(1)}%"></i>`).join('');
    const chips = [];
    if (d.estado === 'hoy') chips.push('<span class="dato-chip">Hoy</span>');
    if (d.estado === 'bajo') chips.push(`<span class="dato-chip falta">Faltan ${duracionSeg(d.falta)}</span>`);
    if (d.estado === 'sin_fichar') chips.push('<span class="dato-chip sin">Sin fichar</span>');
    if (d.abierto) chips.push('<span class="dato-chip fase-trabajo">En marcha</span>');
    if (d.revisar) chips.push('<span class="dato-chip revisar">⚠ Revisar</span>');
    if (d.pendientes) chips.push(`<span class="dato-chip revisar">⏳ ${d.pendientes} pendiente${d.pendientes > 1 ? 's' : ''}</span>`);
    det.innerHTML = `<summary><span class="dia-fecha">${esc(diaSemana(d.dia))}</span><span class="dia-barra">${barra}</span><b class="dia-total">${d.total ? duracionSeg(d.total) : '—'}</b><span class="dia-estado">${chips.join('')}</span></summary><div class="dia-cuerpo"><div class="vacio">Cargando…</div></div>`;
    det.addEventListener('toggle', () => { if (det.open) cargarDiaHoras(det); });
    dias.append(det);
    if (abiertos.has(d.dia)) det.open = true;
  }
  if (h.abrir) {
    const el = $(`.dia[data-dia="${h.abrir}"]`, dias);
    if (el) el.scrollIntoView({ block: 'center' });
    h.abrir = null;
  }
}

async function cargarDiaHoras(det) {
  const h = S.horas;
  try {
    const d = await api(`/api/jornadas/dia?dia=${det.dataset.dia}${h.tecnicoId ? `&tecnico_id=${h.tecnicoId}` : ''}`);
    if (det.isConnected) renderDiaHoras(det, d);
  } catch (e) {
    if (e.status !== 401 && det.isConnected) $('.dia-cuerpo', det).innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
  }
}

function renderDiaHoras(det, d) {
  const oficina = !!S.horas.tecnicoId;
  const puedeCorregir = oficina ? !!d.puede_gestionar : true;
  const cuerpo = $('.dia-cuerpo', det);
  cuerpo.innerHTML = '';
  if (d.tramos.length) {
    const ul = document.createElement('ul');
    ul.className = 'tramos tramos-dia';
    for (const t of d.tramos) {
      const li = document.createElement('li');
      li.className = `fase-${t.tipo}`;
      li.dataset.tramo = t.id;
      const f = faseDe(t.tipo);
      const que = t.comodin_id
        ? `${f.icono} Sin O.T. · ${esc(t.concepto_nombre || t.concepto)}`
        : `${f.icono} ${esc(f.nombre)} · O.T. ${esc(t.numero)} <small>${esc(t.cliente_nombre || '')}</small>`;
      const otroDia = t.fin && t.fin.slice(0, 10) !== t.inicio.slice(0, 10);
      const marcas = [];
      if (t.revisar) marcas.push('<span class="dato-chip revisar">⚠ Revisar</span>');
      if (t.origen === 'manual') marcas.push('<span class="dato-chip manual">Corregido</span>');
      if (t.incidencia_pendiente) marcas.push('<span class="dato-chip revisar">⏳ Corrección pedida</span>');
      li.innerHTML = `<span class="punto-fase"></span><span class="tr-hora">${horaCorta(t.inicio)}–${t.fin ? horaCorta(t.fin) + (otroDia ? ` (${esc(fecha(t.fin.slice(0, 10)).slice(0, 5))})` : '') : 'ahora'}</span>`
        + `<span class="tr-que">${que}${t.nota ? ` · <small>${esc(t.nota)}</small>` : ''}</span><b>${t.fin ? duracionSeg(t.segundos) : 'en marcha'}</b>`
        + (marcas.length ? `<span class="tr-marcas">${marcas.join('')}</span>` : '');
      if (puedeCorregir && t.fin && !t.incidencia_pendiente) {
        const bot = document.createElement('span');
        bot.className = 'tr-botones';
        bot.innerHTML = '<button type="button" class="btn btn-pequeno" data-accion="corregir">Corregir</button><button type="button" class="btn btn-pequeno" data-accion="quitar">Quitar</button>';
        $('[data-accion="corregir"]', bot).onclick = () => abrirCorreccion({ accion: 'modificar', tramo: t, detalle: d, oficina, alTerminar: cargarHoras });
        $('[data-accion="quitar"]', bot).onclick = () => abrirCorreccion({ accion: 'quitar', tramo: t, detalle: d, oficina, alTerminar: cargarHoras });
        li.append(bot);
      }
      ul.append(li);
    }
    cuerpo.append(ul);
  } else cuerpo.innerHTML = '<div class="vacio">Sin fichajes este día.</div>';
  if (puedeCorregir) {
    const pie = document.createElement('div');
    pie.className = 'dia-pie';
    pie.innerHTML = `<button type="button" class="btn" data-accion="anadir">＋ ${oficina ? 'Añadir un fichaje' : 'Añadir tiempo que falta'}</button>`;
    $('button', pie).onclick = () => abrirCorreccion({ accion: 'anadir', detalle: d, oficina, alTerminar: cargarHoras });
    cuerpo.append(pie);
  }
}

// --- Fichajes (oficina): jornadas de todos e incidencias ---------------------------
function pintarFichajes() {
  const f = S.fich;
  if (!f.mes) f.mes = hoyISO().slice(0, 7);
  const form = ref('filtros', app);
  form.elements.estado.value = f.filtros.estado;
  form.onsubmit = (e) => e.preventDefault();
  form.onchange = () => { f.filtros.estado = form.elements.estado.value; f.filtros.tecnico_id = form.elements.tecnico_id.value; cargarIncidenciasFichajes(); };
  for (const b of $$('[data-pestana]', app)) b.onclick = () => { f.pestana = b.dataset.pestana; ponerPestanaFichajes(); };
  $('[data-accion="mes-ant"]', app).onclick = () => { f.mes = sumarMes(f.mes, -1); cargarFichajes(); };
  $('[data-accion="mes-sig"]', app).onclick = () => { f.mes = sumarMes(f.mes, 1); cargarFichajes(); };
  ponerPestanaFichajes();
  cargarFichajes();
}

function ponerPestanaFichajes() {
  const f = S.fich;
  for (const b of $$('[data-pestana]', app)) b.classList.toggle('activo', b.dataset.pestana === f.pestana);
  ref('panel-jornadas', app).classList.toggle('oculto', f.pestana !== 'jornadas');
  ref('panel-incidencias', app).classList.toggle('oculto', f.pestana !== 'incidencias');
  ref('mes-nav', app).classList.toggle('oculto', f.pestana !== 'jornadas');
}

async function cargarFichajes() {
  const f = S.fich;
  if (S.vista !== 'fichajes') return;
  const mes = f.mes;
  ref('mes', app).textContent = mesLargo(mes);
  try {
    const j = await api(`/api/jornadas?mes=${mes}`);
    if (S.vista !== 'fichajes' || f.mes !== mes) return;
    f.datos = j;
    renderJornadas();
  } catch (e) {
    if (e.status === 401 || S.vista !== 'fichajes') return;
    ref('filas', app).innerHTML = `<tr><td class="suave">${esc(e.message)}</td></tr>`;
  }
  await cargarIncidenciasFichajes();
}

async function cargarIncidenciasFichajes() {
  const f = S.fich;
  if (S.vista !== 'fichajes') return;
  try {
    const r = await api(`/api/incidencias?estado=${f.filtros.estado}${f.filtros.tecnico_id ? `&tecnico_id=${f.filtros.tecnico_id}` : ''}`);
    if (S.vista !== 'fichajes') return;
    ponerContadorFichajes(r.pendientes);
    const lista = ref('lista', app);
    lista.innerHTML = r.incidencias.length ? '' : `<div class="vacio">${f.filtros.estado === 'pendiente' ? 'No hay incidencias pendientes.' : 'Sin incidencias.'}</div>`;
    for (const i of r.incidencias) lista.append(tarjetaIncidencia(i, { oficina: true, gestionar: !!r.puede_gestionar, alCambiar: cargarFichajes }));
  } catch (e) {
    if (e.status !== 401 && S.vista === 'fichajes') ref('lista', app).innerHTML = `<div class="vacio">${esc(e.message)}</div>`;
  }
}

function renderJornadas() {
  const j = S.fich.datos;
  const INICIAL = ['D', 'L', 'M', 'X', 'J', 'V', 'S'];
  ref('jornada', app).textContent = `Jornada de ${j.horas_dia} h, de lunes a viernes. Horas en decimal.`;
  ref('cabecera', app).innerHTML = `<tr><th class="f-tec">Técnico</th><th class="f-total">Total</th><th class="f-dato">Espera</th><th class="f-dato">Sin O.T.</th><th class="f-falta">Falta</th>${j.dias.map((d) =>
    `<th class="${d.laborable ? '' : 'finde'}${d.dia === j.hoy ? ' es-hoy' : ''}">${Number(d.dia.slice(8))}<small>${INICIAL[fechaLocal(d.dia).getDay()]}</small></th>`).join('')}</tr>`;
  const filas = ref('filas', app);
  filas.innerHTML = '';
  let bajos = 0;
  for (const t of j.tecnicos) {
    if (t.totales.dias_bajos) bajos += 1;
    const tr = document.createElement('tr');
    tr.dataset.tecnico = t.id;
    tr.innerHTML = `<td class="f-tec"><a href="#horas/${t.id}">${esc(t.nombre)}</a>${t.rol === 'sat' ? '<small>SAT externo</small>' : ''}${t.activo ? '' : '<small>Inactivo</small>'}</td>`
      + `<td class="f-total">${horasDec(t.totales.total)} h</td><td class="f-dato">${t.totales.espera ? `${horasDec(t.totales.espera)} h` : '—'}</td><td class="f-dato">${t.totales.comodin ? `${horasDec(t.totales.comodin)} h` : '—'}</td>`
      + `<td class="f-falta">${t.totales.falta ? `${horasDec(t.totales.falta)} h · ${t.totales.dias_bajos} d` : '—'}</td>`
      + t.dias.map((d) => {
        const texto = d.total > 0 ? horasDec(d.total) : (d.estado === 'sin_fichar' ? '0' : '');
        const titulo = `${diaSemana(d.dia)}: ${d.total ? duracionSeg(d.total) : 'sin fichajes'}${d.falta ? ` · faltan ${duracionSeg(d.falta)}` : ''}${d.revisar ? ' · fichaje a revisar' : ''}${d.pendientes ? ' · corrección pendiente' : ''}`;
        return `<td class="celda c-${d.estado}" data-dia="${d.dia}" title="${esc(titulo)}">${texto}${d.revisar || d.pendientes ? '<i class="marca"></i>' : ''}</td>`;
      }).join('');
    filas.append(tr);
  }
  if (!j.tecnicos.length) filas.innerHTML = '<tr><td class="suave">No hay técnicos.</td></tr>';
  filas.onclick = (e) => {
    const tr = e.target.closest('tr[data-tecnico]');
    if (!tr) return;
    S.horas.mes = S.fich.mes;
    const td = e.target.closest('td.celda');
    if (!td || td.classList.contains('c-futuro')) return;   // el enlace del nombre navega solo
    S.horas.abrir = td.dataset.dia;
    location.hash = `horas/${tr.dataset.tecnico}`;
  };
  ref('contador', app).textContent = bajos ? `${bajos} técnico${bajos > 1 ? 's' : ''} con días por debajo de ${j.horas_dia} h` : '';
  const sel = ref('filtros', app).elements.tecnico_id;
  sel.innerHTML = '<option value="">Todos</option>' + j.tecnicos.map((t) => `<option value="${t.id}">${esc(t.nombre)}</option>`).join('');
  sel.value = S.fich.filtros.tecnico_id;
}

// ---------------------------------------------------------------------------
// Vista: Listado (tabla)
// ---------------------------------------------------------------------------
function pintarListado() {
  const form = ref('filtros', app);
  const selFase = ref('fase', form);
  for (const f of S.fases) selFase.insertAdjacentHTML('beforeend', `<option value="${esc(f.codigo)}">${esc(f.nombre)}</option>`);
  const selEt = ref('etiqueta', form);
  for (const t of S.etiquetas) selEt.insertAdjacentHTML('beforeend', `<option value="${esc(t.codigo)}">${esc(t.nombre)}</option>`);
  selEt.insertAdjacentHTML('beforeend', '<option value="-">Sin etiqueta</option>');
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
        <td>${chipEstado(o)} ${chipEtiqueta(o)}</td>
        <td>${chipPrioridad(o.prioridad)}${esc(PRIORIDADES[o.prioridad] || '')}</td>
        <td>${esc(nombreTecnico(o))}</td>
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

// Controles de página anterior/siguiente bajo una tabla (clientes y máquinas, F3.5-06).
function pintarPaginacion(contenedor, datos, irA) {
  if (!contenedor) return;
  if (datos.total <= datos.limite) { contenedor.innerHTML = ''; return; }
  const desde = (datos.pagina - 1) * datos.limite + 1;
  const hasta = Math.min(datos.total, datos.pagina * datos.limite);
  contenedor.innerHTML = `<span>${desde}–${hasta} de ${datos.total.toLocaleString('es-ES')} · página ${datos.pagina} de ${datos.paginas}</span>
    <button class="btn btn-pequeno" type="button" data-accion="ant" ${datos.pagina <= 1 ? 'disabled' : ''} aria-label="Página anterior">‹</button>
    <button class="btn btn-pequeno" type="button" data-accion="sig" ${datos.pagina >= datos.paginas ? 'disabled' : ''} aria-label="Página siguiente">›</button>`;
  $('[data-accion="ant"]', contenedor).onclick = () => irA(datos.pagina - 1);
  $('[data-accion="sig"]', contenedor).onclick = () => irA(datos.pagina + 1);
}

// Refresca la vista de fondo tras un cambio hecho desde un modal.
function refrescarVista() {
  if (S.vista === 'kanban') { S.kanban.etag = null; cargarKanban(); }
  else if (S.vista === 'planificador') recargarPlan(true);
  else if (S.vista === 'midia') cargarMiDia(true);
  else if (S.vista === 'listado') cargarListado();
  else if (S.vista === 'clientes') cargarClientes();
  else if (S.vista === 'maquinas') cargarMaquinas();
  else if (S.vista === 'usuarios') cargarUsuarios();
}

// ---------------------------------------------------------------------------
// Vista: Clientes (maestro). Espejo local de Karve a partir de la Fase 5: aquí se crean a mano.
// ---------------------------------------------------------------------------
function pintarClientes() {
  const form = ref('filtros', app);
  let temporizador = null;
  const primera = () => { S.clientes.pagina = 1; cargarClientes(); };
  form.onsubmit = (e) => { e.preventDefault(); primera(); };
  form.elements.q.oninput = () => { clearTimeout(temporizador); temporizador = setTimeout(primera, 250); };
  form.elements.todos.onchange = primera;
  const nuevo = $('[data-accion="nuevo-cliente"]', app);
  if (nuevo) nuevo.onclick = () => abrirCliente(null);
  cargarClientes();
}

async function cargarClientes() {
  const form = ref('filtros', app);
  const filas = ref('filas', app);
  if (!form || !filas) return;
  const params = new URLSearchParams();
  const q = form.elements.q.value.trim();
  if (q) params.set('q', q);
  if (form.elements.todos.value) params.set('todos', '1');
  params.set('pagina', S.clientes.pagina);
  params.set('limite', S.clientes.limite);
  filas.classList.add('cargando');
  try {
    const datos = await api(`/api/clientes?${params}`);
    const clientes = datos.filas;
    ref('contador', app).textContent = `${datos.total.toLocaleString('es-ES')} cliente${datos.total === 1 ? '' : 's'}`;
    pintarPaginacion(ref('paginacion', app), datos, (p) => { S.clientes.pagina = p; cargarClientes(); });
    filas.innerHTML = '';
    if (!clientes.length) filas.innerHTML = '<tr><td colspan="6" class="vacio">Sin resultados</td></tr>';
    for (const c of clientes) {
      const tr = document.createElement('tr');
      tr.dataset.id = c.id;
      if (!c.activo || c.antiguo) tr.classList.add('inactivo');
      tr.innerHTML = `
        <td class="num">${esc(c.nombre)}${c.antiguo ? ' <span class="chip chip-claro" title="Más de 3 años sin factura">antiguo</span>' : ''}${c.activo ? '' : ' <span class="chip chip-claro">de baja</span>'}</td>
        <td>${esc(c.cif || '')}</td>
        <td>${esc(c.telefono || '')}</td>
        <td>${esc(c.tecnico_nombre || '')}${c.tecnico_telefono ? ` <span class="suave">${esc(c.tecnico_telefono)}</span>` : ''}</td>
        <td class="suave">${esc(c.comercial_nombre || '')}</td>
        <td class="suave">${esc(fecha(c.ultima_factura))}</td>`;
      tr.onclick = () => abrirCliente(c.id);
      filas.append(tr);
    }
  } catch (e) {
    if (e.status !== 401) filas.innerHTML = `<tr><td colspan="6" class="vacio">${esc(e.message)}</td></tr>`;
  } finally {
    filas.classList.remove('cargando');
  }
}

// Modal de alta (id null) o edición de un cliente. Sin clientes.gestionar se abre en solo lectura.
// F3-03: contactos de compras y técnico, correo de facturas y última factura; sin baja manual (regla de 3 años).
const CAMPOS_CLIENTE = ['nombre', 'cif', 'telefono', 'direccion', 'compras_nombre', 'compras_telefono', 'tecnico_nombre', 'tecnico_telefono', 'tecnico_email', 'email_facturas', 'ultima_factura', 'email'];
async function abrirCliente(id) {
  let cliente = null;
  if (id) {
    try { cliente = await api(`/api/clientes/${id}`); } catch (e) { if (e.status !== 401) toast(e.message, 'error'); return; }
  }
  const nodo = tpl('tpl-cliente');
  const form = ref('form', nodo);
  const avisos = ref('avisos', nodo);
  const guardar = ref('guardar', nodo);
  const editable = puede('clientes.gestionar');
  ref('titulo', nodo).textContent = cliente ? cliente.nombre : 'Nuevo cliente';

  // Comercial responsable (F2-05): solo comerciales activos; si el del cliente ya está de baja se muestra marcado.
  const selComercial = ref('comerciales', nodo);
  if (editable) {
    try {
      for (const v of await api('/api/comerciales')) selComercial.insertAdjacentHTML('beforeend', `<option value="${v.id}">${esc(v.nombre)}</option>`);
    } catch (e) { mostrarErrorAccion(e, avisos); }
  }
  if (cliente && cliente.comercial_id && !$(`option[value="${cliente.comercial_id}"]`, selComercial)) {
    selComercial.insertAdjacentHTML('beforeend', `<option value="${cliente.comercial_id}">${esc(cliente.comercial_nombre || 'Comercial')}${editable ? ' · desactivado' : ''}</option>`);
  }
  if (cliente) selComercial.value = cliente.comercial_id ? String(cliente.comercial_id) : '';

  // Máquinas del cliente: lista clicable (abre la ficha de la máquina) y alta directa con el cliente preseleccionado.
  const pintarMaquinasCliente = () => {
    const ul = ref('maquinas', nodo);
    const lista = cliente.maquinas || [];
    ul.innerHTML = lista.length ? '' : '<li class="nada">Sin máquinas</li>';
    for (const m of lista) {
      const li = document.createElement('li');
      if (!m.activo) li.classList.add('inactivo');
      const detalle = [m.bastidor, m.num_flota ? `flota ${m.num_flota}` : ''].filter(Boolean).join(' · ');
      li.innerHTML = `<b>${esc(nombreMaquina(m))}</b><span class="suave">${esc(detalle)}</span>${m.activo ? '' : '<span class="chip chip-claro">Desactivada</span>'}`;
      li.onclick = () => abrirMaquina(m.id, { alGuardar: recargarMaquinasCliente });
      ul.append(li);
    }
  };
  const recargarMaquinasCliente = async () => {
    try { cliente.maquinas = (await api(`/api/clientes/${cliente.id}`)).maquinas; pintarMaquinasCliente(); }
    catch (e) { if (e.status !== 401) toast(e.message, 'error'); }
  };
  // Contactos traídos de Karve (F3.5-03): solo lectura; los 3 principales ya van en los campos de arriba.
  const pintarContactos = () => {
    const lista = (cliente.contactos || []).filter((c) => c.activo);
    if (!lista.length) return;
    ref('bloque-contactos', nodo).classList.remove('oculto');
    const ul = ref('contactos', nodo);
    for (const c of lista) {
      const detalle = [c.cargo || c.departamento, c.telefono, c.email].filter(Boolean).join(' · ');
      ul.insertAdjacentHTML('beforeend', `<li><b>${esc(c.nombre)}</b><span class="suave">${esc(detalle)}</span></li>`);
    }
  };

  if (cliente) {
    for (const campo of CAMPOS_CLIENTE) form.elements[campo].value = cliente[campo] || '';
    form.elements.exige_pedido.checked = !!cliente.exige_pedido;
    ref('meta', nodo).innerHTML = `
      <div><span>Código Karve</span>${esc(cliente.karve_id || '—')}</div>
      <div><span>Alta</span>${esc(fecha(cliente.creado))}</div>
      <div><span>Actividad</span>${cliente.antiguo ? '<b>Antiguo</b>: más de 3 años sin factura' : (cliente.ultima_factura ? 'Con actividad' : 'Sin factura registrada')}${cliente.activo ? '' : ' · <b>de baja</b>'}</div>`;
    pintarMaquinasCliente();
    pintarContactos();
    const btnMaquina = ref('nueva-maquina', nodo);
    if (btnMaquina) {
      if (!cliente.activo) btnMaquina.classList.add('oculto'); // bajas heredadas: sin máquinas nuevas
      btnMaquina.onclick = () => abrirMaquina(null, { cliente, alGuardar: recargarMaquinasCliente });
    }
  } else {
    ref('meta', nodo).classList.add('oculto');
    ref('bloque-maquinas', nodo).classList.add('oculto');
  }
  if (!editable) {
    for (const el of $$('input, select, textarea', form)) el.disabled = true;
    guardar.classList.add('oculto');
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!editable) return;
    guardar.disabled = true;
    const body = { exige_pedido: form.elements.exige_pedido.checked, comercial_id: selComercial.value ? Number(selComercial.value) : null };
    for (const campo of CAMPOS_CLIENTE) body[campo] = form.elements[campo].value.trim() || null;
    try {
      if (cliente) {
        await api(`/api/clientes/${cliente.id}`, { method: 'PUT', body });
        toast('Cliente guardado', 'ok');
      } else {
        const nuevo = await api('/api/clientes', { method: 'POST', body });
        toast(`Cliente "${nuevo.nombre}" creado`, 'ok');
      }
      cerrarModal(nodo);
      refrescarVista();
    } catch (err) {
      mostrarErrorAccion(err, avisos);
    } finally {
      guardar.disabled = false;
    }
  };
  abrirModal(nodo);
}

// ---------------------------------------------------------------------------
// Vista: Máquinas (maestro). Mismo espejo de Karve que clientes; cada máquina pertenece a un cliente activo.
// ---------------------------------------------------------------------------
function nombreMaquina(m) {
  return [m.marca, m.modelo].filter(Boolean).join(' ') || m.bastidor || (m.num_flota ? `Flota ${m.num_flota}` : 'Máquina sin datos');
}

function textoHoras(h) {
  return h == null ? '' : `${Number(h).toLocaleString('es-ES', { maximumFractionDigits: 1 })} h`;
}

const ESTADOS_MAQUINA = { propia: 'Propia', rent_to_rent: 'Rent to Rent', subalquilada: 'Subalquilada', cliente_final: 'Cliente final' };

function pintarMaquinas() {
  const form = ref('filtros', app);
  let temporizador = null;
  const primera = () => { S.maquinas.pagina = 1; cargarMaquinas(); };
  form.onsubmit = (e) => { e.preventDefault(); primera(); };
  form.elements.q.oninput = () => { clearTimeout(temporizador); temporizador = setTimeout(primera, 250); };
  form.elements.todos.onchange = primera;
  const nueva = $('[data-accion="nueva-maquina"]', app);
  if (nueva) nueva.onclick = () => abrirMaquina(null);
  cargarMaquinas();
}

async function cargarMaquinas() {
  const form = ref('filtros', app);
  const filas = ref('filas', app);
  if (!form || !filas) return;
  const params = new URLSearchParams();
  const q = form.elements.q.value.trim();
  if (q) params.set('q', q);
  if (form.elements.todos.value) params.set('todos', '1');
  params.set('pagina', S.maquinas.pagina);
  params.set('limite', S.maquinas.limite);
  filas.classList.add('cargando');
  try {
    const datos = await api(`/api/maquinas?${params}`);
    const maquinas = datos.filas;
    ref('contador', app).textContent = `${datos.total.toLocaleString('es-ES')} máquina${datos.total === 1 ? '' : 's'}`;
    pintarPaginacion(ref('paginacion', app), datos, (p) => { S.maquinas.pagina = p; cargarMaquinas(); });
    filas.innerHTML = '';
    if (!maquinas.length) filas.innerHTML = '<tr><td colspan="6" class="vacio">Sin resultados</td></tr>';
    for (const m of maquinas) {
      const tr = document.createElement('tr');
      tr.dataset.id = m.id;
      if (!m.activo) tr.classList.add('inactivo');
      tr.innerHTML = `
        <td class="num">${esc(nombreMaquina(m))}${m.activo ? '' : ' <span class="chip chip-claro">Desactivada</span>'}</td>
        <td>${esc(m.bastidor || '')}</td>
        <td>${esc(m.num_flota || '')}</td>
        <td>${esc(m.cliente_nombre)}</td>
        <td>${esc(ESTADOS_MAQUINA[m.estado] || m.estado || '')}${m.num_contrato ? ` <span class="suave">${esc(m.num_contrato)}</span>` : ''}</td>
        <td class="suave">${esc(textoHoras(m.horometro_ultimo))}</td>`;
      tr.onclick = () => abrirMaquina(m.id);
      filas.append(tr);
    }
  } catch (e) {
    if (e.status !== 401) filas.innerHTML = `<tr><td colspan="6" class="vacio">${esc(e.message)}</td></tr>`;
  } finally {
    filas.classList.remove('cargando');
  }
}

// Modal de alta (id null) o edición de una máquina. Sin maquinas.gestionar se abre en solo lectura.
// opciones.cliente preselecciona el propietario (alta desde la ficha del cliente); opciones.alGuardar se llama tras guardar o desactivar.
// F3-04: tras el alta solo se editan horas y observaciones; el rol administrativo puede "Editar campos bloqueados".
const CAMPOS_BLOQUEADOS_MAQUINA = ['marca', 'modelo', 'bastidor', 'num_flota', 'estado', 'num_contrato', 'caracteristicas'];
async function abrirMaquina(id, { cliente = null, alGuardar = null } = {}) {
  let maquina = null;
  if (id) {
    try { maquina = await api(`/api/maquinas/${id}`); } catch (e) { if (e.status !== 401) toast(e.message, 'error'); return; }
  }
  const nodo = tpl('tpl-maquina');
  const form = ref('form', nodo);
  const avisos = ref('avisos', nodo);
  const guardar = ref('guardar', nodo);
  const btnActivo = ref('desactivar', nodo);
  const btnDesbloquear = ref('desbloquear', nodo);
  const selClientes = ref('clientes', nodo);
  const selEstado = ref('estado', nodo);
  const editable = puede('maquinas.gestionar');
  let desbloqueado = !maquina; // en el alta todo es editable
  ref('titulo', nodo).textContent = maquina ? nombreMaquina(maquina) : 'Nueva máquina';

  // Selector de cliente: activos (incluidos los antiguos, que pueden volver); las bajas heredadas no, salvo la propia.
  let clientes = [];
  let seleccionado = maquina ? String(maquina.cliente_id) : (cliente ? String(cliente.id) : '');
  const pintarClientes = (filtro = '') => {
    const f = filtro.trim().toLowerCase();
    selClientes.innerHTML = '';
    if (maquina && !maquina.cliente_activo) selClientes.insertAdjacentHTML('beforeend', `<option value="${maquina.cliente_id}">${esc(maquina.cliente_nombre)} · de baja</option>`);
    for (const c of clientes) {
      if (f && !c.nombre.toLowerCase().includes(f) && !(c.cif || '').toLowerCase().includes(f)) continue;
      selClientes.insertAdjacentHTML('beforeend', `<option value="${c.id}">${esc(c.nombre)}${c.cif ? ' · ' + esc(c.cif) : ''}</option>`);
    }
    if (seleccionado && $(`option[value="${seleccionado}"]`, selClientes)) selClientes.value = seleccionado;
  };
  try { clientes = (await api('/api/clientes?todos=1')).filter((c) => c.activo); } catch (e) { mostrarErrorAccion(e, avisos); }
  pintarClientes();
  ref('buscar-cliente', nodo).oninput = (e) => pintarClientes(e.target.value);
  selClientes.onchange = () => { seleccionado = selClientes.value; };

  // Nº de contrato solo si la máquina no es de cliente final.
  const ajustarContrato = () => {
    const sinContrato = selEstado.value === 'cliente_final';
    form.elements.num_contrato.disabled = sinContrato || !desbloqueado || !editable;
    if (sinContrato) form.elements.num_contrato.value = '';
  };
  selEstado.onchange = ajustarContrato;

  // Bloqueo tras el alta: solo horas y observaciones; administrativo puede desbloquear para corregir.
  const aplicarBloqueo = () => {
    for (const campo of CAMPOS_BLOQUEADOS_MAQUINA) form.elements[campo].disabled = !desbloqueado;
    form.elements.num_flota.readOnly = !desbloqueado;
    ref('buscar-cliente', nodo).disabled = !desbloqueado;
    selClientes.disabled = !desbloqueado;
    ajustarContrato();
    ref('aviso-bloqueo', nodo).classList.toggle('oculto', desbloqueado || !editable);
  };

  if (maquina) {
    for (const campo of ['marca', 'modelo', 'bastidor', 'num_flota', 'num_contrato', 'caracteristicas', 'observaciones']) form.elements[campo].value = maquina[campo] || '';
    selEstado.value = maquina.estado || 'cliente_final';
    form.elements.horometro_ultimo.value = maquina.horometro_ultimo == null ? '' : maquina.horometro_ultimo;
    ref('meta', nodo).innerHTML = `
      <div><span>Estado</span>${esc(ESTADOS_MAQUINA[maquina.estado] || maquina.estado || '—')}${maquina.num_contrato ? ' · contrato ' + esc(maquina.num_contrato) : ''}</div>
      <div><span>Código Karve</span>${esc(maquina.karve_id || '—')}</div>
      <div><span>O.T.</span>${maquina.num_ot}</div>
      <div><span>Alta</span>${esc(fecha(maquina.creado))}${maquina.activo ? '' : ' · <b>desactivada</b>'}</div>`;
    if (editable) {
      aplicarBloqueo();
      if (S.sesion.usuario.rol === 'administrativo') {
        btnDesbloquear.classList.remove('oculto');
        btnDesbloquear.onclick = () => {
          desbloqueado = true;
          aplicarBloqueo();
          btnDesbloquear.classList.add('oculto');
          aviso(avisos, 'Modo corrección: estás editando campos bloqueados de la máquina. Se guardan al pulsar Guardar.', 'conflicto');
          form.elements.marca.focus();
        };
      }
    }
  } else {
    ref('meta', nodo).classList.add('oculto');
    ajustarContrato();
  }
  if (!editable) {
    for (const el of $$('input, select, textarea', form)) el.disabled = true;
    guardar.classList.add('oculto');
  }

  if (maquina && editable) {
    btnActivo.classList.remove('oculto');
    btnActivo.textContent = maquina.activo ? 'Desactivar' : 'Reactivar';
    btnActivo.classList.toggle('btn-peligro', !!maquina.activo);
    btnActivo.onclick = async () => {
      const activar = !maquina.activo;
      if (!activar) {
        const r = await elegir(`¿Desactivar la máquina "${nombreMaquina(maquina)}"? Sus O.T. e historial se conservan.`, [{ etiqueta: 'Sí, desactivar', valor: 1, color: '#dc2626' }]);
        if (!r) return;
      }
      btnActivo.disabled = true;
      try {
        await api(`/api/maquinas/${maquina.id}`, { method: 'PUT', body: { activo: activar } });
        toast(activar ? 'Máquina reactivada' : 'Máquina desactivada', 'ok');
        cerrarModal(nodo);
        refrescarVista();
        if (alGuardar) alGuardar();
      } catch (e) {
        mostrarErrorAccion(e, avisos);
        btnActivo.disabled = false;
      }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!editable) return;
    const v = (n) => form.elements[n].value.trim() || null;
    const body = { horometro_ultimo: v('horometro_ultimo'), observaciones: v('observaciones') };
    if (desbloqueado) {
      const clienteId = Number(selClientes.value);
      if (!clienteId) { aviso(avisos, 'Elige el cliente propietario', 'error'); return; }
      Object.assign(body, { marca: v('marca'), modelo: v('modelo'), bastidor: v('bastidor'), estado: selEstado.value, num_contrato: selEstado.value === 'cliente_final' ? null : v('num_contrato'), caracteristicas: v('caracteristicas') });
      if (maquina) body.num_flota = v('num_flota');
      if (!maquina || clienteId !== maquina.cliente_id) body.cliente_id = clienteId; // solo si cambia (clientes de baja heredados)
    }
    guardar.disabled = true;
    try {
      if (maquina) {
        await api(`/api/maquinas/${maquina.id}`, { method: 'PUT', body });
        toast('Máquina guardada', 'ok');
      } else {
        const nueva = await api('/api/maquinas', { method: 'POST', body });
        toast(`Máquina "${nombreMaquina(nueva)}" creada con nº de flota ${nueva.num_flota}`, 'ok');
      }
      cerrarModal(nodo);
      refrescarVista();
      if (alGuardar) alGuardar();
    } catch (err) {
      mostrarErrorAccion(err, avisos);
    } finally {
      guardar.disabled = false;
    }
  };
  abrirModal(nodo);
}

// ---------------------------------------------------------------------------
// Vista: Usuarios (solo usuarios.gestionar). El acceso es propio de la app; karve_id enlaza con el operario de Karve (Fase 5).
// ---------------------------------------------------------------------------
const GRUPOS_ROL = {
  tecnico: { etiqueta: 'Técnico interno', clase: 'chip-naranja' },
  sat:     { etiqueta: 'SAT externo',     clase: 'chip-azul' },
  oficina: { etiqueta: 'Oficina',         clase: 'chip-claro' },
};

async function cargarRoles() {
  if (!S.roles) S.roles = (await api('/api/usuarios')).roles;
  return S.roles;
}

function rolDe(codigo) {
  return (S.roles || []).find((r) => r.codigo === codigo) || { codigo, nombre: codigo, grupo: 'oficina' };
}

// Chip del grupo (Técnico interno / SAT externo / Oficina); los de oficina llevan al lado el nombre del rol concreto.
function chipRol(codigo) {
  const r = rolDe(codigo);
  const g = GRUPOS_ROL[r.grupo] || GRUPOS_ROL.oficina;
  return `<span class="chip ${g.clase}" title="${esc(r.nombre)}">${g.etiqueta}</span>${r.grupo === 'oficina' ? `<span class="rol-nombre">${esc(r.nombre)}</span>` : ''}`;
}

function pintarUsuarios() {
  const form = ref('filtros', app);
  let temporizador = null;
  form.onsubmit = (e) => { e.preventDefault(); cargarUsuarios(); };
  form.elements.q.oninput = () => { clearTimeout(temporizador); temporizador = setTimeout(cargarUsuarios, 250); };
  form.elements.todos.onchange = cargarUsuarios;
  const nuevo = $('[data-accion="nuevo-usuario"]', app);
  if (nuevo) nuevo.onclick = () => abrirUsuario(null);
  cargarUsuarios();
}

async function cargarUsuarios() {
  const form = ref('filtros', app);
  const filas = ref('filas', app);
  if (!form || !filas) return;
  const params = new URLSearchParams();
  const q = form.elements.q.value.trim();
  if (q) params.set('q', q);
  if (form.elements.todos.value) params.set('todos', '1');
  filas.classList.add('cargando');
  try {
    const { roles, usuarios } = await api(`/api/usuarios?${params}`);
    S.roles = roles;
    ref('contador', app).textContent = `${usuarios.length} usuario${usuarios.length === 1 ? '' : 's'}`;
    filas.innerHTML = '';
    if (!usuarios.length) filas.innerHTML = '<tr><td colspan="6" class="vacio">Sin resultados</td></tr>';
    for (const u of usuarios) {
      const tr = document.createElement('tr');
      tr.dataset.id = u.id;
      if (!u.activo) tr.classList.add('inactivo');
      tr.innerHTML = `
        <td class="num">${esc(u.usuario)}${u.id === S.sesion.usuario.id ? ' <span class="chip chip-claro" title="Tu sesión">tú</span>' : ''}</td>
        <td>${esc(u.nombre)}</td>
        <td>${chipRol(u.rol)}</td>
        <td>${esc(u.email || '')}</td>
        <td class="suave">${esc(u.karve_id || '')}</td>
        <td>${u.activo ? '<span class="chip chip-ok">Activo</span>' : '<span class="chip chip-claro">Desactivado</span>'}</td>`;
      tr.onclick = () => abrirUsuario(u.id);
      filas.append(tr);
    }
  } catch (e) {
    if (e.status !== 401) filas.innerHTML = `<tr><td colspan="6" class="vacio">${esc(e.message)}</td></tr>`;
  } finally {
    filas.classList.remove('cargando');
  }
}

// Modal de alta (id null) o edición de un usuario. Contraseña obligatoria al crear; al editar, en blanco = no cambiarla.
// El propio usuario no puede desactivarse ni cambiarse el rol (la API también lo impide).
async function abrirUsuario(id) {
  let usuario = null;
  try {
    await cargarRoles();
    if (id) usuario = await api(`/api/usuarios/${id}`);
  } catch (e) { if (e.status !== 401) toast(e.message, 'error'); return; }
  const nodo = tpl('tpl-usuario');
  const form = ref('form', nodo);
  const avisos = ref('avisos', nodo);
  const guardar = ref('guardar', nodo);
  const btnActivo = ref('desactivar', nodo);
  const selRol = ref('roles', nodo);
  const soyYo = !!usuario && usuario.id === S.sesion.usuario.id;
  ref('titulo', nodo).textContent = usuario ? usuario.nombre : 'Nuevo usuario';
  for (const r of S.roles) selRol.insertAdjacentHTML('beforeend', `<option value="${esc(r.codigo)}">${esc(r.nombre)}</option>`);

  if (usuario) {
    for (const campo of ['usuario', 'nombre', 'email', 'karve_id']) form.elements[campo].value = usuario[campo] || '';
    selRol.value = usuario.rol;
    form.elements.clave.placeholder = 'En blanco: no cambia';
    ref('etiqueta-clave', nodo).textContent = 'Nueva contraseña (solo si quieres cambiarla)';
    ref('meta', nodo).innerHTML = `
      <div><span>Rol</span>${chipRol(usuario.rol)}</div>
      <div><span>O.T. asignadas</span>${usuario.num_ot}</div>
      <div><span>Último acceso</span>${usuario.ultimo_acceso ? esc(fecha(usuario.ultimo_acceso)) : 'nunca'}</div>
      <div><span>Alta</span>${esc(fecha(usuario.creado))}${usuario.activo ? '' : ' · <b>desactivado</b>'}</div>`;
    if (soyYo) { selRol.disabled = true; selRol.title = 'No puedes cambiar tu propio rol'; }
  } else {
    form.elements.clave.required = true;
    selRol.value = 'tecnico';
    ref('meta', nodo).classList.add('oculto');
  }

  if (usuario && !soyYo) {
    btnActivo.classList.remove('oculto');
    btnActivo.textContent = usuario.activo ? 'Desactivar' : 'Reactivar';
    btnActivo.classList.toggle('btn-peligro', !!usuario.activo);
    btnActivo.onclick = async () => {
      const activar = !usuario.activo;
      if (!activar) {
        const r = await elegir(`¿Desactivar a "${usuario.nombre}"? No podrá entrar; sus O.T. e historial se conservan.`, [{ etiqueta: 'Sí, desactivar', valor: 1, color: '#dc2626' }]);
        if (!r) return;
      }
      btnActivo.disabled = true;
      try {
        await api(`/api/usuarios/${usuario.id}`, { method: 'PUT', body: { activo: activar } });
        S.tecnicos = null;
        toast(activar ? 'Usuario reactivado' : 'Usuario desactivado: ya no puede entrar', 'ok');
        cerrarModal(nodo);
        refrescarVista();
      } catch (e) {
        mostrarErrorAccion(e, avisos);
        btnActivo.disabled = false;
      }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    guardar.disabled = true;
    const v = (n) => form.elements[n].value.trim() || null;
    const body = { usuario: v('usuario'), nombre: v('nombre'), email: v('email'), karve_id: v('karve_id') };
    if (!soyYo) body.rol = selRol.value;
    const clave = form.elements.clave.value;
    if (clave) body.clave = clave;
    try {
      if (usuario) {
        await api(`/api/usuarios/${usuario.id}`, { method: 'PUT', body });
        toast(clave ? 'Usuario guardado y contraseña cambiada' : 'Usuario guardado', 'ok');
        if (soyYo) { S.sesion.usuario.nombre = body.nombre; $('#usuario-nombre').textContent = body.nombre; }
      } else {
        const nuevo = await api('/api/usuarios', { method: 'POST', body });
        toast(`Usuario "${nuevo.usuario}" creado`, 'ok');
      }
      S.tecnicos = null;
      cerrarModal(nodo);
      refrescarVista();
    } catch (err) {
      mostrarErrorAccion(err, avisos);
    } finally {
      guardar.disabled = false;
    }
  };
  abrirModal(nodo);
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
  const chipEt = ref('etiqueta', nodo);
  chipEt.classList.toggle('oculto', !ot.etiqueta);
  if (ot.etiqueta) { chipEt.textContent = ot.etiqueta_nombre || ot.etiqueta; chipEt.style.background = ot.etiqueta_color || '#6b7280'; }
  ref('prioridad', nodo).textContent = `Prioridad ${PRIORIDADES[ot.prioridad] || ot.prioridad}`;
  // Bloques de planificación (F4-01/F4-02); quien planifica puede añadir uno desde aquí.
  const celdaBloques = ref('bloques', nodo);
  celdaBloques.textContent = ot.bloques && ot.bloques.length
    ? ot.bloques.map((b) => `${fecha(b.dia)} ${b.hora_inicio} · ${b.tecnico_nombre} · ${textoDuracion(b.duracion_min)}`).join(' | ')
    : (ot.fecha_prevista ? `Sin bloques · prevista ${fecha(ot.fecha_prevista)}` : 'Sin planificar');
  if (puede('planificador.editar') && !ot.es_final) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-pequeno btn-en-linea';
    b.dataset.accion = 'planificar';
    b.textContent = ot.bloques && ot.bloques.length ? '+ Bloque' : 'Planificar';
    b.onclick = () => abrirBloque({ ot, alTerminar: async () => { await recargarDetalle(nodo, ot.id); } });
    celdaBloques.append(' ', b);
  }
  ref('cliente', nodo).textContent = ot.cliente_nombre + (ot.exige_pedido ? ' · exige Nº pedido' : '');
  ref('maquina', nodo).textContent = textoMaquina(ot) || '—';
  ref('tecnico', nodo).textContent = ot.tecnico_nombre || (ot.karve_operario ? `${ot.karve_operario} (operario en Karve, sin usuario en la app)` : 'Sin asignar');
  ref('creado', nodo).textContent = `${fecha(ot.creado)}${ot.creado_por_nombre ? ' · ' + ot.creado_por_nombre : ''}${ot.fecha_cierre ? ' · cerrada ' + fecha(ot.fecha_cierre) : ''}`;
  // F3.6-01: lo que dice Karve de una O.T. importada (su estado y la fecha prevista), como referencia.
  const enKarve = [ot.karve_estado ? `estado ${ot.karve_estado}` : null, ot.fecha_prevista ? `prevista ${fecha(ot.fecha_prevista)}` : null].filter(Boolean);
  ref('fila-karve', nodo).classList.toggle('oculto', !enKarve.length);
  ref('karve', nodo).textContent = enKarve.join(' · ');
  // F4-06 / F4-05: tiempos fichados por fase frente a lo previsto, y el checklist con sus incidencias.
  const tm = ot.tiempo || {};
  ref('fila-tiempos', nodo).classList.toggle('oculto', !tm.total && !tm.en_marcha);
  ref('tiempos', nodo).textContent = Object.entries(FASES).map(([tipo, f]) => `${f.icono} ${f.nombre} ${duracionSeg(tm[tipo] || 0)}`).join(' · ')
    + (tm.previsto_min ? ` · previsto ${textoDuracion(tm.previsto_min)}` : '') + (tm.en_marcha ? ' · cronómetro en marcha' : '');
  const ck = ot.checklist || [];
  ref('fila-checklist', nodo).classList.toggle('oculto', !ck.length);
  ref('checklist', nodo).textContent = `${ck.filter((p) => p.resultado).length} de ${ck.length} respondidos`
    + ck.filter((p) => p.resultado === 'incidencia').map((p) => ` · ⚠ ${p.texto}: ${p.nota || ''}`).join('');

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

  // Cambio de estado (F4-04): un botón por vertical de destino → modal de dos preguntas; y la etiqueta dentro de la vertical actual.
  const secEstado = ref('sec-estado', nodo);
  const cont = ref('transiciones', nodo);
  cont.innerHTML = '';
  const destinos = ot.destinos || [];
  const formEt = ref('form-etiqueta', nodo);
  const etiquetasAqui = etiquetasDe(ot.estado);
  const puedeEtiquetar = puede('ot.cambiar_estado') && !ot.es_final && etiquetasAqui.length > 0;
  if (destinos.length || puedeEtiquetar) {
    secEstado.classList.remove('oculto');
    for (const t of destinos) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.style.borderColor = t.color || '#6b7280';
      b.textContent = `→ ${t.nombre}`;
      b.onclick = () => abrirCambioEstado(ot, t.codigo, { contenedorAvisos: avisos, alTerminar: async () => { await recargarDetalle(nodo, ot.id); refrescarVista(); } });
      cont.append(b);
    }
    formEt.classList.toggle('oculto', !puedeEtiquetar);
    if (puedeEtiquetar) {
      const sel = ref('etiquetas', formEt);
      sel.innerHTML = '<option value="">— Sin etiqueta —</option>' + etiquetasAqui.map((t) => `<option value="${esc(t.codigo)}">${esc(t.nombre)}</option>`).join('');
      sel.value = ot.etiqueta || '';
      formEt.onsubmit = async (e) => {
        e.preventDefault();
        aviso(avisos, null);
        try {
          await api(`/api/ot/${ot.id}`, { method: 'PUT', body: { version: ot.version, etiqueta: sel.value || null } });
          toast('Etiqueta cambiada', 'ok');
          await recargarDetalle(nodo, ot.id);
          refrescarVista();
        } catch (err) { mostrarErrorAccion(err, avisos, () => recargarDetalle(nodo, ot.id)); }
      };
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
    clientes = (await api('/api/clientes?todos=1')).filter((c) => c.activo); // un cliente antiguo puede volver con una O.T.
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
      cerrarModal(nodo);
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
