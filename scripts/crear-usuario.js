// scripts/crear-usuario.js — Crea un usuario (o cambia la contraseña de uno existente) desde la consola.
//
//   node scripts/crear-usuario.js <usuario> <rol> "<Nombre completo>" [email]
//   node scripts/crear-usuario.js <usuario> --clave          (solo cambiar la contraseña)
//   node scripts/crear-usuario.js --roles                    (lista los roles válidos)
//
// La contraseña se pide por teclado sin mostrarla (nunca va en la línea de comandos ni en el .env).
// Usa la misma base y el mismo hash (scrypt) que el servidor; no hace falta que el servidor esté parado.
// Ejemplo:
//   node scripts/crear-usuario.js jperez tecnico "Juan Pérez" jperez@vibacar.com

const readline = require('readline');
const { db, ahora, hashClave } = require('../db');
const { ROLES, esRolValido } = require('../permisos');

const args = process.argv.slice(2);

function salir(mensaje, codigo = 1) {
  console[codigo ? 'error' : 'log'](mensaje);
  process.exit(codigo);
}

function listarRoles() {
  console.log('Roles válidos:');
  for (const [codigo, r] of Object.entries(ROLES)) console.log(`  ${codigo.padEnd(12)} ${r.nombre} — ${r.descripcion}`);
}

// Lectura línea a línea cuando no hay terminal (entrada por tubería): un único readline compartido.
let rl = null;
const lineas = [];
const esperando = [];
function leerLinea() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', (l) => { if (esperando.length) esperando.shift()(l); else lineas.push(l); });
    rl.on('close', () => { while (esperando.length) esperando.shift()(''); });
  }
  return new Promise((resolve) => { if (lineas.length) resolve(lineas.shift()); else esperando.push(resolve); });
}

// Pide una línea sin eco (contraseñas). Sin terminal, lee la siguiente línea de la entrada.
function pedirOculto(pregunta) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { leerLinea().then(resolve); return; }
    process.stdout.write(pregunta);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let valor = '';
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(valor);
      } else if (ch === '\u0003') { // Ctrl+C
        process.stdout.write('\n'); process.exit(130);
      } else if (ch === '\u007f' || ch === '\b') {
        valor = valor.slice(0, -1);
      } else {
        valor += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function pedirClave() {
  const clave = await pedirOculto('Contraseña (mínimo 6 caracteres): ');
  if (clave.length < 6) salir('La contraseña debe tener al menos 6 caracteres.');
  const repetida = await pedirOculto('Repite la contraseña: ');
  if (clave !== repetida) salir('Las contraseñas no coinciden.');
  return clave;
}

(async () => {
  if (!args.length || args.includes('--ayuda') || args.includes('-h')) {
    console.log('Uso:\n  node scripts/crear-usuario.js <usuario> <rol> "<Nombre completo>" [email]\n  node scripts/crear-usuario.js <usuario> --clave\n  node scripts/crear-usuario.js --roles');
    process.exit(0);
  }
  if (args[0] === '--roles') { listarRoles(); process.exit(0); }

  const usuario = String(args[0]).trim();
  if (!/^[a-z0-9._-]{3,40}$/i.test(usuario)) salir('El usuario debe tener 3-40 caracteres: letras, números, punto, guion o guion bajo.');
  const existente = db.prepare('SELECT id, nombre, rol, activo FROM usuarios WHERE usuario = ?').get(usuario);

  // Solo cambiar contraseña
  if (args[1] === '--clave') {
    if (!existente) salir(`No existe el usuario "${usuario}".`);
    console.log(`Cambiar la contraseña de "${usuario}" (${existente.nombre}, ${existente.rol}).`);
    const clave = await pedirClave();
    db.prepare('UPDATE usuarios SET clave_hash = ?, actualizado = ? WHERE id = ?').run(hashClave(clave), ahora(), existente.id);
    db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(existente.id);
    salir(`Contraseña de "${usuario}" cambiada. Sus sesiones abiertas se han cerrado.`, 0);
  }

  // Crear
  if (existente) salir(`Ya existe el usuario "${usuario}" (${existente.nombre}, ${existente.rol}${existente.activo ? '' : ', desactivado'}). Para cambiarle la contraseña: node scripts/crear-usuario.js ${usuario} --clave`);
  const rol = String(args[1] || '').trim();
  if (!esRolValido(rol)) { console.error(`Rol no válido: "${rol}".`); listarRoles(); process.exit(1); }
  const nombre = String(args[2] || '').trim();
  if (!nombre) salir('Falta el nombre completo (entre comillas si lleva espacios).');
  const email = args[3] ? String(args[3]).trim() : null;

  console.log(`Crear usuario "${usuario}" → ${nombre}, rol ${rol} (${ROLES[rol].nombre})${email ? ', ' + email : ''}.`);
  const clave = await pedirClave();
  const info = db.prepare('INSERT INTO usuarios (usuario, nombre, clave_hash, rol, email) VALUES (?, ?, ?, ?, ?)')
    .run(usuario, nombre, hashClave(clave), rol, email);
  salir(`Usuario "${usuario}" creado (id ${info.lastInsertRowid}). Ya puede entrar en la aplicación.`, 0);
})().catch((e) => salir(`Error: ${e.message}`));
