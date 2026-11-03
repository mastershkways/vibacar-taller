// scripts/generar-datos-prueba.js — Llena la base con datos ficticios realistas para ver la interfaz a pleno rendimiento.
//
//   node scripts/generar-datos-prueba.js            crea usuarios de prueba, 12 clientes, máquinas y 20 O.T. repartidas por el Kanban
//   node scripts/generar-datos-prueba.js --limpiar  antes BORRA todas las O.T., máquinas y clientes (los usuarios se conservan)
//   node scripts/generar-datos-prueba.js --anadir   añade otra tanda aunque ya haya datos (los clientes repetidos se reutilizan)
//
// Por seguridad no hace nada si ya hay clientes u O.T. y no se pasa --limpiar ni --anadir.
// Usa la misma BD, numeración (siguienteNumeroOT) y forma de los datos que el servidor
// (historial, asignaciones aprobadas, versiones). No hace falta parar el servidor.
// Los usuarios de prueba que falten se crean con la contraseña que se muestra al final.

const { db, ahora, hashClave } = require('../db');
const { siguienteNumeroFlota } = require('../numeracion');
const { siguienteNumeroOT } = require('../numeracion');

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--ayuda')) {
  console.log('Uso: node scripts/generar-datos-prueba.js [--limpiar | --anadir]');
  process.exit(0);
}
const limpiar = args.includes('--limpiar');
const anadir = args.includes('--anadir');
const CLAVE_PRUEBA = 'prueba123';

// ---------------------------------------------------------------------------
// Datos ficticios
// ---------------------------------------------------------------------------
// [usuario, nombre, rol, email, karve_id (código de operario en Karve, F2-04), activo]
const USUARIOS = [
  ['tecnico1',   'Mikel Etxeberria',  'tecnico',    'mikel@vibacar-pruebas.local', 'OP012', 1],
  ['tecnico2',   'Ane Zubiaurre',     'tecnico',    'ane@vibacar-pruebas.local',   'OP017', 1],
  ['tecnico3',   'Unai Larrañaga',    'tecnico',    'unai@vibacar-pruebas.local',  'OP009', 0], // se marchó: desactivado, sin O.T.
  ['sat1',       'SAT Bizkaia (ext.)','sat',        'sat@vibacar-pruebas.local',   'OP031', 1],
  ['recambista1','Jon Arrieta',       'recambista', 'jon@vibacar-pruebas.local',   null,    1],
  ['finanzas1',  'Leire Mendizabal',  'administrativo', 'leire@vibacar-pruebas.local', null, 1], // F3-05: antes financiero
  ['responsable1', 'Aitor Zelaia',    'responsable_st', 'aitor@vibacar-pruebas.local', null, 1], // F3-05
  ['gerencia1',  'Amaia Olaizola',    'gerencia',   'amaia@vibacar-pruebas.local', null,    1], // F3-05: solo lectura
  ['gestorsat1', 'Oihane Zabala',     'gestor_sat', 'oihane@vibacar-pruebas.local', null,   1], // F3-05: O.T. de SAT
  ['comercial1', 'Iker Goikoetxea',   'comercial',  'iker@vibacar-pruebas.local',  null,    1],
  ['jefeventas1','Nerea Olabarria',    'comercial_jefe', 'nerea@vibacar-pruebas.local', null, 1], // F2-05: ve la cartera de todos
];

