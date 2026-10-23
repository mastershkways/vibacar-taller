# Instalación de Gestión de Taller Vibacar

Cómo poner en marcha la aplicación desde cero en un PC o servidor Windows. El despliegue como servicio de Windows (NSSM, Node portable, actualización por zip) se documentará en `docs/DESPLIEGUE.md` cuando llegue la Fase 9.

## 1. Requisitos

- **Node.js 20 o superior** (probado con 22). Descarga: https://nodejs.org (versión LTS). Comprueba con `node -v`.
- **Git** para clonar el repositorio: https://git-scm.com.
- Acceso al repositorio `https://github.com/mastershkways/vibacar-taller`.

No hace falta instalar ninguna base de datos: la aplicación usa SQLite en un archivo local.

## 2. Clonar el repositorio

```
git clone https://github.com/mastershkways/vibacar-taller.git
cd vibacar-taller
```

## 3. Instalar dependencias

```
npm install
```

Instala `express`, `better-sqlite3` y `dotenv`. `better-sqlite3` descarga un binario precompilado para tu versión de Node; si en un PC concreto fallara esa descarga, `npm install` intentará compilarlo y necesitará las herramientas de compilación de Windows (Visual Studio Build Tools con C++ y Python). En un PC normal con Node LTS no hace falta nada.

## 4. Configuración: el archivo `.env`

Copia la plantilla y edítala:

```
copy .env.example .env
```

El `.env` **no se versiona** y es el único sitio donde van las credenciales. Variables:

| Variable | Qué es | Valor habitual |
|---|---|---|
| `PORT` | Puerto del servidor web | `3010` (facturación usa el 3000) |
| `APP_USUARIO` | Usuario administrador inicial. Solo se usa la **primera vez** que arranca, cuando no hay usuarios | `admin` |
| `APP_CLAVE` | Contraseña de ese administrador inicial. Si está vacía no se crea nadie y no se puede entrar | (ponla) |
| `SECRETO_COOKIE` | Cadena larga y aleatoria para firmar la cookie de sesión. Cambiarla cierra todas las sesiones | (genera una) |
| `SESION_DIAS` | Días que dura una sesión sin volver a pedir contraseña | `30` |
| `CONTADOR_OT_INICIAL` | Último número de O.T. real del año en curso (ver apartado 8) | `0` o el real |
| `COOKIE_SEGURA` | Opcional. `1` solo si se sirve por HTTPS (marca la cookie como Secure) | (sin definir) |
| `RUTA_BD` | Opcional. Ruta de la base de datos si no se quiere `.cache/datos.db` | (sin definir) |

Para generar un secreto:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Arrancar

```
node server.js
```

Verás algo así:

```
✅ Gestión de Taller Vibacar escuchando en http://localhost:3010
   BD: C:\...\vibacar-taller\.cache\datos.db (1 usuarios activos, 0 O.T.)
```

La primera vez se crea sola la base de datos en `.cache/datos.db` con las tablas, las fases y estados provisionales, las transiciones y el usuario administrador del `.env`. Las migraciones posteriores (columnas nuevas) también se aplican solas al arrancar: actualizar la aplicación nunca exige tocar la base a mano.

Para parar: `Ctrl+C`. Tras cambiar cualquier `.js` de la raíz hay que reiniciar; si solo cambia algo de `public/`, basta con recargar la página.

## 6. Primer acceso

1. Abre `http://localhost:3010` en el navegador (desde otro PC de la red, la IP del servidor y el puerto).
2. Entra con `APP_USUARIO` y `APP_CLAVE`.
3. La pantalla depende del rol: el administrador ve el Tablero; un técnico ve "Mis O.T."; el resto, el Listado.
4. Crea los clientes en la pestaña "Clientes" (o el primero directamente desde "+ Nueva O.T.", que también permite el alta rápida de cliente y máquina). Los clientes no se borran: se desactivan desde su ficha.

