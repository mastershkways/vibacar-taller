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
| `CONTADOR_OT_INICIAL` | Último número de O.T. real, solo para arrancar sin conexión a Karve (ver apartado 8) | `0` o el real |
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

La primera vez se crea sola la base de datos en `.cache/datos.db` con las tablas, las verticales del Tablero (estados), las etiquetas y el usuario administrador del `.env`. Las migraciones posteriores (columnas nuevas, roles, Tablero v2) también se aplican solas al arrancar: actualizar la aplicación nunca exige tocar la base a mano. Al pasar a la versión de la Fase 4, las O.T. que estaban en los 10 estados antiguos se recolocan solas en las 5 verticales con su etiqueta (p. ej. "Pendiente de repuesto" → Pausada + etiqueta Pendiente de repuesto) y el historial sigue leyéndose.

Para parar: `Ctrl+C`. Tras cambiar cualquier `.js` de la raíz hay que reiniciar; si solo cambia algo de `public/`, basta con recargar la página.

## 6. Primer acceso

1. Abre `http://localhost:3010` en el navegador (desde otro PC de la red, la IP del servidor y el puerto).
2. Entra con `APP_USUARIO` y `APP_CLAVE`.
3. La pantalla depende del rol: el administrador ve el Tablero; un técnico ve "Mis O.T."; el resto, el Listado.
4. Crea los clientes en Maestros → "Clientes" (o el primero directamente desde "+ Nueva O.T.", que también permite el alta rápida de cliente y máquina). La ficha lleva contacto de compras, contacto técnico, correo de facturas y fecha de la última factura. Los clientes no se borran ni se desactivan: el que lleva más de 3 años sin factura pasa a "antiguo" y solo aparece con "Mostrar: Todos" (la fecha vendrá de Karve).
5. Las máquinas, en Maestros → "Máquinas" o desde la ficha de su cliente (botón "+ Máquina"). El nº de flota se asigna solo al guardar (el siguiente al mayor que haya; en las máquinas de Karve es su código); el bastidor no puede repetirse; el nº de contrato solo se pide si la máquina no es de cliente final. Tras el alta solo se cambian horas y observaciones: un administrativo tiene el botón "Editar campos bloqueados" para corregir errores. También se desactivan en vez de borrarse.
6. El personal, en la pestaña "Usuarios" (solo administradores): usuario, nombre, email, rol, código de operario en Karve y contraseña. Al editar, la contraseña en blanco no se toca; escribir una nueva la cambia. Desactivar a alguien bloquea su acceso al instante (y cierra su sesión) sin borrar sus O.T.; nadie puede desactivarse ni cambiarse el rol a sí mismo.
7. Cada cliente puede tener un "Comercial responsable" (selector en su ficha, solo usuarios activos con rol comercial). Un usuario con rol comercial solo ve los clientes de su cartera, sus máquinas y sus O.T., en el Listado y en el Tablero; el resto le da "no encontrado". Quien no tenga cartera no ve nada hasta que se le asigne. El rol "Jefe comercial" tiene los mismos permisos pero ve todos los clientes.

Tras 10 intentos fallidos de contraseña, un usuario queda bloqueado 15 minutos.

## 7. Crear usuarios

Desde la consola, en la carpeta del proyecto:

```
node scripts/crear-usuario.js jperez tecnico "Juan Pérez" jperez@vibacar.com
```

La contraseña se pide por teclado sin mostrarla. Roles válidos: `administrativo`, `responsable_st`, `gerencia`, `operativo`, `tecnico`, `sat`, `recambista`, `comercial`, `comercial_jefe` (los antiguos `admontaller`, `financiero` y `gestor_sat` se migran solos al arrancar: el usuario de `APP_USUARIO` pasa a `administrativo`, el resto de `admontaller` a `responsable_st`, `financiero` a `administrativo` y `gestor_sat` a `operativo`) (`node scripts/crear-usuario.js --roles` los describe). Para cambiar una contraseña:

```
node scripts/crear-usuario.js jperez --clave
```

Es la alternativa por consola a la pestaña "Usuarios" de la aplicación (solo administradores), que hace lo mismo: alta, rol, código de operario en Karve, cambio de contraseña y baja lógica.

## 8. Numeración de las O.T.

Las O.T. llevan el mismo número que en Karve: un secuencial de 10 dígitos (`0000107951`), sin año. Administración sigue abriendo O.T. en el ERP, así que la aplicación lee el máximo de Karve (`kv_vOrdenesTrabajo`) al arrancar, en cada "Sincronizar Karve" y **justo antes de cada alta**, y asigna siempre ese máximo + 1 (o el contador local + 1 si es mayor). Si Karve no responde, se usa el contador local y queda un aviso en el log.

```
node scripts/fijar-contador.js            muestra el contador local, el próximo número y el máximo de Karve
node scripts/fijar-contador.js --karve    sube el contador local al máximo de Karve
node scripts/fijar-contador.js 107950     fija el último número usado a mano (sin conexión)
```

