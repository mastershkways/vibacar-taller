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
4. Crea los clientes en Maestros → "Clientes" (o el primero directamente desde "+ Nueva O.T.", que también permite el alta rápida de cliente y máquina). La ficha lleva contacto de compras, contacto técnico, correo de facturas y fecha de la última factura. Los clientes no se borran ni se desactivan: el que lleva más de 3 años sin factura pasa a "antiguo" y solo aparece con "Mostrar: Todos" (la fecha vendrá de Karve).
5. Las máquinas, en Maestros → "Máquinas" o desde la ficha de su cliente (botón "+ Máquina"). El nº de flota se asigna solo al guardar (`F-26-0001`, correlativo por año); el bastidor no puede repetirse; el nº de contrato solo se pide si la máquina no es de cliente final. Tras el alta solo se cambian horas y observaciones: un administrativo tiene el botón "Editar campos bloqueados" para corregir errores. También se desactivan en vez de borrarse.
6. El personal, en la pestaña "Usuarios" (solo administradores): usuario, nombre, email, rol, código de operario en Karve y contraseña. Al editar, la contraseña en blanco no se toca; escribir una nueva la cambia. Desactivar a alguien bloquea su acceso al instante (y cierra su sesión) sin borrar sus O.T.; nadie puede desactivarse ni cambiarse el rol a sí mismo.
7. Cada cliente puede tener un "Comercial responsable" (selector en su ficha, solo usuarios activos con rol comercial). Un usuario con rol comercial solo ve los clientes de su cartera, sus máquinas y sus O.T., en el Listado y en el Tablero; el resto le da "no encontrado". Quien no tenga cartera no ve nada hasta que se le asigne. El rol "Jefe comercial" tiene los mismos permisos pero ve todos los clientes.

Tras 10 intentos fallidos de contraseña, un usuario queda bloqueado 15 minutos.

## 7. Crear usuarios

Desde la consola, en la carpeta del proyecto:

```
node scripts/crear-usuario.js jperez tecnico "Juan Pérez" jperez@vibacar.com
```

La contraseña se pide por teclado sin mostrarla. Roles válidos: `administrativo`, `responsable_st`, `gerencia`, `gestor_sat`, `tecnico`, `sat`, `recambista`, `comercial`, `comercial_jefe` (los antiguos `admontaller` y `financiero` se migran solos al arrancar: el usuario de `APP_USUARIO` pasa a `administrativo`, el resto de `admontaller` a `responsable_st` y `financiero` a `administrativo`) (`node scripts/crear-usuario.js --roles` los describe). Para cambiar una contraseña:

```
node scripts/crear-usuario.js jperez --clave
```

Es la alternativa por consola a la pestaña "Usuarios" de la aplicación (solo administradores), que hace lo mismo: alta, rol, código de operario en Karve, cambio de contraseña y baja lógica.

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

Crea usuarios de prueba de todos los roles (`finanzas1` administrativo, `responsable1`, `gerencia1`, `gestorsat1`, `tecnico1`, `tecnico2`, `sat1`, `recambista1`, `comercial1`, `jefeventas1`, más `tecnico3` desactivado; los técnicos con código de operario en Karve; la contraseña se muestra al terminar), 12 clientes con contactos y última factura (dos "antiguos" con más de 3 años sin factura; dos en la cartera de `comercial1`), 24 máquinas con estado, contrato y características (las que no traen nº de flota del cliente reciben uno `F-AA-0000`; el contador no se reinicia con `--limpiar`) y 20 O.T. repartidas por todas las columnas del Tablero, con historial y asignaciones. Se niega a ejecutarse si ya hay datos: `--limpiar` borra antes todas las O.T., máquinas y clientes (no los usuarios) y `--anadir` añade otra tanda. Respeta la numeración (sigue el contador) y no hace falta reiniciar el servidor. **Solo para bases de desarrollo o pruebas.**

