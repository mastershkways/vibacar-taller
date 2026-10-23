# Gestión de Taller Vibacar

Aplicación web para gestionar las **Órdenes de Trabajo (O.T.)** de reparación y mantenimiento de maquinaria de Vibacar: desde que entra el aviso hasta que la O.T. queda lista para facturar.

## Qué hace

- **Abre y sigue las O.T.**: cada orden tiene su número (`2026-0001`), su cliente, su máquina, su estado y su historial completo de cambios.
- **Tablero Kanban** para el responsable del taller: las O.T. se ven por fases (abierta, pendiente de repuesto, asignada, en curso, finalizada, pendiente de nº de pedido, visto bueno factura...).
- **Vista para tablet** del técnico: solo ve sus O.T. asignadas, registra tiempos, checklist, fotos y firma del cliente.
- **Recambios**: el almacén vincula los repuestos usados a cada O.T.
- **Cierre y facturación**: parte de trabajo, albarán y reclamación automática del nº de pedido al cliente cuando lo exige.
- **Clientes**: ficha con razón social, NIF/CIF, email, teléfono y dirección; buscador rápido; los clientes no se borran, se desactivan.
- **Integración con Karve** (el ERP) para inventario, clientes, máquinas y numeración. Hasta que llegue, los clientes se dan de alta a mano y la pantalla indica si cada uno es manual o viene de Karve.
- **Ayuda de IA**: redacta el parte para el cliente a partir de las notas del técnico y sugiere mantenimientos preventivos.

## Quién la usa

| Rol | Qué ve |
|---|---|
| Admontaller / Responsable | Todo: Kanban, planificación, aprobación de asignaciones |
| Técnico / Operario | Sus O.T. en la tablet |
| Recambista / Almacén | Entrada de material y repuestos por O.T. |
| Financiero / Administración | Facturación, albaranes, nº de pedido |
| Comercial | Estado de las O.T. de sus clientes (solo lectura) |
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

En desarrollo. **Fase 1 completada** (octubre de 2026): acceso con usuarios y roles, base de datos, API de O.T. y maestros, y la interfaz con Tablero, vista de tablet y listado. **Fase 2 en curso**: rediseño visual hecho y pantalla de Clientes; siguen Máquinas y usuarios. El plan por fases está en `contexto/PLAN.md` (archivo local, no versionado).