`CONTADOR_OT_INICIAL` del `.env` solo se usa para crear el contador la primera vez si no hay conexión. El contador nunca baja por debajo de una O.T. ya existente (salvo `--forzar`).

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

**`--limpiar` es la purga para el entorno real**: vacía toda la base (O.T., máquinas, clientes, contactos, sincronizaciones, sesiones, usuarios y contadores) y deja solo el administrador del `.env`, `nacho` (jefe comercial, Karve `0000023`) y `jruiz` (comercial, Karve `0000028`) con una contraseña inicial que se muestra una vez; después, reiniciar el servidor y pulsar "Sincronizar Karve". Sin opciones, el script crea datos ficticios para desarrollo: usuarios de prueba de todos los roles (`finanzas1` administrativo, `responsable1`, `gerencia1`, `operativo1`, `tecnico1`, `tecnico2`, `sat1`, `recambista1`, `comercial1`, `jefeventas1`, más `tecnico3` desactivado; los técnicos con código de operario en Karve; la contraseña se muestra al terminar), 12 clientes con contactos y última factura (dos "antiguos" con más de 3 años sin factura; dos en la cartera de `comercial1`), 24 máquinas con estado, contrato y características (las que no traen nº de flota reciben el siguiente numérico) y 20 O.T. repartidas por las verticales del Tablero con sus etiquetas, historial y asignaciones. Se niega a ejecutarse si ya hay datos salvo con `--anadir` (añade otra tanda). Respeta la numeración (sigue el contador) y no hace falta reiniciar el servidor. **Solo para bases de desarrollo o pruebas.**

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
rutas-ot.js          API: O.T., estados, asignaciones, Tablero
rutas-planificador.js API: Planificador (calendario, bandeja, bloques, avisos)
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

Reglas: Karve manda en los datos que trae (nombre, NIF, teléfono, email, dirección, alta, baja, comercial y fecha de la última factura); lo que se rellena a mano en la ficha (contactos principales, zona, nº de contrato, características, observaciones, estado reclasificado de una máquina) no se pisa. Los contactos de Karve van a la tabla `cliente_contactos` y se ven en la ficha del cliente; los tres huecos de la ficha se rellenan solos por el cargo del contacto si estaban vacíos. Las máquinas se vinculan al cliente **actual** de Karve y su nº de flota es el código de la máquina en Karve (`0003641` → `3641`); los bastidores repetidos o vacíos solo generan un aviso. Cada ejecución queda registrada en la tabla `sincronizaciones`.

### Importación de las O.T. vivas (Fase 3.6)

Para que el Tablero y los listados tengan las órdenes reales sin cargar las ~96.000 históricas de Karve:

```
node scripts/karve-importar-ot.js                 vivas + 150 cerradas recientes (código de salida 0 si va bien)
node scripts/karve-importar-ot.js --simular       solo informa, no escribe
node scripts/karve-importar-ot.js --cerradas=300  otra cantidad de cerradas recientes (0 = ninguna)
```

Antes hay que tener sincronizados clientes y máquinas: una O.T. cuyo cliente no esté en la base local se omite (queda en el informe). "Viva" = sin fecha de cierre en Karve. El estado de Karve se traduce a la vertical del Tablero y su etiqueta: HACER, MTO, INSPECCION, GARANTIA… → Planificada; RECAMBIOS, ALMACEN, PROVEEDOR, RE. PEDIDO… → Pausada / Pendiente de repuesto; PPTO y PDTE. DICTAMEN → Pausada / Presupuesto; PDTE OK PPTO → Pausada / Pendiente OK presupuesto; PDTE Nº PEDIDO → Pausada / Pendiente de nº de pedido; S.A.T. EXTERNO → En curso / SAT externo; HECHO → Finalizada; PDTE ALBARAN → Finalizada / Pendiente de albarán; Vº B FACT. y Vº B F. P. → Finalizada / Vº B factura; con fecha de cierre → Cerrada (Anulada si lo está). El estado y el operario de Karve se guardan tal cual en la O.T. (`karve_estado`, `karve_operario`) y se ven en la tarjeta y en el detalle; el técnico local solo se enlaza si existe un usuario con ese código de operario. Los estados "URG." proponen prioridad alta al crear la O.T. (después la prioridad es solo de la aplicación: las importaciones siguientes no la tocan) y los albaranes de mantenimiento preventivo, tipo preventivo. Se puede repetir cuando haga falta: lo ya importado y no tocado en la aplicación se actualiza con lo que diga Karve; lo modificado aquí se conserva. Cada ejecución queda en `sincronizaciones` con origen `ot-cron`.

El Tablero no enseña las O.T. cerradas (`GET /api/kanban?cerradas=N` las devuelve en una columna aparte con las cerradas en los últimos N días, máximo 90); el histórico completo está en el listado con "Mostrar: Todas", paginado.

## 14. Tablero v2: verticales, etiquetas y flujo libre (Fase 4)

