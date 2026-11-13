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
3. La pantalla depende del rol: el administrador ve el Tablero; un técnico ve "Mi día"; el resto, el Listado.
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
tiempos.js           cronómetro por tramos y checklist de la O.T. (lógica)
rutas-tecnico.js     API: Mi día, cronómetro y checklist del técnico
fichajes.js          jornadas, O.T. comodín e incidencias de fichaje (lógica)
rutas-fichajes.js    API: comodín, jornadas e incidencias
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
node scripts/karve-importar-ot.js --sin-bloques   no crea bloques automáticos en el Planificador
node scripts/karve-importar-ot.js --sin-repartir  bloques solo para las O.T. con fecha prevista de hoy en adelante
node scripts/karve-importar-ot.js --recolocar     quita los bloques automáticos repartidos y los reparte otra vez
```

Antes hay que tener sincronizados clientes y máquinas: una O.T. cuyo cliente no esté en la base local se omite (queda en el informe). "Viva" = sin fecha de cierre en Karve. El estado de Karve se traduce a la vertical del Tablero y su etiqueta: HACER, MTO, INSPECCION, GARANTIA… → Planificada; RECAMBIOS, ALMACEN, PROVEEDOR, RE. PEDIDO… → Pausada / Pendiente de repuesto; PPTO y PDTE. DICTAMEN → Pausada / Presupuesto; PDTE OK PPTO → Pausada / Pendiente OK presupuesto; PDTE Nº PEDIDO → Pausada / Pendiente de nº de pedido; S.A.T. EXTERNO → En curso / SAT externo; HECHO → Finalizada; PDTE ALBARAN → Finalizada / Pendiente de albarán; Vº B FACT. y Vº B F. P. → Finalizada / Vº B factura; con fecha de cierre → Cerrada (Anulada si lo está). El estado y el operario de Karve se guardan tal cual en la O.T. (`karve_estado`, `karve_operario`) y se ven en la tarjeta y en el detalle; el técnico local solo se enlaza si existe un usuario con ese código de operario. Los estados "URG." proponen prioridad alta al crear la O.T. (después la prioridad es solo de la aplicación: las importaciones siguientes no la tocan) y los albaranes de mantenimiento preventivo, tipo preventivo. Se puede repetir cuando haga falta: lo ya importado y no tocado en la aplicación se actualiza con lo que diga Karve; lo modificado aquí se conserva. Cada ejecución queda en `sincronizaciones` con origen `ot-cron`.

**Bloques automáticos en el Planificador.** Tras importar, cada O.T. planificada que nadie ha tocado en la aplicación y cuyo operario de Karve tiene usuario (técnico o SAT con ese código de operario) recibe un bloque de 2 h marcado como automático, para que no se amontonen en la bandeja. Si la fecha prevista de Karve es de hoy en adelante, el bloque va ese día, detrás de lo que ya tenga el técnico. Si ya pasó (en Karve la fecha prevista es en la práctica la de alta y no hay horas previstas), la O.T. **se reparte por capacidad**: primer día laborable a partir de mañana en el que al técnico le queden 2 h de jornada, urgentes primero y después las más antiguas, hasta 20 días laborables; lo que no quepa se queda en la bandeja (`--sin-repartir` deja en la bandeja todas las de fecha vencida). El reparto **agrupa por zona**: cada O.T. va al primer día con hueco en el que el técnico no tenga clientes de otra zona, para no cruzar de zona el mismo día; solo si en esos 20 días no hay ninguno se coloca en un día con otra zona (el informe dice cuántas, y el Planificador lo avisa en ámbar). `--recolocar` rehace el reparto de las O.T. que nadie ha tocado, por ejemplo tras corregir zonas de clientes. Mientras la O.T. siga sin tocar, cada importación mantiene su bloque: lo quita si deja de estar planificada o cambia de operario, lo mueve si cambia la fecha prevista y lo recoloca si pasó el día sin empezarse. En cuanto alguien mueve el bloque o toca la O.T. (también cuando el técnico la empieza), la importación ya no lo toca. Las O.T. de operarios genéricos de Karve (TALLER, MANTENIMIENTOS, REPUESTOS…) no tienen técnico y siguen en la bandeja. El informe lo resume en la línea "Bloques automáticos: …".

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

**Seed de pruebas del Planificador** (mientras se valida la aplicación): `node scripts/planificaciones-prueba.js` simula y `--aplicar` escribe, sobre los datos ya traídos de Karve, una capa de prueba: un técnico `prueba_tecN` (contraseña `prueba123`) por cada operario de Karve con O.T. vivas que aún no tenga usuario, con su nombre y su código de operario (lo lee de Karve en solo lectura; se saltan los genéricos como TALLER o REPUESTOS), un SAT de prueba y el usuario `prueba_responsable`. La primera vez hace además un reparto de demostración para los seis primeros técnicos (sus O.T. en los próximos días laborables, con un día sobrecargado, un solape y una O.T. partida, y tres "repuesto recibido" en la bandeja); al repetirlo solo añade los técnicos que falten. Después, `node scripts/karve-importar-ot.js` enlaza las O.T. de cada operario con su técnico y crea los bloques automáticos. `--quitar` retira los bloques de prueba y los automáticos de esos técnicos, y desactiva los usuarios `prueba_*`; para dejar la base limpia del todo antes de producción, la purga (`generar-datos-prueba.js --limpiar`) y volver a sincronizar e importar desde Karve. Con `RUTA_BD` se puede aplicar a una copia en vez de a la base en uso.

## 16. El técnico: su día, cronómetro y checklist (Fase 4)

El técnico y el SAT externo entran en **Mi día** (pensada para el móvil y la tablet): arriba, su cronómetro en marcha si lo tiene (lleva a esa O.T.) y el resumen de horas del día; debajo, sus tareas en tres grupos (en curso, hoy por hora, atrasadas o sin fecha) y, plegados, los próximos días. Cada tarjeta tiene un botón según el momento: "Salir hacia el cliente" → "He llegado" → "Empezar trabajo". Tocar la tarjeta abre la **ficha de trabajo** a pantalla completa: cronómetro fijo arriba con las tres fases (se cambia de fase pulsándola), datos del cliente y de la máquina, aviso, checklist y tiempos fichados; fijos abajo, **Parar por hoy**, **Pausar** y **Terminar** (desactivado, con el motivo a la vista, mientras falte tiempo de trabajo o checklist). Si ya tiene el cronómetro en otra O.T., pregunta antes de pararlo. Para probarla desde un móvil de la misma red: `http://<IP del equipo>:3010` (el cortafuegos de Windows tiene que permitir a Node las conexiones entrantes en redes privadas).