Las pruebas automáticas (HTTP, navegador headless y migración de roles) están en `tests/`; `tests/README.md` explica cómo lanzarlas con `tests\ejecutar-fase3.ps1`. Siempre usan una base temporal propia.

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
karve.js             conexión de SOLO LECTURA a Karve por ODBC (driver portable en driver-sql/, ignorado por git)
public/              interfaz: acceso.html, index.html, style.css, app.js, img/
tests/               pruebas automáticas (ejecutar-fase3.ps1, arneses HTTP y de navegador; historico/ con los de las Fases 1-2)
scripts/             crear-usuario.js, fijar-contador.js, generar-datos-prueba.js, karve-probar.js, karve-explorar.js
docs/                esta documentación
.cache/              base de datos (no se versiona)
.env                 configuración y credenciales (no se versiona)
```

## 13. Conexión a Karve (solo lectura, Fase 3.5)

Karve es SAP SQL Anywhere 17 y se consulta por ODBC con el paquete npm `odbc`. **El driver no se instala por npm**: es el cliente portable de SQL Anywhere 17 de 64 bits en la carpeta `driver-sql/` del proyecto (ignorada por git; copiar la misma carpeta que usa `vibacar-facturacion`). `karve.js` antepone esa carpeta al `PATH` al arrancar.

Windows exige que el driver esté **registrado con el nombre `SQL Anywhere 17`** en el Administrador ODBC de 64 bits; una ruta al DLL en la cadena de conexión no vale. Si en el PC ya está registrado (por `vibacar-facturacion`, por ejemplo) no hay que hacer nada; si no, hay que crear las claves del registro como administrador:

```
HKLM\SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers      "SQL Anywhere 17" = "Installed"
HKLM\SOFTWARE\ODBC\ODBCINST.INI\SQL Anywhere 17   Driver = <ruta>\driver-sql\dbodbc17.dll · Setup = <ruta>\driver-sql\dbodbc17.dll
```

Comprobación: `Get-OdbcDriver -Name "SQL Anywhere 17" -Platform 64-bit`. Sin registro el error es `IM002`.

En el `.env`: `KARVE_COPIA_CONNECTION_STRING` (base de pruebas) y, más adelante, `KARVE_CONNECTION_STRING` (producción), con la cadena completa `DRIVER={SQL Anywhere 17};ServerName=…;Host=…;DatabaseName=…;UID=…;PWD=…`. `karve.js` añade `CharSet=UTF-8` si falta (sin él los acentos llegan rotos), solo ejecuta `SELECT` y nunca escribe la cadena en logs ni errores.

```
node scripts/karve-probar.js                      comprueba la conexión (base, usuario, hora del servidor, latencia)
node scripts/karve-explorar.js                    catálogo e informe de tablas candidatas en contexto/ (no versionado)
node scripts/karve-explorar.js --buscar texto     tablas, vistas y columnas con ese texto
node scripts/karve-explorar.js --tabla CV.kv_vClientes   columnas y muestra de una tabla o vista
```

Si `npm start` falla con "Una directiva de Control de aplicaciones bloqueó este archivo" (`odbc.node`), es el Smart App Control de Windows: hay que permitirlo.

### Sincronización de clientes, contactos y máquinas

Desde la aplicación: Maestros → "⟳ Sincronizar Karve" (administrativo y responsable de servicio técnico). Desde consola o el Programador de tareas de Windows (cada noche):

```
node scripts/karve-sincronizar.js             sincroniza (código de salida 0 si va bien)
node scripts/karve-sincronizar.js --simular   solo informa, no escribe
```

Reglas: Karve manda en los datos que trae (nombre, NIF, teléfono, email, dirección, alta, baja, comercial y fecha de la última factura); lo que se rellena a mano en la ficha (contactos principales, zona, nº de contrato, características, observaciones, estado reclasificado de una máquina) no se pisa. Los contactos de Karve van a la tabla `cliente_contactos` y se ven en la ficha del cliente; los tres huecos de la ficha se rellenan solos por el cargo del contacto si estaban vacíos. Las máquinas se vinculan al cliente **actual** de Karve y reciben un nº de flota `F-AA-0000` al crearse; los bastidores repetidos o vacíos solo generan un aviso. Cada ejecución queda registrada en la tabla `sincronizaciones`.
