# Pruebas de Gestión de Taller Vibacar

Arneses automáticos sin dependencias extra: Node 22 (`fetch` y `WebSocket` nativos) y, para las pruebas de interfaz, un Chromium headless (Brave, Chrome o Edge) controlado por el DevTools Protocol. Nunca tocan la base real: cada ciclo crea una base temporal, la rellena con `scripts/generar-datos-prueba.js` y levanta un servidor en el puerto 5055.

## Lanzar todo (Fase 3)

```
powershell -ExecutionPolicy Bypass -File tests\ejecutar-fase3.ps1
```

Opciones: `-SinNavegador` (solo HTTP y migración), `-Solo tecnico,planificador` (solo esos ciclos: clientes2, maquinas2, tablero2, tablero2nav, planificador, planificadornav, tecnico, tecniconav, fichajes, fichajesnav, karve, migraciones), `-Brave "C:\ruta\brave.exe" (por defecto Brave en `Program Files`; vale Chrome o Edge). Las bases temporales, los logs del servidor y el perfil del navegador van a `%TEMP%\vibacar-taller-pruebas`; las capturas a `tests/capturas-*/` (ignoradas por git).

El lanzador ejecuta un ciclo con base limpia por fila (el de Karve solo si el `.env` tiene `KARVE_COPIA_CONNECTION_STRING`) y las pruebas sueltas sobre bases sintéticas (grupo `migraciones`):

| Ciclo | Base | Scripts | Qué cubre |
|---|---|---|---|
| clientes2 | seed | `cliente-prueba-clientes2.js` + `navegador-prueba-clientes2.js` | F3-02 menú Maestros, pantallas sin avisos ni chips; F3-03 clientes v2, contactos, regla de 3 años |
| maquinas2 | seed | `cliente-prueba-maquinas2.js` + `navegador-prueba-maquinas2.js` + `navegador-colores.js` + `cliente-prueba-numeracion.js` | F3-04 máquinas v2, nº de flota, edición restringida; F3-05 roles y alcances; F3-01 colores; F3.5-05 numeración de O.T. con Karve |
| karve | seed + Karve real | `cliente-prueba-karve.js` + `cliente-prueba-importar-ot.js` + `navegador-prueba-karve.js` | F3.5-03/04 sincronización de clientes, contactos y máquinas; F3.5-06 nº de flota y paginación; F3.6-01 importación de O.T. vivas; F3.6-02 cerradas recientes en el Kanban; F4-13 bloques automáticos con un técnico que lleva un código de operario real |
| tablero2 / tablero2nav | seed (una base por arnés) | `cliente-prueba-tablero2.js` · `navegador-prueba-tablero2.js` | F4-01/F4-04: verticales + etiquetas, flujo libre con límites por rol, modal de dos preguntas, filtros, "tu vertical", cerradas fuera del Tablero, rol operativo |
| planificador / planificadornav | seed (una base por arnés) | `cliente-prueba-planificador.js` · `navegador-prueba-planificador.js` | F4-02/F4-03: calendario Día y Semana, bandeja, bloques (crear, mover, alargar, quitar), estado pendiente ↔ planificada, técnico derivado, propuestas (repuesto recibido), preplanificar pausadas, avisos de zonas / horas / solape, alcance del operativo, solo lectura de gerencia |
| tecnico / tecniconav | seed (una base por arnés) | `cliente-prueba-tecnico.js` · `navegador-prueba-tecnico.js` | F4-05/F4-06. Navegador (móvil 390 × 844 y tablet): Mi día, botón único por momento, ficha de trabajo con cronómetro y checklist, Terminar bloqueado, Parar por hoy frente a Pausar, un solo cronómetro, y lo que ve la oficina. Servidor: `GET /api/mi-dia`, cronómetro por tramos (fases, un solo cronómetro por técnico, parar por hoy), checklist del preventivo, requisitos para finalizar y "forzar" de la oficina, cierre de tramos al pausar o finalizar, alcance con varios técnicos en una O.T., cronómetro en Tablero y Planificador |
| fichajes / fichajesnav | seed (una base por arnés) | `cliente-prueba-fichajes.js` · `navegador-prueba-fichajes.js` | F4-07/F4-08. HTTP: cronómetro del comodín (conceptos, nota obligatoria, 409 al cruzarse con una O.T.), jornadas por técnico y día (bajo, sin fichar, SAT sin jornada, desde el primer fichaje), incidencias (pedir, retirar, aprobar, rechazar, corrección directa de la oficina, solapes, permisos por rol) y su rastro en la O.T. Navegador (móvil, escritorio y tablet): aviso y tarjeta "Horas sin O.T." en Mi día, Mis horas con peticiones de corrección, Fichajes de la oficina (tabla de jornadas, incidencias, horas de un técnico), gerencia en solo lectura. Capturas en `capturas-fichajes/` |
| migración de tiempos | sintética | `prueba-migracion-tiempos.js` | F4-07: reconstrucción de `ot_tiempos` (de `ot_id` obligatorio a tramos con O.T. o con comodín) conservando tramos, ids, índices, secuencia y claves ajenas; restricciones nuevas |
| bloques automáticos | sintética | `prueba-bloques-automaticos.js` | F4-13 sin Karve: bloque en la fecha prevista, reparto por capacidad de las vencidas (urgentes primero, 4 por día, sin fines de semana, horizonte de 20 días), repetición sin cambios, cambios de fecha / operario / estado, respeto de lo tocado a mano |
| migración | sintética | `prueba-migracion-roles.js` | F3-05/F4-12: `admontaller`/`financiero`/`gestor_sat` → roles nuevos en usuarios y transiciones |
| migración Tablero | sintética | `prueba-migracion-tablero.js` | F4-04: los 10 estados antiguos → 5 verticales + etiquetas; O.T. recolocadas (también por `karve_estado`); historial legible |
| numeración | sintética | `prueba-numeracion-y-limpiar.js` | F3.5-05: migración `AAAA-NNNN` → 10 dígitos, generador con mínimo de Karve, `fijar-contador`, purga `--limpiar` |

Cada script imprime una línea por comprobación (`OK` / `FALLO`) y un resumen `n/m OK, k fallos`. Los de navegador también listan errores de consola y respuestas 4xx/5xx (las esperadas, como el 409 de un bastidor repetido, aparecen ahí).

## Lanzar un script suelto

```
$env:PORT=5055; $env:RUTA_BD="$env:TEMP\prueba.db"; $env:APP_USUARIO='admin_prueba'; $env:APP_CLAVE='clave-prueba-123'
node scripts\generar-datos-prueba.js
node server.js          # en otra consola, con las mismas variables
node tests\cliente-prueba-maquinas2.js
```

Para los de navegador, además: `& "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" --headless=new --remote-debugging-port=9333 --user-data-dir="$env:TEMP\brave-perfil" --no-first-run --disable-gpu`. Los scripts de navegador asumen que el HTTP del mismo ciclo ha corrido antes sobre la misma base (dejan datos previsibles) y no son idempotentes: para repetir, base nueva.

## Histórico

`historico/` guarda los arneses de las Fases 1 y 2 (clientes y máquinas v1, usuarios, comercial, revamp, datos de prueba). Apuntan a la interfaz anterior a la Fase 3 (pestañas sueltas, chips de origen, roles `admontaller`/`financiero`) y **ya no pasan**: se conservan como documentación de lo que se verificó entonces, no se mantienen.