// [nombre, cif, email, telefono, direccion, exige_pedido, origen, karve_id, activo]
const CLIENTES = [
  ['Excavaciones Garaio SL',             'B95123456', 'oficina@garaio.example',      '944 101 202', 'Polígono Erletxe, nave 4\n48960 Galdakao (Bizkaia)',   0, 'manual', null,      1],
  ['Áridos y Hormigones Ibaizabal SA',   'A48123457', 'compras@ibaizabal.example',   '946 300 150', 'Carretera Bilbao-Durango km 12\n48340 Amorebieta',    1, 'karve',  'C000214', 1],
  ['Transportes Urkiola SL',             'B48987654', 'taller@urkiola.example',      '946 812 340', 'Polígono Mallabiena 7\n48215 Iurreta',                0, 'manual', null,      1],
  ['Grúas Lezama',                       'B95345678', 'gruas@lezama.example',        '944 555 010', 'Barrio Aretxaga 3\n48196 Lezama',                     0, 'karve',  'C000331', 1],
  ['Construcciones Mendibil SA',         'A95222333', 'maquinaria@mendibil.example', '944 780 900', 'Gran Vía 45, 3º\n48011 Bilbao',                       1, 'karve',  'C000087', 1],
  ['Obras Públicas Nerbioi SL',          'B48555666', 'obras@nerbioi.example',       '946 720 111', 'Polígono Basauri 12\n48970 Basauri',                  0, 'manual', null,      1],
  ['Reciclajes Lautada SL',              'B01234567', 'planta@lautada.example',      '945 280 600', 'Polígono Jundiz, calle Lermandabide 8\n01015 Vitoria', 1, 'manual', null,      1],
  ['Canteras Arratia SA',                'A48777888', 'cantera@arratia.example',     '946 730 050', 'Barrio Urkizu s/n\n48140 Igorre',                     1, 'karve',  'C000152', 1],
  ['Forestal Gorbeia SL',                'B95888999', 'forestal@gorbeia.example',    '946 311 222', 'Zeanuri bidea 9\n48144 Zeanuri',                      0, 'manual', null,      1],
  ['Logística Portuaria Zierbena SA',    'A48999000', 'mantenimiento@zierbena.example', '946 364 700', 'Muelle AZ-1, Puerto de Bilbao\n48508 Zierbena',   0, 'karve',  'C000406', 1],
  ['Demoliciones Txorierri SL',          'B48111222', 'info@txorierri.example',      '944 530 400', 'Polígono Larrondo 2\n48180 Loiu',                     0, 'manual', null,      1],
  ['Maquinaria Usada Berriz SL',         'B48333444', 'ventas@berriz.example',       '946 826 900', 'Polígono Eitua 20\n48240 Berriz',                     0, 'karve',  'C000019', 1],
];
// F3-03: contactos y última factura por CIF. [compras_nombre, compras_telefono, tecnico_nombre, tecnico_telefono, tecnico_email, email_facturas, días desde la última factura (null = sin factura)]
// Txorierri y Berriz llevan más de 3 años sin factura: son los "antiguos" (no salen en el listado por defecto).
const CONTACTOS = {
  B95123456: ['Amaia Garaio', '944 101 203', 'Koldo Etxebarria', '688 101 204', 'taller@garaio.example', 'facturas@garaio.example', 45],
  A48123457: ['Nerea Uriarte', '946 300 151', 'Julen Aranburu', '677 300 152', 'mantenimiento@ibaizabal.example', 'proveedores@ibaizabal.example', 12],
  B48987654: ['Iñaki Urkiola', '946 812 341', 'Iñaki Urkiola', '699 812 342', 'taller@urkiola.example', 'taller@urkiola.example', 120],
  B95345678: ['Maite Lezama', '944 555 011', 'Gorka Lezama', '666 555 012', 'gruas@lezama.example', 'administracion@lezama.example', 30],
  A95222333: ['Compras Mendibil', '944 780 901', 'Asier Mendibil', '655 780 902', 'maquinaria@mendibil.example', 'facturas@mendibil.example', 200],
  B48555666: ['Eneko Nerbioi', '946 720 112', 'Eneko Nerbioi', '644 720 113', 'obras@nerbioi.example', 'obras@nerbioi.example', 400],
  B01234567: ['Leire Lautada', '945 280 601', 'Ander Lautada', '633 280 602', 'planta@lautada.example', 'contabilidad@lautada.example', 15],
  A48777888: ['Compras Arratia', '946 730 051', 'Unai Arratia', '622 730 052', 'cantera@arratia.example', 'facturas@arratia.example', 90],
  B95888999: ['Jon Gorbeia', '946 311 223', 'Jon Gorbeia', '611 311 224', 'forestal@gorbeia.example', 'forestal@gorbeia.example', null],
  A48999000: ['Compras Zierbena', '946 364 701', 'Mikel Zierbena', '600 364 702', 'mantenimiento@zierbena.example', 'facturacion@zierbena.example', 7],
  B48111222: ['Txomin Txorierri', '944 530 401', 'Txomin Txorierri', '699 530 402', 'info@txorierri.example', 'info@txorierri.example', 1500],
  B48333444: ['Ventas Berriz', '946 826 901', 'Patxi Berriz', '688 826 902', 'ventas@berriz.example', 'ventas@berriz.example', 1300],
};

