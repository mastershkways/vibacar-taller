# Cómo trabajamos en este proyecto

Este archivo lo lee el asistente al abrir cada chat en esta carpeta. Es la misma dinámica que en `vibacar-facturacion` (`C:\Users\adm\Desktop\Proyectos-Vibacar\vibacar-facturacion`): si hace falta ver cómo está resuelto algo allí (servidor Express, SQLite, interfaz, despliegue como servicio, pantalla de acceso), se puede leer ese proyecto como referencia, sin tocarlo.

## Quién soy
Sendoa, responsable del proyecto. Soy programador: háblame en técnico, sin sobreexplicar, y dame los comandos **de uno en uno** y listos para copiar. Si algo es una decisión mía, dime las opciones y recomiéndame una.

## Stack (sencillo, sin frameworks ni compilación)
- **Servidor:** Node.js + Express en `server.js`. Módulos en `.js` de la raíz cuando crezca.
- **Base de datos:** SQLite con `better-sqlite3`, en `.cache/datos.db`. Migraciones automáticas al arrancar (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` si falta una columna).
- **Interfaz:** una sola página `public/index.html` con HTML, CSS y JavaScript a pelo (sin React, sin bundler, sin npm para el front). Estilo limpio, igual que vibacar-facturacion.
- **Configuración:** `.env` (nunca se versiona) a partir de `.env.example` (sí se versiona, con comentarios). Las credenciales van solo en el `.env`: **nunca las pegues en el chat ni las muestres por pantalla**.
- **Dependencias:** las mínimas. Antes de añadir una, dímelo.

## Carpetas
```
server.js            servidor y API
public/index.html    interfaz
scripts/             utilidades sueltas (node scripts/x.js)
docs/                documentación técnica (INSTALACION.md, DESPLIEGUE.md cuando toque)
contexto/            notas de trabajo del asistente (ignorada por git)
.cache/              base de datos y cosas sensibles (ignorada por git)
README.md            en lenguaje de usuario: qué hace la app y cómo se usa
```

## Contexto entre chats
- `contexto/CONTEXTO-AAAA-MM-DD.md`: el archivo de contexto del asistente. Se renombra a la fecha del día cada vez que se actualiza. Tiene: §A cómo retomar, §B estado/pendientes/decisiones (con una nota "AL RETOMAR" arriba), un diario por fechas y las secciones técnicas que hagan falta.
- `contexto/PLAN.md`: plan y diario del proyecto, marcado (✅ / ☐), para que yo lo vea de un vistazo.
- Al cerrar un chat: "actualiza el contexto" = los dos archivos + la memoria del asistente al día, y una "LISTA AL VOLVER" al principio del contexto.
- Al abrir un chat nuevo: leer el contexto entero antes de nada y preguntarme qué ha cambiado.

## Reglas de trabajo
- **Git:** commit solo cuando yo lo pida, con `git commit -F archivo` y la línea `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` al final; push cuando yo lo pida. Mensajes de commit en castellano, tipo `feat(zona): qué cambia`.
- **Servidor en mi PC:** lo arranco yo (`node server.js`). Tras cambiar `.js` de la raíz me recuerdas reiniciarlo; si solo cambia `public/index.html`, basta recargar la página.
- **Pruebas sin molestarme:** segundo servidor en otro puerto (`PORT=5055`) con la misma base solo para GET; nada que escriba datos reales, envíe correos ni toque sistemas externos sin que yo lo diga.
- **Parches grandes:** con un script Python en el scratchpad que compruebe que cada texto a sustituir aparece exactamente una vez; `node --check` tras tocar `.js`.
- **Nada inventado:** si no está verificado, dilo. Si algo falla, pega la salida.
- **Despliegue (cuando toque):** como vibacar-facturacion: carpeta en el servidor, Node portable, servicio de Windows con NSSM, actualización por zip de los archivos cambiados, `.env` y `.cache` nunca se tocan. Pantalla de acceso con usuario y contraseña desde el principio (`APP_USUARIO` / `APP_CLAVE`).

## Primer día
1. Preguntarme qué hace la app, quién la usa y con qué sistemas habla.
2. Crear la estructura de arriba, `package.json`, `.gitignore`, `.env.example`, README mínimo y el primer `contexto/CONTEXTO-AAAA-MM-DD.md` + `contexto/PLAN.md`.
3. `git init` y primer commit cuando yo lo diga.