En la oficina, el Tablero enseña en la tarjeta la fase del cronómetro en marcha, el Planificador marca con un punto los bloques de las O.T. que se están trabajando y con "auto" los que puso la importación de Karve, y el detalle de la O.T. suma los tiempos por fase y el checklist con sus incidencias.

Lo que hace el servidor:

- **Su día** (`GET /api/mi-dia`): solo lo accionable (O.T. planificadas y en curso): lo que tiene en curso, sus bloques de hoy por hora y las planificadas suyas que se quedaron sin fecha; además, los bloques de los próximos 7 días y el resumen de horas del día (desplazamiento, espera, trabajo, y lo previsto). La oficina puede mirar el día de un técnico con `?tecnico_id=`.
- **Cronómetro por tramos** (`POST /api/ot/:id/crono`, tabla `ot_tiempos`): desplazamiento → espera de acceso → trabajo. Cambiar de fase cierra el tramo y abre el siguiente; el primer tramo pasa la O.T. a En curso. Un técnico solo puede tener un cronómetro en marcha. **La hora la pone el servidor**: recargar la página, apagar la tablet o cambiar de dispositivo no pierde nada. Solo fichan el técnico y el SAT.
- **Parar y pausar**: "parar por hoy" cierra el tramo y deja la O.T. en curso, en su tablero, para otro día. Pausar (falta repuesto, cliente…) es un cambio de estado con motivo: cierra el tramo y la O.T. sale de su tablero.
- **Checklist** (`PUT /api/ot/:id/checklist/:punto`): las O.T. de mantenimiento preventivo reciben los puntos de la plantilla de su tipo (tablas `checklist_plantillas` y `checklist_puntos`; de arranque hay una genérica: revisión visual, niveles, engrase, pruebas de funcionamiento). Se copian a la O.T. al abrirla, así que cambiar la plantilla no altera las ya hechas. Cada punto: hecho, no aplica o incidencia (con nota).
- **Para finalizar** hace falta tiempo de trabajo imputado y el checklist respondido. El técnico y el SAT no pueden saltárselo. La oficina que puede cerrar (administrativo, responsable, operativo) sí: al finalizar, el aviso ofrece "Forzar" y queda anotado en el historial con lo que faltaba. Cerrar directamente (anulada, sin cargo) o reabrir una cerrada no lo exige.
- El detalle de la O.T. trae los tramos, los totales frente a lo previsto en el Planificador, el checklist y qué falta para finalizar; el Tablero y el Planificador reciben la fase del cronómetro en marcha.

Para que aparezcan columnas hacen falta usuarios activos con rol Técnico o SAT externo (Usuarios → Nuevo usuario); conviene ponerles su código de operario de Karve para que la importación de O.T. les enlace las suyas. La jornada visible (07:00–19:00) y las horas por día (8) se pueden cambiar en el `.env` con `PLANIFICADOR_HORA_INICIO`, `PLANIFICADOR_HORA_FIN` y `PLANIFICADOR_HORAS_DIA` (hay que reiniciar).

## 17. Fichajes: jornada de 8 h, O.T. comodín e incidencias (Fase 4)

Tres piezas que van juntas: que cada técnico justifique su jornada, que tenga dónde imputar las horas que no son de un cliente, y que lo fichado solo cambie con una corrección aprobada.

