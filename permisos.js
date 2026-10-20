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
const ROLES = {
  admontaller: { nombre: 'Admontaller / Responsable', alcance: 'todo',             descripcion: 'Control total: Kanban, planificación, asignaciones, usuarios' },
  tecnico:     { nombre: 'Técnico / Operario',        alcance: 'asignadas',        descripcion: 'Tablet: sus O.T., tiempos, checklist, fotos, firma' },
  sat:         { nombre: 'SAT externo',               alcance: 'asignadas',        descripcion: 'Operario externo: solo sus asignaciones' },
  recambista:  { nombre: 'Recambista / Almacén',      alcance: 'todo',             descripcion: 'Entrada de material y repuestos por O.T.' },
  financiero:  { nombre: 'Financiero / Administración', alcance: 'todo',           descripcion: 'Facturación, albaranes, Nº de pedido, visto bueno factura' },
  comercial:   { nombre: 'Comercial / Vendedor',      alcance: 'clientes_propios', descripcion: 'Solo lectura del estado de las O.T. de sus clientes' },
};

// ---------------------------------------------------------------------------
// Acciones. Nombre "zona.accion" y descripción (sirve para documentar y para la pantalla de usuarios).
// ---------------------------------------------------------------------------
const ACCIONES = {
  // Órdenes de trabajo
  'ot.ver':                 'Ver O.T. (dentro de su alcance)',
  'ot.crear':               'Abrir una O.T.',
  'ot.editar':              'Editar datos de la O.T. (cliente, máquina, síntoma, prioridad...)',
  'ot.cambiar_estado':      'Cambiar el estado (siempre limitado por la tabla de transiciones y el rol)',
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
  // Vistas
  'kanban.ver':             'Ver el tablero Kanban',
  'informes.ver':           'Ver informes y estadísticas',
};

// ---------------------------------------------------------------------------
// Matriz rol → acciones. admontaller tiene todas; el resto, lista explícita.
// ---------------------------------------------------------------------------
const TODAS = Object.keys(ACCIONES);

const MATRIZ = {
  admontaller: TODAS,

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

  financiero: [
    'ot.ver', 'ot.cambiar_estado', 'ot.facturacion',
    'clientes.ver', 'clientes.gestionar', 'maquinas.ver', 'kanban.ver', 'informes.ver',
  ],

  comercial: [
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

module.exports = { ROLES, ACCIONES, MATRIZ, esRolValido, puede, permisosDe, alcanceDe, describirRol, requierePermiso };
