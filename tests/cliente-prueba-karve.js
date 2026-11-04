// Prueba HTTP de la sincronización con Karve (F3.5-03/04) contra server.js en 5055 con BD temporal con seed.
// Necesita KARVE_COPIA_CONNECTION_STRING en el .env (lo lee el servidor). Hace dos sincronizaciones reales (~40 s cada una).
const BASE = 'http://localhost:5055';
const res = [];
const ok = (nombre, cond, extra = '') => res.push(`${cond ? 'OK ' : 'FALLO'} ${nombre}${extra ? ' — ' + extra : ''}`);

async function pedir(ruta, { metodo = 'GET', cookie = '', body, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(BASE + ruta, { method: metodo, headers: h, body, redirect: 'manual' });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  return { s: r.status, j: json, t: texto, h: r.headers };
}
async function login(usuario, clave) {
  const r = await fetch(BASE + '/acceso', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, clave }) });
  if (r.status !== 200) throw new Error(`login ${usuario} → ${r.status}`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
const flotaKarve = (m) => (/^\d+$/.test(m.karve_id) ? String(Number(m.karve_id)) : m.karve_id); // F3.5-06: nº de flota = código de Karve sin ceros

(async () => {
  let x;
  const A = await login('admin_prueba', 'clave-prueba-123');
  const R = await login('responsable1', 'prueba123');
  const G = await login('gerencia1', 'prueba123');
  const T = await login('tecnico1', 'prueba123');

  x = await pedir('/api/karve/estado', { cookie: A });
  ok('GET /karve/estado → configurado, sin sincronización previa', x.s === 200 && x.j.configurado === true && x.j.en_curso === false && x.j.ultima === null, x.t);
  x = await pedir('/api/karve/estado', { cookie: G });
  ok('gerencia: GET /karve/estado → 403', x.s === 403);
  x = await pedir('/api/karve/sincronizar', { metodo: 'POST', cookie: G, body: {} });
  ok('gerencia: POST /karve/sincronizar → 403', x.s === 403);
  x = await pedir('/api/karve/sincronizar', { metodo: 'POST', cookie: T, body: {} });
  ok('técnico: POST /karve/sincronizar → 403', x.s === 403);

  // Primera sincronización (responsable_st) + una segunda petición simultánea que debe dar 409
  const t0 = Date.now();
  const [p1, p2] = await Promise.all([
    pedir('/api/karve/sincronizar', { metodo: 'POST', cookie: R, body: {} }),
    new Promise((r) => setTimeout(r, 1500)).then(() => pedir('/api/karve/sincronizar', { metodo: 'POST', cookie: A, body: {} })),
  ]);
  const r1 = p1.j;
  ok(`responsable_st: POST sincronizar → 200 en ${((Date.now() - t0) / 1000).toFixed(0)} s con resumen`, p1.s === 200 && r1 && r1.clientes && r1.duracion_ms > 0, p1.t.slice(0, 200));
  ok('segunda petición simultánea → 409 (ya hay una en curso)', p2.s === 409, `${p2.s}`);
  ok('clientes: ≥ 3.000 leídos y ≥ 2.900 nuevos', r1.clientes.leidos >= 3000 && r1.clientes.nuevos >= 2900, JSON.stringify(r1.clientes));
  ok('contactos: ≥ 3.000 nuevos y huecos de ficha rellenados', r1.contactos.nuevos >= 3000 && r1.contactos.huecos_rellenados > 100, JSON.stringify(r1.contactos));
  ok('máquinas: ≥ 4.000 nuevas, con avisos de bastidores y sin cliente', r1.maquinas.nuevos >= 4000 && r1.maquinas.sin_bastidor > 0 && r1.maquinas.bastidores_repetidos > 0 && r1.avisos.length >= 2, JSON.stringify(r1.maquinas));
  x = await pedir('/api/karve/estado', { cookie: A });
  ok('estado tras sincronizar: última ok, origen manual, usuario responsable1', x.s === 200 && x.j.ultima && x.j.ultima.estado === 'ok' && x.j.ultima.origen === 'manual' && x.j.ultima.usuario === 'Aitor Zelaia' && x.j.ultima.resumen.clientes.nuevos === r1.clientes.nuevos, JSON.stringify(x.j.ultima && { estado: x.j.ultima.estado, usuario: x.j.ultima.usuario }));

  // Clientes importados
  x = await pedir('/api/clientes?todos=1', { cookie: A });
  const todos = x.j;
  ok('GET /clientes?todos=1 → seed + Karve (≥ 3.050)', x.s === 200 && todos.length >= 3050, `n=${todos.length}`);
  const karveClientes = todos.filter((c) => c.origen === 'karve');
  ok('clientes de Karve con karve_id, zona precargada y creado = fecha de alta de Karve', karveClientes.length >= 3000 && karveClientes.every((c) => c.karve_id) && karveClientes.filter((c) => c.zona === 'Bizkaia').length > 2000 && karveClientes.some((c) => c.zona === 'Madrid'), `bizkaia=${karveClientes.filter((c) => c.zona === 'Bizkaia').length}`);
  x = await pedir('/api/clientes', { cookie: A });
  ok('GET /clientes (con actividad) → regla de 3 años ampliada deja entre 300 y 800', x.s === 200 && x.j.length >= 300 && x.j.length <= 800, `n=${x.j.length}`);
  ok('sin factura y alta antigua → antiguo (más de 1.000)', karveClientes.filter((c) => !c.ultima_factura && c.antiguo === 1).length > 1000, `${karveClientes.filter((c) => !c.ultima_factura && c.antiguo === 1).length}`);
  const alda = karveClientes.find((c) => c.karve_id === '0001851');
  ok('ALDAITURRIAGA (0001851): última factura 2026-09-30, con actividad, dirección y teléfono', !!alda && alda.ultima_factura === '2026-09-30' && alda.antiguo === 0 && !!alda.direccion && !!alda.telefono, alda && `${alda.nombre} ${alda.ultima_factura}`);
  ok('heurística de contactos: técnico y correo de facturas rellenados en cientos de clientes', karveClientes.filter((c) => c.tecnico_nombre).length >= 100 && karveClientes.filter((c) => c.email_facturas).length >= 50, `tecnico=${karveClientes.filter((c) => c.tecnico_nombre).length} facturas=${karveClientes.filter((c) => c.email_facturas).length}`);
  const conTecnico = karveClientes.find((c) => c.tecnico_nombre);
  x = await pedir(`/api/clientes/${conTecnico.id}`, { cookie: A });
  ok('ficha: contactos de Karve en la respuesta', x.s === 200 && Array.isArray(x.j.contactos) && x.j.contactos.length >= 1 && x.j.contactos.every((c) => c.nombre), `contactos=${x.j.contactos && x.j.contactos.length}`);

  // Máquinas importadas
  x = await pedir('/api/maquinas?todos=1', { cookie: A });
  const maqs = x.j;
  const maqKarve = maqs.filter((m) => m.origen === 'karve' && /^\d{5,7}$/.test(m.karve_id || '')); // las del seed llevan karve_id ficticio (M000…)
  ok('GET /maquinas?todos=1 → ≥ 4.000 de Karve con nº de flota = código de Karve sin ceros (0003641 → 3641) y estado propia/cliente_final', maqKarve.length >= 4000 && maqKarve.every((m) => m.num_flota === flotaKarve(m) && ['propia', 'cliente_final'].includes(m.estado)), `n=${maqKarve.length} ej=${maqKarve[0] && maqKarve[0].karve_id + '→' + maqKarve[0].num_flota}`);
  x = await pedir('/api/maquinas?pagina=1&limite=50', { cookie: A });
  ok('paginación máquinas: ?pagina=1&limite=50 → 50 filas, total ≥ 4.000 y nº de páginas', x.s === 200 && x.j.filas.length === 50 && x.j.total >= 4000 && x.j.paginas === Math.ceil(x.j.total / 50) && x.j.pagina === 1, `total=${x.j.total} paginas=${x.j.paginas}`);
  const primera = x.j.filas[0].id;
  x = await pedir('/api/maquinas?pagina=2&limite=50', { cookie: A });
  ok('paginación máquinas: la página 2 empieza por otra máquina', x.s === 200 && x.j.pagina === 2 && x.j.filas.length === 50 && x.j.filas[0].id !== primera);
  x = await pedir('/api/clientes?pagina=1&limite=10&todos=1', { cookie: A });
  ok('paginación clientes: ?pagina=1&limite=10&todos=1 → 10 filas y total ≥ 3.050', x.s === 200 && x.j.filas.length === 10 && x.j.total >= 3050, `total=${x.j.total}`);
  x = await pedir('/api/clientes?pagina=1&limite=1000', { cookie: A });
  ok('paginación: el límite se recorta a 500', x.s === 200 && x.j.limite === 500 && x.j.filas.length <= 500);
  ok('máquinas: hay propias, hay características (tipo/motor) y el seed conserva su flota (IB-12)', maqKarve.some((m) => m.estado === 'propia') && maqKarve.filter((m) => m.caracteristicas).length > 1000 && maqs.some((m) => m.num_flota === 'IB-12'), `propias=${maqKarve.filter((m) => m.estado === 'propia').length}`);
  const maqPrueba = maqKarve.find((m) => m.estado === 'cliente_final' && m.activo === 1);

  // Cambios manuales: lo que Karve trae se repone; lo que no trae se conserva
  x = await pedir(`/api/clientes/${alda.id}`, { metodo: 'PUT', cookie: A, body: { nombre: 'NOMBRE CAMBIADO A MANO', compras_nombre: 'Compras Manual', compras_telefono: '600 000 000' } });
  ok('admin: edita nombre (de Karve) y contacto de compras (manual) de un cliente de Karve', x.s === 200 && x.j.nombre === 'NOMBRE CAMBIADO A MANO');
  x = await pedir(`/api/maquinas/${maqPrueba.id}`, { metodo: 'PUT', cookie: A, body: { estado: 'rent_to_rent', num_contrato: 'RR-PRUEBA-1' } });
  ok('admin: reclasifica una máquina de Karve a rent_to_rent', x.s === 200 && x.j.estado === 'rent_to_rent', x.t.slice(0, 200));

  const t1 = Date.now();
  x = await pedir('/api/karve/sincronizar', { metodo: 'POST', cookie: A, body: {} });
  const r2 = x.j;
  ok(`segunda sincronización (${((Date.now() - t1) / 1000).toFixed(0)} s): idempotente salvo el nombre repuesto (clientes 0 nuevos / 1 actualizado; contactos y máquinas 0 / 0)`,
    x.s === 200 && r2.clientes.nuevos === 0 && r2.clientes.actualizados === 1 && r2.contactos.nuevos === 0 && r2.contactos.actualizados === 0 && r2.maquinas.nuevos === 0 && r2.maquinas.actualizados === 0,
    `clientes ${r2.clientes.nuevos}/${r2.clientes.actualizados} contactos ${r2.contactos.nuevos}/${r2.contactos.actualizados} maquinas ${r2.maquinas.nuevos}/${r2.maquinas.actualizados}`);
  x = await pedir(`/api/clientes/${alda.id}`, { cookie: A });
  ok('tras resincronizar: el nombre vuelve al de Karve y el contacto de compras manual se conserva', x.s === 200 && x.j.nombre !== 'NOMBRE CAMBIADO A MANO' && /ALDAITURRIAGA/.test(x.j.nombre) && x.j.compras_nombre === 'Compras Manual', `${x.j.nombre} / ${x.j.compras_nombre}`);
  x = await pedir(`/api/maquinas/${maqPrueba.id}`, { cookie: A });
  ok('tras resincronizar: la máquina sigue rent_to_rent con su contrato', x.s === 200 && x.j.estado === 'rent_to_rent' && x.j.num_contrato === 'RR-PRUEBA-1');
  x = await pedir('/api/karve/estado', { cookie: A });
  ok('estado: la última sincronización es la segunda (usuario admin)', x.s === 200 && x.j.ultima.usuario === 'Administrador' && x.j.ultima.resumen.clientes.actualizados === 1);

  console.log(res.join('\n'));
  const fallos = res.filter((r) => r.startsWith('FALLO')).length;
  console.log(`\n${res.length - fallos}/${res.length} OK, ${fallos} fallos`);
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); console.log(res.join('\n')); process.exit(1); });