// Máquinas por cliente (índice en CLIENTES): [marca, modelo, bastidor, num_flota, horometro]
const MAQUINAS = {
  0: [['Volvo', 'EC220E', 'VCEC220EK00312345', null, 4120], ['JCB', '3CX', 'JCB3CXSM0E2345678', 'G-07', 2890]],
  1: [['CAT', '320', 'CAT0320CKYBP01234', 'IB-12', 6540], ['Komatsu', 'WA320-8', 'KMTWA320C01V12345', 'IB-15', 3310], ['Ammann', 'ASC110', 'AMM110T0001234', 'IB-21', 1205]],
  2: [['Manitou', 'MT 1840', 'MAN1840EA0012345', 'U-03', 2760], ['Bobcat', 'S650', 'B3NL11234', 'U-08', 1980]],
  3: [['Liebherr', 'LTM 1050', 'W09LTM1050001234', null, 8900], ['Hitachi', 'ZX85US-6', 'HCM1ZX85US00123', null, 1450]],
  4: [['Komatsu', 'PC210LC-11', 'KMTPC210C01K12345', 'M-01', 5120], ['Hyundai', 'HX220L', 'HHKHZ501KL0001234', 'M-04', 2230], ['CAT', 'D6', 'CAT00D6TLGB01234', 'M-09', 7800]],
  5: [['Volvo', 'L90H', 'VCEL90HC00123456', 'N-02', 3650], ['Doosan', 'DX140LC-5', 'DHKCEBAPC01234', 'N-05', 2410]],
  6: [['CAT', '950M', 'CAT0950MAF5L01234', 'L-01', 9870], ['Kubota', 'KX080-4', 'KBCZ0801234567', null, 1670]],
  7: [['Volvo', 'A30G', 'VCEA30GC00123456', 'A-11', 6100], ['Komatsu', 'PC360LC-11', 'KMTPC360C01K54321', 'A-02', 7350]],
  8: [['Yanmar', 'ViO50-6', 'YNVIO50A0012345', null, 890], ['JCB', '540-170', 'JCB54017EA2345678', null, 2050]],
  9: [['Hyster', 'H16XM-12', 'HYSH16XM001234', 'Z-31', 11200], ['Konecranes', 'SMV 4531', 'KCSMV4531000123', 'Z-07', 9420], ['Wacker Neuson', 'EZ80', 'WNCEZ80A00012345', null, 640]],
  10: [['Hitachi', 'ZX350LC-6', 'HCM1ZX350K00123', null, 10300]],
  11: [],
};
// F3-04: estado y nº de contrato por bastidor (el resto: cliente_final sin contrato) y características técnicas de algunas.
const ESTADO_MAQUINA = {
  VCEC220EK00312345: ['rent_to_rent', 'RR-2025-014'], CAT0320CKYBP01234: ['propia', 'AL-2024-031'], KMTWA320C01V12345: ['propia', 'AL-2024-032'],
  W09LTM1050001234: ['subalquilada', 'SUB-2026-003'], KMTPC210C01K12345: ['rent_to_rent', 'RR-2026-007'], VCEL90HC00123456: ['propia', 'AL-2025-019'],
  HYSH16XM001234: ['rent_to_rent', 'RR-2025-041'], HCM1ZX350K00123: ['subalquilada', 'SUB-2025-011'],
};
const CARACTERISTICAS = {
  VCEC220EK00312345: 'Motor Volvo D6J 129 kW. Peso 22,5 t. Aceite hidráulico ISO VG 46 (300 l). Pares de apriete de rodillos 400 Nm.',
  CAT0320CKYBP01234: 'Motor Cat C4.4 122 kW. Cuchara 1,2 m³. Sistema hidráulico 2 bombas. Filtro de aire doble.',
  W09LTM1050001234: 'Grúa 50 t, pluma 38 m. Motor Daimler OM 906 LA. Presión de neumáticos 9 bar. Lubricación de la corona cada 50 h.',
  HYSH16XM001234: 'Carretilla 16 t. Motor Cummins QSB6.7. Neumáticos 12.00-24 macizos. Aceite de transmisión Dexron III.',
};
// Observaciones de algunas máquinas (por bastidor) y máquinas desactivadas (baja lógica).
const OBSERVACIONES = {
  VCEC220EK00312345: 'Trabaja en la cantera de Mañaria; acceso por pista, avisar antes de ir.',
  W09LTM1050001234: 'Grúa con revisión de equipo en marzo. El cliente pide siempre técnico con carné de gruista.',
  HYSH16XM001234: 'Carretilla en el muelle AZ-1; acceso al puerto de 7 a 19 h con acreditación.',
  KBCZ0801234567: 'Martillo hidráulico propio del cliente montado. Máquina vendida en 2026; queda de baja.',
};
const MAQUINAS_INACTIVAS = new Set(['KBCZ0801234567']);

