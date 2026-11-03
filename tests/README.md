# Pruebas de Gestión de Taller Vibacar

Arneses automáticos sin dependencias extra: Node 22 (`fetch` y `WebSocket` nativos) y, para las pruebas de interfaz, un Chromium headless (Brave, Chrome o Edge) controlado por el DevTools Protocol. Nunca tocan la base real: cada ciclo crea una base temporal, la rellena con `scripts/generar-datos-prueba.js` y levanta un servidor en el puerto 5055.

## Lanzar todo (Fase 3)

```
powershell -ExecutionPolicy Bypass -File tests\ejecutar-fase3.ps1
```

Opciones: `-SinNavegador` (solo HTTP y migración), `-Brave "C:\ruta\brave.exe"` (por defecto Brave en `Program Files`; vale Chrome o Edge). Las bases temporales, los logs del servidor y el perfil del navegador van a `%TEMP%\vibacar-taller-pruebas`; las capturas a `tests/capturas-*/` (ignoradas por git).

El lanzador ejecuta dos ciclos con base limpia y la prueba de migración:

| Ciclo | Base | Scripts | Qué cubre |
|---|---|---|---|
| clientes2 | seed | `cliente-prueba-clientes2.js` (29) + `navegador-prueba-clientes2.js` (31) | F3-02 menú Maestros, pantallas sin avisos ni chips; F3-03 clientes v2, contactos, regla de 3 años |
| maquinas2 | seed | `cliente-prueba-maquinas2.js` (46) + `navegador-prueba-maquinas2.js` (23) + `navegador-colores.js` (8) | F3-04 máquinas v2, nº de flota automático, edición restringida; F3-05 roles y alcances; F3-01 colores |
| migración | sintética | `prueba-migracion-roles.js` (6) | F3-05: `admontaller`/`financiero` → roles nuevos en usuarios y transiciones |

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
