# Gestión de Taller Vibacar

Aplicación web para gestionar las **Órdenes de Trabajo (O.T.)** de reparación y mantenimiento de maquinaria de Vibacar: desde que entra el aviso hasta que la O.T. queda lista para facturar.

## Qué hace

- **Abre y sigue las O.T.**: cada orden tiene su número, el mismo que en Karve (`0000107951`), su cliente, su máquina, su estado y su historial completo de cambios.
- **Planificador** en forma de calendario para quien reparte el trabajo: vista por día (una columna por técnico) y por semana, una bandeja con las O.T. sin planificar (arriba las que acaban de recibir el repuesto) y bloques que se arrastran para fijar técnico, día, hora y duración. Avisa, sin bloquear, si un técnico tiene más horas que su jornada, dos zonas el mismo día o bloques solapados.
- **Tablero** para el taller: cinco verticales (pendiente de planificar, planificada, en curso, pausada, finalizada) y, dentro, etiquetas con el motivo (pendiente de repuesto, presupuesto, pendiente de nº de pedido, SAT externo, Vº B factura…). Las urgentes van arriba, cada rol tiene su vertical resaltada y las cerradas desaparecen del Tablero (quedan en el listado). Cualquier cambio de estado pide motivo y nota antes de confirmarse.
- **"Mi día" del técnico**, en el móvil o la tablet: solo lo que tiene que hacer (lo que lleva en curso, sus trabajos de hoy por hora y lo atrasado), con un botón por momento: salir hacia el cliente, he llegado, empezar a trabajar. Al abrir una O.T. ve la **ficha de trabajo** a pantalla completa con el **cronómetro** siempre a la vista (desplazamiento, espera de acceso y trabajo, cada uno con su tiempo), los datos del cliente (dirección con mapa, teléfono para llamar), el aviso y, en los mantenimientos, el **checklist** (hecho, no aplica o incidencia con nota). Abajo, tres botones: **Parar por hoy** (se va sin acabar y sigue en su lista), **Pausar** (falta un repuesto o el cliente: pide motivo y sale de su lista) y **Terminar**, que no se puede pulsar hasta haber fichado trabajo y respondido el checklist. Fotos y firma del cliente llegarán con el parte de trabajo.
- **Recambios**: el almacén vincula los repuestos usados a cada O.T.
- **Cierre y facturación**: parte de trabajo, albarán y reclamación automática del nº de pedido al cliente cuando lo exige.
- **Clientes**: ficha con razón social, NIF/CIF, teléfono, dirección, contacto de compras, contacto técnico (recibe los partes), correo de envío de facturas, fecha de la última factura y comercial responsable; buscador rápido. Un cliente sin factura en los últimos 3 años pasa a "antiguo" y deja de salir en la lista (se puede ver con "Todos").
- **Máquinas**: ficha con marca, modelo, bastidor, estado (propia, rent to rent, subalquilada o de cliente final), nº de contrato, características técnicas para el mecánico, horas y observaciones. El nº de flota es el código de la máquina en Karve; a una máquina creada a mano se le asigna el siguiente número. Tras el alta solo se cambian las horas y las observaciones; un administrativo puede corregir el resto. Desde la ficha del cliente se ven y se dan de alta sus máquinas. No se borran: se desactivan.
- **Usuarios**: el administrador da de alta al personal (técnicos internos, SAT externos y oficina) con su usuario, rol y contraseña, y puede cambiarla o desactivar a quien se marcha sin perder su historial. Cada técnico lleva su código de operario en Karve para imputar horas más adelante.
- **Integración con Karve** (el ERP): la aplicación lee de Karve, en solo lectura, los clientes con sus contactos, las máquinas, el comercial de cada cliente y la fecha de su última factura, con el botón "Sincronizar Karve" o cada noche de forma automática. Con un script se traen también las O.T. vivas de Karve (y una muestra de las cerradas recientes) para que el Tablero y los listados tengan las órdenes reales. Más adelante llegarán inventario y albaranes.
- **Ayuda de IA**: redacta el parte para el cliente a partir de las notas del técnico y sugiere mantenimientos preventivos.

## Quién la usa

| Rol | Qué ve |
|---|---|
| Administrativo | Ve y edita todo, gestiona usuarios y es el único que corrige los campos bloqueados de una máquina |
| Responsable de Servicio Técnico | Toda la operativa: Tablero, planificación, asignaciones y maestros (no gestiona usuarios) |
| Gerencia | Solo lectura de todo |
| Operativo administrativo | Gestiona sus propias O.T. y las de SAT externos (y las que aún no tienen técnico); comunicación con el cliente y el proveedor |
| Técnico / Operario | Sus O.T. en la tablet |
| Recambista / Almacén | Entrada de material y repuestos por O.T. |
| Comercial | Estado de las O.T. de los clientes de su cartera (solo lectura): solo ve esos clientes, sus máquinas y sus O.T., también en el Tablero |
| Jefe comercial | Lo mismo que el comercial, pero de todos los clientes (los de cualquier comercial y los que no tienen) |
| SAT externo | Solo sus asignaciones |

## Cómo se usa

1. Abrir en el navegador la dirección del servidor (por ejemplo `http://localhost:3010`).
2. Entrar con usuario y contraseña.
3. La pantalla que aparece depende del rol del usuario.

## Instalación y puesta en marcha

Resumen (el detalle está en `docs/INSTALACION.md`):

1. Tener Node.js 20 o superior.
2. Copiar `.env.example` como `.env` y rellenar los valores.
3. Instalar dependencias: `npm install`.
4. Arrancar: `node server.js`.

La base de datos se crea sola en `.cache/datos.db` la primera vez.

## Estado del proyecto

En desarrollo. **Fases 1 a 3.5 completadas** (octubre y noviembre de 2026): acceso con usuarios y roles, API y Tablero de O.T., pantallas de clientes, máquinas y usuarios, roles del servicio técnico y la lectura de Karve (clientes, contactos, máquinas, numeración de las O.T. y nº de flota). **Fase 3.6 completada** (O.T. vivas de Karve en el Tablero) y **Fase 4 en curso**: Tablero v2 con verticales y etiquetas y Planificador en forma de calendario (hechos); a continuación, el tablero del técnico y el cronómetro. El plan por fases está en `contexto/PLAN.md` (archivo local, no versionado).