// O.T.: [cliente, maquina (índice dentro del cliente o null), estado final, prioridad, tipo, origen, sintoma, descripcion, notas_internas, técnico (0/1 = tecnico1/2, 2 = sat1, null), días de antigüedad, extras]
// extras: { via: estados intermedios no estándar } | { propuesta: true } (propuesta de técnico pendiente de aprobar)
const OTS = [
  [0, 0, 'abierta',              1, 'correctivo', 'whatsapp', 'No arranca en frío',                              'El cliente dice que por las mañanas hay que darle tres o cuatro veces al contacto. Luego funciona bien.', 'Posible batería o precalentadores. Llevar comprobador.', null, 0],
  [2, 1, 'abierta',              2, 'correctivo', 'correo',   'Pierde aceite hidráulico por el brazo',           'Mancha de aceite bajo la máquina tras la jornada. Nivel baja un dedo cada dos días.', null, null, 1],
  [8, 0, 'abierta',              3, 'preventivo', 'manual',   'Revisión 500 h',                                  'Toca la revisión de las 500 h según el plan del fabricante.', null, null, 1],
  [1, 0, 'pendiente_repuesto',   2, 'correctivo', 'manual',   'Cadena destensada lado derecho',                  'El tensor no recupera. Hay que cambiar el cilindro tensor.', 'Pedido a Finanzauto, ref. 9W-7390. Plazo 5 días.', null, 4],
  [4, 1, 'pendiente_repuesto',   1, 'correctivo', 'whatsapp', 'Fuga de refrigerante por el radiador',            'Se vacía el vaso de expansión en media jornada. Radiador picado por una piedra.', null, 0, 6, { via: ['pendiente_asignacion', 'asignada', 'en_curso'] }],
  [3, 0, 'pendiente_asignacion', 1, 'correctivo', 'correo',   'Mando de la cesta no responde',                   'Los mandos superiores no hacen nada; desde abajo sí funciona. Grúa parada en obra.', 'Cliente prioritario: tiene una obra parada en Barakaldo.', null, 2, { propuesta: true }],
  [5, 0, 'pendiente_asignacion', 2, 'correctivo', 'manual',   'Luces de trabajo fundidas y bocina sin sonido',   null, null, null, 2],
  [9, 0, 'pendiente_asignacion', 2, 'preventivo', 'correo',   'Cambio de filtros y aceite 1000 h',               'Mantenimiento programado. El cliente pide hacerlo en fin de semana.', null, null, 3],
  [6, 0, 'asignada',             2, 'correctivo', 'manual',   'Freno de estacionamiento no retiene',             'En pendiente la máquina se desplaza con el freno puesto.', null, 0, 3],
  [7, 1, 'asignada',             1, 'correctivo', 'whatsapp', 'Error E-47 en pantalla y pérdida de potencia',    'Salta el error al cabo de una hora de trabajo. Baja de vueltas y se queda en modo limitado.', 'Mirar boletín de Komatsu sobre el sensor de presión de rail.', 1, 2],
  [1, 2, 'asignada',             3, 'preventivo', 'manual',   'Revisión anual del rodillo',                      null, null, 2, 5],
  [0, 1, 'en_curso',             2, 'correctivo', 'manual',   'Ruido en el giro de la torreta',                  'Chirrido metálico al girar a la izquierda. Empeora con la máquina caliente.', null, 0, 7],
  [4, 0, 'en_curso',             1, 'correctivo', 'correo',   'Vibración excesiva en la pluma',                  'Golpeteo en los bulones del balancín. Holgura visible.', 'Comprobar casquillos; probablemente hay que mecanizar.', 1, 8],
  [9, 1, 'en_curso',             2, 'correctivo', 'whatsapp', 'No eleva con carga',                              'Con el contenedor vacío sube; con carga se queda a mitad.', null, 2, 4],
  [2, 0, 'pausada',              2, 'correctivo', 'manual',   'Dirección dura y ruido en la bomba',              'Pausada: esperando autorización del cliente para abrir la bomba.', null, 1, 10],
  [7, 0, 'finalizada',           2, 'correctivo', 'correo',   'Fallo intermitente del alternador',               'Testigo de batería que parpadea. Carga irregular.', null, 0, 12],
  [1, 1, 'pendiente_pedido',     2, 'preventivo', 'manual',   'Revisión 2000 h y cambio de neumáticos',          null, 'Ibaizabal exige nº de pedido: reclamar a compras.', 1, 15],
  [5, 1, 'vb_factura',           3, 'correctivo', 'manual',   'Cristal de la cabina roto',                       'Cristal lateral derecho roto por una piedra.', null, 2, 18],
  [10, 0, 'cerrada',             2, 'correctivo', 'manual',   'Reparación del motor de traslación',              'Cerrada antes de la baja del cliente.', null, 0, 40],
  [3, 1, 'cerrada',              3, 'preventivo', 'correo',   'Revisión 250 h',                                  null, null, 1, 30],
];

