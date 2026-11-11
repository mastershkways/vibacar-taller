// permisos.js — Roles, acciones y matriz de permisos de Gestión de Taller Vibacar.
//
// ÚNICA FUENTE DE VERDAD. La usan:
//   - el backend: requierePermiso('ot.crear') en cada ruta, puede(rol, accion) en la lógica;
//   - el frontend: GET /api/sesion devuelve permisosDe(rol) y el alcance, para pintar u ocultar botones.
// Lo que vea el navegador es consecuencia; la barrera real está en el servidor.
//
// Este módulo no depende de la base de datos: db.js importa ROLES de aquí.

// ---------------------------------------------------------------------------
// Roles. El código es lo que se guarda en usuarios.rol.
// `alcance` recorta QUÉ O.T. puede ver cada rol (lo aplican las consultas):
//   todo             → todas las O.T.
//   asignadas        → solo las O.T. en las que es el técnico asignado
//   clientes_propios → solo las O.T. de sus clientes (relación vendedor↔cliente, pendiente de Karve)
// ---------------------------------------------------------------------------
// `grupo` agrupa los roles en la pantalla de usuarios: tecnico (interno) | sat (externo) | oficina (el resto).
// F3-05 (2026-11-02): roles del Field Service Management.
// F4-12 (2026-11-10): `gestor_sat` pasa a `operativo` (operativo administrativo): sus propias O.T. (las que abre él), las de
// SAT externos y las que aún no tienen técnico; lleva la comunicación con el cliente y el proveedor. Alcance `operativo`.
const ROLES = {
  administrativo: { nombre: 'Administrativo',                   alcance: 'todo',             grupo: 'oficina', descripcion: 'Ve y edita todo, incluidos los usuarios; único que corrige los campos bloqueados de una máquina' },
  responsable_st: { nombre: 'Responsable de Servicio Técnico',  alcance: 'todo',             grupo: 'oficina', descripcion: 'Toda la operativa: O.T., planificador, asignaciones y maestros; no gestiona usuarios' },
  gerencia:       { nombre: 'Gerencia',                         alcance: 'todo',             grupo: 'oficina', descripcion: 'Solo lectura de todo (Tablero, O.T., maestros, informes)' },
  operativo:      { nombre: 'Operativo administrativo',         alcance: 'operativo',        grupo: 'oficina', descripcion: 'Gestiona sus propias O.T. y las de SAT externos (y las sin técnico); comunicación con el cliente y el proveedor' },
  tecnico:        { nombre: 'Técnico / Operario',               alcance: 'asignadas',        grupo: 'tecnico', descripcion: 'Tablet: sus O.T., tiempos, checklist, fotos, firma' },
  sat:            { nombre: 'SAT externo',                      alcance: 'asignadas',        grupo: 'sat',     descripcion: 'Operario externo: solo sus asignaciones' },
  recambista:     { nombre: 'Recambista / Almacén',             alcance: 'todo',             grupo: 'oficina', descripcion: 'Entrada de material y repuestos por O.T.' },
  comercial:      { nombre: 'Comercial / Vendedor',             alcance: 'clientes_propios', grupo: 'oficina', descripcion: 'Solo lectura del estado de las O.T. de sus clientes' },
  comercial_jefe: { nombre: 'Jefe comercial',                   alcance: 'todo',             grupo: 'oficina', descripcion: 'Solo lectura del estado de las O.T. de todos los clientes' },
};

// Roles anteriores → nuevos. db.js los migra al arrancar (usuarios y transiciones). F4-12: gestor_sat → operativo.
const ROLES_ANTIGUOS = { admontaller: 'responsable_st', financiero: 'administrativo', gestor_sat: 'operativo' };

// F4-04 (flujo libre): a qué estados puede llevar una O.T. quien solo ve las suyas (técnico interno y SAT externo).
// El resto de roles con ot.cambiar_estado mueve a cualquier estado; los finales exigen además ot.cerrar.
const DESTINOS_ASIGNADAS = ['en_curso', 'pausada', 'finalizada'];

// ---------------------------------------------------------------------------
// Acciones. Nombre "zona.accion" y descripción (sirve para documentar y para la pantalla de usuarios).
// ---------------------------------------------------------------------------
const ACCIONES = {
  // Órdenes de trabajo
  'ot.ver':                 'Ver O.T. (dentro de su alcance)',
  'ot.crear':               'Abrir una O.T.',
  'ot.editar':              'Editar datos de la O.T. (cliente, máquina, síntoma, prioridad...)',
  'ot.cambiar_estado':      'Cambiar el estado y la etiqueta (flujo libre con confirmación; técnico y SAT solo a en curso, pausada o finalizada)',
  'ot.cerrar':              'Cerrar o reabrir una O.T. (estados finales)',
  'ot.asignar':             'Proponer un técnico para la O.T.',
  'ot.aprobar_asignacion':  'Aprobar o rechazar una propuesta de asignación',
  'ot.tiempos':             'Registrar inicio, pausas y fin de trabajo',
  'ot.checklist':           'Responder el checklist obligatorio',
  'ot.fotos':               'Subir fotos de inicio y fin',
  'ot.firmar':              'Recoger la firma en la tablet',
  'ot.repuestos':           'Vincular repuestos y entradas de material a la O.T.',
  'ot.facturacion':         'Albarán, reclamación de Nº de pedido, visto bueno factura',
  'ot.anular':              'Anular una O.T.',
  // Maestros
  'clientes.ver':           'Consultar clientes',
  'clientes.gestionar':     'Crear y editar clientes',
  'maquinas.ver':           'Consultar máquinas',
  'maquinas.gestionar':     'Crear y editar máquinas',
  // Administración
  'usuarios.gestionar':     'Crear, editar y desactivar usuarios',
  'estados.gestionar':      'Mantener fases, estados y transiciones',
  'contadores.gestionar':   'Fijar el contador de numeración de O.T.',
  'karve.sincronizar':      'Lanzar la sincronización de clientes y máquinas desde Karve',
  // Vistas
  'kanban.ver':             'Ver el Tablero (verticales por estado)',
  'planificador.ver':       'Ver el Planificador (calendario de bloques por técnico y día)',
  'planificador.editar':    'Planificar: crear, mover y quitar bloques de las O.T. de su alcance',
  'informes.ver':           'Ver informes y estadísticas',
};