Desde la Fase 4 el Tablero tiene **cinco verticales** (Pendiente de planificar · Planificada · En curso · Pausada · Finalizada; las cerradas desaparecen) y, dentro de cada una, **etiquetas** que dicen el motivo o la situación: en Pausada, Pendiente de repuesto, Presupuesto, Pendiente OK presupuesto, Pendiente de nº de pedido y Espera del cliente; en En curso, SAT externo; en Finalizada, Pendiente de albarán y Vº B factura; al cerrar, Facturada, Sin cargo o Anulada. Las urgentes van arriba de cada vertical y marcadas. Cada rol tiene **su vertical** resaltada (recambista y administración, Pausada; administración, Finalizada; responsable y operativo, Pendiente de planificar y Planificada) y puede filtrar "solo las mías"; hay filtros por operario, zona, etiqueta, prioridad y texto.

El flujo es **libre con confirmación**: cualquier estado puede ir a cualquier otro arrastrando la tarjeta o desde el detalle; antes de confirmar se piden **dos cosas** (el motivo o etiqueta, o el técnico al planificar, y una nota). Límites que aplica el servidor: técnico y SAT externo solo pueden pasar sus O.T. a En curso, Pausada o Finalizada; cerrar o reabrir exige el permiso `ot.cerrar` (administrativo, responsable y operativo). La etiqueta se puede cambiar sin mover de vertical desde el detalle (también el recambista). Todo queda en el historial.

El rol **operativo** (antes "gestor de SAT externos") gestiona las O.T. que abre él, las de SAT externos y las que aún no tienen técnico.

## 15. Planificador (Fase 4)

El **Planificador** es la pantalla de entrada del responsable de servicio técnico, del operativo y de gerencia (que solo mira). El Tablero dice en qué punto está cada O.T. y por qué; el Planificador, **quién la hace y cuándo**.

- **Bandeja "Sin planificar"** a la izquierda: O.T. abiertas sin ningún bloque de hoy en adelante (pendientes de planificar, planificadas sin bloque como las importadas de Karve, y las en curso cuyo último bloque ya pasó). Arriba, las **listas para planificar**: cuando una O.T. sale de Pausada (p. ej. el recambista marca que llegó el repuesto) aparece con el distintivo "Repuesto recibido" y cuántas más hay del mismo cliente. Buscador, filtro por zona, agrupar por zona o cliente y "Incluir pausadas" para preplanificar.
- **Vista Día**: una columna por técnico (internos y luego SAT), eje de horas y bloques con alto proporcional a su duración. **Vista Semana**: una fila por técnico y una celda por día, con tarjetas compactas; la cabecera de cada día lleva a su vista Día.
- **Arrastrar** una O.T. de la bandeja al calendario abre un mini-modal (técnico, día, hora, duración de **2 h por defecto**, nota). Arrastrar un bloque lo cambia de hora, día o técnico; el borde inferior lo alarga o acorta en tramos de 15 minutos; "+ Otro bloque" reparte la O.T. en varios días o técnicos; "Quitar bloque" (o soltarlo en la bandeja) la devuelve a la bandeja. También se puede planificar desde el detalle de la O.T.
- **Estado**: el calendario solo mueve la O.T. entre "Pendiente de planificar" y "Planificada" (al tener su primer bloque futuro o al quedarse sin ninguno). Una pausada se puede preplanificar sin sacarla de la pausa; cuando se resuelve, queda planificada conservando su plan. El técnico de la O.T. es el de su próximo bloque. Todo queda en el historial y la tarjeta del Tablero enseña el próximo bloque ("📅 fecha hora · técnico +N").
- **Avisos** (en ámbar, no bloquean): más horas previstas que la jornada, dos o más zonas el mismo día para un técnico, y bloques que se solapan.

**Seed de pruebas del Planificador** (mientras se valida la aplicación): `node scripts/planificaciones-prueba.js` simula y `--aplicar` escribe, sobre los datos ya traídos de Karve, una capa de prueba: técnicos `prueba_tec1…` con el nombre y el código de operario de Karve (lo lee en solo lectura) de quienes más O.T. planificadas tienen, un SAT de prueba, sus O.T. repartidas en los próximos días laborables (con un día sobrecargado, un solape y una O.T. partida), tres "repuesto recibido" en la bandeja y el usuario `prueba_responsable` (contraseña `prueba123`). `--quitar` retira los bloques y desactiva esos usuarios; para dejar la base limpia del todo antes de producción, la purga (`generar-datos-prueba.js --limpiar`) y volver a sincronizar e importar desde Karve. Con `RUTA_BD` se puede aplicar a una copia en vez de a la base en uso.

Para que aparezcan columnas hacen falta usuarios activos con rol Técnico o SAT externo (Usuarios → Nuevo usuario); conviene ponerles su código de operario de Karve para que la importación de O.T. les enlace las suyas. La jornada visible (07:00–19:00) y las horas por día (8) se pueden cambiar en el `.env` con `PLANIFICADOR_HORA_INICIO`, `PLANIFICADOR_HORA_FIN` y `PLANIFICADOR_HORAS_DIA` (hay que reiniciar).