// Camino estándar desde "abierta" hasta cada estado (los intermedios no estándar van en extras.via).
const CAMINOS = {
  abierta: [],
  pendiente_repuesto: ['pendiente_repuesto'],
  pendiente_asignacion: ['pendiente_asignacion'],
  asignada: ['pendiente_asignacion', 'asignada'],
  en_curso: ['pendiente_asignacion', 'asignada', 'en_curso'],
  pausada: ['pendiente_asignacion', 'asignada', 'en_curso', 'pausada'],
  finalizada: ['pendiente_asignacion', 'asignada', 'en_curso', 'finalizada'],
  pendiente_pedido: ['pendiente_asignacion', 'asignada', 'en_curso', 'finalizada', 'pendiente_pedido'],
  vb_factura: ['pendiente_asignacion', 'asignada', 'en_curso', 'finalizada', 'vb_factura'],
  cerrada: ['pendiente_asignacion', 'asignada', 'en_curso', 'finalizada', 'vb_factura', 'cerrada'],
};

const NOTAS = {
  pendiente_repuesto: ['Faltan piezas: pedido cursado al proveedor.', 'A la espera del repuesto.'],
  pendiente_asignacion: ['Pendiente de asignar técnico.', 'Lista para planificar.'],
  en_curso: ['Empiezo con la máquina en el taller.', 'Comienzo la intervención en casa del cliente.', 'Desmontando para diagnosticar.'],
  pausada: ['Pausada a la espera del cliente.'],
  finalizada: ['Reparación terminada y máquina probada. OK.', 'Trabajo terminado, entregada al cliente.'],
  pendiente_pedido: ['Pendiente de recibir el nº de pedido del cliente.'],
  vb_factura: ['Visto bueno para facturar.'],
  cerrada: ['Facturada y cerrada.'],
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, '0');
function fmt(d) {
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
}
// Fecha laborable aproximada: hace `dias` días, a una hora de taller.
function fechaHace(dias, horaBase = 8, minutosExtra = 0) {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  d.setHours(horaBase, (dias * 7 + minutosExtra) % 60, (dias * 13) % 60, 0);
  return d;
}
const elegir = (lista, i) => lista[i % lista.length];

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------
const nClientes = db.prepare('SELECT COUNT(*) n FROM clientes').get().n;
const nOT = db.prepare('SELECT COUNT(*) n FROM ot').get().n;
if ((nClientes || nOT) && !limpiar && !anadir) {
  console.error(`La base ya tiene ${nClientes} clientes y ${nOT} O.T. Usa --limpiar (borra O.T., máquinas y clientes) o --anadir (añade otra tanda).`);
  process.exit(1);
}