// ---------------------------------------------------------------------------
// Matriz rol → acciones. administrativo tiene todas; responsable_st todas menos usuarios; el resto, lista explícita.
// ---------------------------------------------------------------------------
const TODAS = Object.keys(ACCIONES);

const MATRIZ = {
  administrativo: TODAS,
  responsable_st: TODAS.filter((a) => a !== 'usuarios.gestionar'),
  gerencia: ['ot.ver', 'clientes.ver', 'maquinas.ver', 'kanban.ver', 'planificador.ver', 'informes.ver'],
  operativo: ['ot.ver', 'ot.crear', 'ot.editar', 'ot.cambiar_estado', 'ot.cerrar', 'ot.asignar', 'ot.aprobar_asignacion', 'clientes.ver', 'maquinas.ver', 'kanban.ver', 'planificador.ver', 'planificador.editar'],

  tecnico: [
    'ot.ver', 'ot.cambiar_estado', 'ot.tiempos', 'ot.checklist', 'ot.fotos', 'ot.firmar',
    'clientes.ver', 'maquinas.ver',
  ],

  sat: [
    'ot.ver', 'ot.cambiar_estado', 'ot.tiempos', 'ot.checklist', 'ot.fotos', 'ot.firmar',
    'maquinas.ver',
  ],

  recambista: [
    'ot.ver', 'ot.cambiar_estado', 'ot.repuestos',
    'clientes.ver', 'maquinas.ver', 'kanban.ver',
  ],

  comercial: [
    'ot.ver', 'clientes.ver', 'maquinas.ver', 'kanban.ver',
  ],

  comercial_jefe: [
    'ot.ver', 'clientes.ver', 'maquinas.ver', 'kanban.ver',
  ],
};

// Comprobación al cargar: todo rol tiene matriz y toda acción de la matriz existe.
for (const rol of Object.keys(ROLES)) {
  if (!MATRIZ[rol]) throw new Error(`permisos.js: el rol "${rol}" no tiene fila en la matriz`);
  for (const a of MATRIZ[rol]) if (!ACCIONES[a]) throw new Error(`permisos.js: la acción "${a}" del rol "${rol}" no existe`);
}
for (const rol of Object.keys(MATRIZ)) {
  if (!ROLES[rol]) throw new Error(`permisos.js: la matriz tiene el rol "${rol}" que no está en ROLES`);
}

const PERMISOS = Object.fromEntries(Object.entries(MATRIZ).map(([rol, lista]) => [rol, new Set(lista)]));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
function esRolValido(rol) {
  return Object.prototype.hasOwnProperty.call(ROLES, rol);
}

function puede(rol, accion) {
  if (!esRolValido(rol)) return false;
  if (!ACCIONES[accion]) throw new Error(`permisos.js: acción desconocida "${accion}"`);
  return PERMISOS[rol].has(accion);
}

// Lista ordenada de acciones de un rol (para /api/sesion y el frontend).
function permisosDe(rol) {
  return esRolValido(rol) ? TODAS.filter((a) => PERMISOS[rol].has(a)) : [];
}

function alcanceDe(rol) {
  return esRolValido(rol) ? ROLES[rol].alcance : null;
}

// Resumen de un rol listo para enviar al navegador.
function describirRol(rol) {
  if (!esRolValido(rol)) return null;
  return { rol, nombre: ROLES[rol].nombre, alcance: ROLES[rol].alcance, permisos: permisosDe(rol) };
}

// Middleware Express: requierePermiso('ot.crear') o requierePermiso('ot.crear', 'ot.editar') (basta con una).
// Requiere que requiereSesion haya puesto req.usuario antes.
function requierePermiso(...acciones) {
  for (const a of acciones) if (!ACCIONES[a]) throw new Error(`permisos.js: acción desconocida "${a}" en requierePermiso`);
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ error: 'Sesión no iniciada' });
    if (acciones.some((a) => puede(req.usuario.rol, a))) return next();
    res.status(403).json({ error: 'No tienes permiso para esta acción', permiso: acciones.join(' | ') });
  };
}

module.exports = { ROLES, ROLES_ANTIGUOS, DESTINOS_ASIGNADAS, ACCIONES, MATRIZ, esRolValido, puede, permisosDe, alcanceDe, describirRol, requierePermiso };