**O.T. comodín.** Una por técnico y mes (tabla `comodines`, código `CM-AAAAMM-NNN`); se crea sola la primera vez que el técnico imputa algo ese mes. No es una fila de `ot`: no lleva cliente, estado ni número de Karve, y no aparece en el Tablero ni en el Planificador. Sus tramos van a la misma tabla `ot_tiempos` que los de las O.T. (con `comodin_id` y `concepto`, tipo `comodin`), así que comparten cronómetro, resumen de horas y correcciones. Los conceptos están en `comodin_conceptos`: cuatro de trabajo (trabajos de taller, formación, sin trabajo asignado y otros, que pide una nota) y tres de **ausencia** (vacaciones, baja médica y festivo). Se cambian en esa tabla (`nombre`, `orden`, `pide_nota`, `ausencia`); para retirar uno se desactiva (`activo = 0`), porque si se borra, el arranque lo vuelve a crear.

**Jornada.** Por técnico y día se suma lo fichado (un tramo cuenta en el día en que empieza) y se compara con `PLANIFICADOR_HORAS_DIA` (8). Se marcan los días **laborables ya pasados** del rol Técnico que no llegan: "no llega" (algo fichado) o "sin fichar" (nada). Límites que conviene conocer:

- Laborable = de lunes a viernes. **No hay calendario laboral**: un festivo, un día de vacaciones o una baja sale como "sin fichar" hasta que se imputa al comodín con su concepto de ausencia (normalmente 8 h, de 08:00 a 16:00; el diálogo lo propone). Lo hace la oficina desde Fichajes, o el técnico pidiéndolo desde Mis horas.
- Las ausencias no se fichan con el cronómetro (no salen entre los conceptos de "Horas sin O.T.") y son lo único que se puede imputar a un día que aún no ha terminado o no ha llegado; desde las pantallas solo se llega hasta hoy.
- Solo cuenta desde el **primer fichaje** de cada técnico: quien aún no usa la aplicación no aparece con todo el mes en rojo.
- Al SAT externo no se le exige jornada (ficha, pero no sale como "no llega").

**Incidencias de fichaje** (tabla `incidencias`, preparada para otros tipos más adelante). El técnico pide desde "Mis horas" corregir un tramo (horas o tipo), quitarlo o añadir uno que falta, a una de sus O.T. o al comodín, siempre con motivo. Quien tiene el permiso `fichajes.gestionar` (administrativo y responsable de servicio técnico) la aprueba —se aplica y el tramo queda marcado como corregido— o la rechaza con una respuesta. El técnico puede retirarla mientras esté pendiente. Si la corrección la hace la oficina directamente, es una incidencia que nace aprobada: el rastro es el mismo. Reglas:

- Un fichaje con el cronómetro en marcha no se corrige (hay que pararlo antes), ni uno que ya tiene una incidencia pendiente.
- Un fichaje no puede pasar de medianoche, ni caer en el futuro, ni solaparse con otro del mismo técnico (se comprueba al pedir y otra vez al aprobar).
- El técnico solo puede añadir tiempo a una O.T. suya (asignada, con un bloque suyo o en la que ya ha fichado); la oficina, a cualquiera, también por número.
- Cada corrección aplicada a una O.T. queda en su historial con el antes, el después y el motivo; la incidencia guarda las dos fotos aunque el tramo se quite.

Pantallas: el técnico tiene en **Mi día** el aviso de los días de la última semana que no llegan y la tarjeta "Horas sin O.T.", y la vista **Mis horas**. La oficina con `fichajes.ver` (administrativo, responsable y gerencia, esta solo para mirar) tiene **Fichajes**: jornadas de todos los técnicos por mes, con el total, la espera de acceso, las horas sin O.T. y lo que falta, e incidencias; el contador rojo de la cabecera son las pendientes. Desde una celda se entra en las horas de ese técnico.

API (`rutas-fichajes.js`, lógica en `fichajes.js`):

| Ruta | Para qué |
|---|---|
| `POST /api/comodin/crono { accion: empezar \| parar, concepto, nota? }` | Cronómetro del comodín (técnico y SAT). Con el cronómetro en una O.T., 409 salvo `cerrar_otra: true` |
| `GET /api/jornadas?mes=AAAA-MM` (o `desde` y `hasta`, máx. 62 días) `[&tecnico_id]` | Horas por técnico y día con su estado; el técnico solo recibe las suyas |
| `GET /api/jornadas/dia?dia=AAAA-MM-DD[&tecnico_id]` | Tramos del día, O.T. a las que puede imputar e incidencias de ese día |
| `GET /api/incidencias?estado=pendiente\|resueltas\|todas[&tecnico_id]` · `GET /api/incidencias/pendientes` | Listado y contador |
| `POST /api/incidencias { accion: modificar \| anadir \| quitar, motivo, … }` | Pedir una corrección (técnico) o aplicarla (oficina, con `tecnico_id`) |
| `POST /api/incidencias/:id/resolver { aprobar, respuesta? }` · `DELETE /api/incidencias/:id` | Aprobar o rechazar · retirar la propia |

**Al actualizar desde una versión anterior**, el primer arranque reconstruye la tabla `ot_tiempos` (para admitir tramos sin O.T.) conservando los fichajes y sus identificadores; lo dice en la consola (`BD: tabla de tiempos reconstruida para el comodín`). Como en cualquier actualización, conviene una copia de `.cache/datos.db` antes.