const admin = db.prepare("SELECT id, nombre FROM usuarios WHERE rol IN ('administrativo', 'responsable_st') AND activo = 1 ORDER BY id LIMIT 1").get();
if (!admin) { console.error('No hay ningún administrativo ni responsable activo. Arranca el servidor una vez con APP_USUARIO/APP_CLAVE.'); process.exit(1); }

const resumen = { usuariosCreados: [], clientes: 0, maquinas: 0, ots: 0, porFase: {} };

const generar = db.transaction(() => {
  if (limpiar) {
    for (const t of ['ot_asignaciones', 'ot_historial', 'ot', 'maquinas', 'clientes']) db.exec(`DELETE FROM ${t}`);
    console.log('   Borradas todas las O.T., máquinas y clientes.');
  }

  // Usuarios de prueba (solo los que falten)
  const usuarioPor = {};
  const insUsuario = db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol, email, karve_id, activo) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const [usuario, nombre, rol, email, karveId, activo] of USUARIOS) {
    let u = db.prepare('SELECT id, nombre, rol, karve_id FROM usuarios WHERE usuario = ?').get(usuario);
    if (!u) {
      const info = insUsuario.run(usuario, nombre, hashClave(CLAVE_PRUEBA), rol, email, karveId, activo);
      u = { id: info.lastInsertRowid, nombre, rol };
      resumen.usuariosCreados.push(`${usuario} (${rol}${activo ? '' : ', desactivado'})`);
    } else if (karveId && !u.karve_id) {
      db.prepare('UPDATE usuarios SET karve_id = ? WHERE id = ?').run(karveId, u.id); // F2-04: código de operario a los ya creados
    }
    usuarioPor[usuario] = u;
  }
  const tecnicos = [usuarioPor.tecnico1, usuarioPor.tecnico2, usuarioPor.sat1];
  const financiero = usuarioPor.finanzas1;
  const recambista = usuarioPor.recambista1;

  // Clientes (si ya existe uno con el mismo CIF se reutiliza)
  const insCliente = db.prepare('INSERT INTO clientes (nombre, cif, email, telefono, direccion, exige_pedido, origen, karve_id, activo, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const clienteIds = [];
  CLIENTES.forEach((c, i) => {
    const [nombre, cif, email, telefono, direccion, exigePedido, origen, karveId, activo] = c;
    const existente = db.prepare('SELECT id FROM clientes WHERE cif = ?').get(cif);
    if (existente) { clienteIds.push(existente.id); return; }
    const info = insCliente.run(nombre, cif, email, telefono, direccion, exigePedido, origen, karveId, activo, fmt(fechaHace(60 - i * 3, 9)));
    clienteIds.push(info.lastInsertRowid);
    resumen.clientes++;
  });
  // F3-03: contactos y última factura (también a los clientes que ya existían); los dos antiguos vuelven a activo = 1
  const updContactos = db.prepare('UPDATE clientes SET compras_nombre = ?, compras_telefono = ?, tecnico_nombre = ?, tecnico_telefono = ?, tecnico_email = ?, email_facturas = ?, ultima_factura = ?, activo = 1 WHERE cif = ?');
  for (const [cif, c] of Object.entries(CONTACTOS)) updContactos.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6] == null ? null : fmt(fechaHace(c[6], 10)).slice(0, 10), cif);
  // F2-05: cartera del comercial de prueba: Áridos Ibaizabal y Grúas Lezama (tienen O.T. en varias fases)
  db.prepare('UPDATE clientes SET comercial_id = ? WHERE id IN (?, ?)').run(usuarioPor.comercial1.id, clienteIds[1], clienteIds[3]);

  // Máquinas
  const insMaquina = db.prepare('INSERT INTO maquinas (cliente_id, marca, modelo, bastidor, num_flota, horometro_ultimo, karve_id, origen, observaciones, activo, estado, num_contrato, caracteristicas, creado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const maquinaIds = {};
  for (const [idx, lista] of Object.entries(MAQUINAS)) {
    maquinaIds[idx] = [];
    const cliente = CLIENTES[idx];
    lista.forEach(([marca, modelo, bastidor, flota, horas], j) => {
      const existente = db.prepare('SELECT id FROM maquinas WHERE bastidor = ?').get(bastidor);
      if (existente) { maquinaIds[idx].push(existente.id); return; }
      const karveId = cliente[6] === 'karve' ? `M${String(100 + Number(idx) * 10 + j).padStart(6, '0')}` : null;
      const [estado, contrato] = ESTADO_MAQUINA[bastidor] || ['cliente_final', null];
      // Sin nº de flota del cliente → se genera el de Vibacar (F-YY-XXXX); los de Karve se respetan.
      const info = insMaquina.run(clienteIds[idx], marca, modelo, bastidor, flota || siguienteNumeroFlota(), horas, karveId, karveId ? 'karve' : 'manual', OBSERVACIONES[bastidor] || null, MAQUINAS_INACTIVAS.has(bastidor) ? 0 : 1, estado, contrato, CARACTERISTICAS[bastidor] || null, fmt(fechaHace(55 - Number(idx) * 3, 10, j * 11)));
      maquinaIds[idx].push(info.lastInsertRowid);
      resumen.maquinas++;
    });
  }

  // O.T. (de más antigua a más reciente para que la numeración siga el orden cronológico)
  const insOT = db.prepare(`INSERT INTO ot (numero, anio, secuencia, cliente_id, maquina_id, estado, prioridad, tipo, origen, sintoma, descripcion, notas_internas, tecnico_id, creado_por, creado, actualizado, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insHist = db.prepare('INSERT INTO ot_historial (ot_id, estado_anterior, estado_nuevo, usuario_id, fecha, nota) VALUES (?, ?, ?, ?, ?, ?)');
  const insAsig = db.prepare(`INSERT INTO ot_asignaciones (ot_id, tecnico_id, origen, propuesto_por, estado, fecha, resuelto_por, resuelto_en, nota) VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?)`);
  const estadoPor = Object.fromEntries(db.prepare('SELECT codigo, fase FROM estados').all().map((e) => [e.codigo, e.fase]));

  const ordenadas = OTS.map((o, i) => ({ o, i })).sort((a, b) => b.o[10] - a.o[10] || a.i - b.i);
  let diaAnterior = null, enElDia = 0;
  for (const { o, i } of ordenadas) {
    const [ci, mi, estadoFinal, prioridad, tipo, origen, sintoma, descripcion, notas, tec, dias, extras = {}] = o;
    const camino = extras.via ? [...extras.via, estadoFinal] : CAMINOS[estadoFinal];
    const tecnico = tec === null ? null : tecnicos[tec];
    enElDia = dias === diaAnterior ? enElDia + 1 : 0; // varias O.T. el mismo día: horas crecientes para que el número siga la cronología
    diaAnterior = dias;
    const creado = fechaHace(dias, 8 + enElDia * 2, i * 9);
    const num = siguienteNumeroOT(creado.getFullYear());
    const pasosTotales = camino.length;
    const asignada = camino.includes('asignada') && tecnico;
    const version = 1 + pasosTotales + (asignada ? 1 : 0);
    const minutosPorPaso = Math.max(45, Math.floor((dias * 24 * 60 * 0.8) / Math.max(1, pasosTotales)));
    let fecha = new Date(creado);
    const ultima = () => fmt(fecha);
    const maquinaId = mi === null ? null : maquinaIds[ci][mi] ?? null;
    const info = insOT.run(num.numero, num.anio, num.secuencia, clienteIds[ci], maquinaId, 'abierta', prioridad, tipo, origen, sintoma, descripcion, notas, null, admin.id, fmt(creado), null, 1);
    const otId = info.lastInsertRowid;
    insHist.run(otId, null, 'abierta', admin.id, fmt(creado), 'Apertura de la O.T.');

    let anterior = 'abierta';
    camino.forEach((destino, k) => {
      fecha = new Date(fecha.getTime() + minutosPorPaso * 60000);
      let usuario = admin;
      let nota = elegir(NOTAS[destino] || [null], i + k);
      if (destino === 'asignada') {
        usuario = admin;
        nota = `Técnico asignado: ${tecnico.nombre}`;
        insAsig.run(otId, tecnico.id, admin.id, 'aprobada', fmt(new Date(fecha.getTime() - 10 * 60000)), admin.id, ultima(), null);
      } else if (['en_curso', 'pausada', 'finalizada'].includes(destino) && tecnico) {
        usuario = tecnico;
      } else if (['pendiente_pedido', 'vb_factura', 'cerrada'].includes(destino)) {
        usuario = financiero;
      } else if (destino === 'pendiente_repuesto' && anterior === 'abierta') {
        usuario = recambista;
      }
      insHist.run(otId, anterior, destino, usuario.id, ultima(), nota);
      anterior = destino;
    });
    if (extras.propuesta) {
      const propuesto = tecnicos[(i + 1) % 2];
      fecha = new Date(fecha.getTime() + 30 * 60000);
      insAsig.run(otId, propuesto.id, admin.id, 'propuesta', ultima(), null, null, 'Propongo a ' + propuesto.nombre + ', conoce la máquina.');
    }
    db.prepare('UPDATE ot SET estado = ?, tecnico_id = ?, version = ?, actualizado = ? WHERE id = ?')
      .run(estadoFinal, asignada ? tecnico.id : null, version, camino.length ? ultima() : null, otId);
    resumen.ots++;
    const fase = estadoPor[estadoFinal] || estadoFinal;
    resumen.porFase[fase] = (resumen.porFase[fase] || 0) + 1;
  }
});

try {
  generar.immediate();
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}

console.log(`✅ Datos de prueba generados: ${resumen.clientes} clientes, ${resumen.maquinas} máquinas y ${resumen.ots} O.T.`);
console.log('   O.T. por fase: ' + Object.entries(resumen.porFase).map(([f, n]) => `${f} ${n}`).join(' · '));
if (resumen.usuariosCreados.length) {
  console.log(`   Usuarios de prueba creados (contraseña "${CLAVE_PRUEBA}"): ${resumen.usuariosCreados.join(', ')}`);
} else {
  console.log('   Usuarios de prueba: ya existían todos.');
}
console.log('   Las pantallas se actualizan solas (el Tablero cada 10 s); no hace falta reiniciar el servidor.');