Tras 10 intentos fallidos de contraseña, un usuario queda bloqueado 15 minutos.

## 7. Crear usuarios

Desde la consola, en la carpeta del proyecto:

```
node scripts/crear-usuario.js jperez tecnico "Juan Pérez" jperez@vibacar.com
```

La contraseña se pide por teclado sin mostrarla. Roles válidos: `admontaller`, `tecnico`, `sat`, `recambista`, `financiero`, `comercial` (`node scripts/crear-usuario.js --roles` los describe). Para cambiar una contraseña:

```
node scripts/crear-usuario.js jperez --clave
```

Los usuarios también se pueden gestionar por la API (`/api/usuarios`, solo administradores); la pantalla de usuarios llega en la Fase 2.

## 8. Numeración de las O.T.

Las O.T. se numeran `AAAA-NNNN` (`2026-0001`). El histórico real está en Karve, así que antes de abrir la primera O.T. hay que decirle a la aplicación por dónde va el año:

```
node scripts/fijar-contador.js 412
```

significa "la última O.T. real de este año es la 0412; la próxima será la 0413". Sin parámetros muestra el contador y el próximo número. Alternativa: poner ese valor en `CONTADOR_OT_INICIAL` del `.env` antes de abrir la primera O.T. El script nunca deja bajar el contador por debajo de una O.T. ya existente salvo con `--forzar`.

## 9. Copias de seguridad

Todo está en `.cache/datos.db` (más `datos.db-wal` y `datos.db-shm` mientras el servidor está abierto). Para copiarla con el servidor en marcha, usa la copia en caliente de SQLite:

```
node -e "require('better-sqlite3')('.cache/datos.db').backup('copia-datos.db').then(()=>console.log('ok'))"
```

Con el servidor parado basta con copiar `datos.db`. Guarda también el `.env`.

## 10. Actualizar la aplicación

```
git pull
npm install
```

y reiniciar `node server.js`. El `.env` y `.cache/` nunca se tocan.

## 11. Servidor de pruebas sin molestar

Se puede levantar una segunda instancia en otro puerto, con otra base, para probar sin tocar los datos reales:

```
set PORT=5055
set RUTA_BD=C:\temp\prueba.db
node server.js
```

(en PowerShell: `$env:PORT=5055; $env:RUTA_BD='C:\temp\prueba.db'; node server.js`).

Para ver la interfaz con datos sin tener que crearlos a mano:

```
node scripts/generar-datos-prueba.js
```

Crea usuarios de prueba de todos los roles (`tecnico1`, `tecnico2`, `sat1`, `recambista1`, `finanzas1`, `comercial1`; la contraseña se muestra al terminar), 12 clientes (manuales y "de Karve", dos desactivados), sus máquinas y 20 O.T. repartidas por todas las columnas del Tablero, con historial y asignaciones. Se niega a ejecutarse si ya hay datos: `--limpiar` borra antes todas las O.T., máquinas y clientes (no los usuarios) y `--anadir` añade otra tanda. Respeta la numeración (sigue el contador) y no hace falta reiniciar el servidor. **Solo para bases de desarrollo o pruebas.**

## 12. Estructura de archivos

```
server.js            arranque Express, orden de montaje, errores
db.js                SQLite: apertura, migraciones, semillas, hash de contraseñas
numeracion.js        contador anual de O.T.
auth.js              acceso, sesiones, cookie firmada
permisos.js          roles, acciones y matriz de permisos (única fuente de verdad)
validar.js           validadores de entrada y ErrorHttp
rutas-maestros.js    API: clientes, máquinas, estados, técnicos, usuarios
rutas-ot.js          API: O.T., estados, asignaciones, Kanban
public/              interfaz: acceso.html, index.html, style.css, app.js, img/
scripts/             crear-usuario.js, fijar-contador.js, generar-datos-prueba.js
docs/                esta documentación
.cache/              base de datos (no se versiona)
.env                 configuración y credenciales (no se versiona)
```
