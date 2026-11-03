# Gestión de Taller Vibacar

Aplicación web para gestionar las **Órdenes de Trabajo (O.T.)** de reparación y mantenimiento de maquinaria de Vibacar: desde que entra el aviso hasta que la O.T. queda lista para facturar.

## Qué hace

- **Abre y sigue las O.T.**: cada orden tiene su número (`2026-0001`), su cliente, su máquina, su estado y su historial completo de cambios.
- **Tablero Kanban** para el responsable del taller: las O.T. se ven por fases (abierta, pendiente de repuesto, asignada, en curso, finalizada, pendiente de nº de pedido, visto bueno factura...).
- **Vista para tablet** del técnico: solo ve sus O.T. asignadas, registra tiempos, checklist, fotos y firma del cliente.
- **Recambios**: el almacén vincula los repuestos usados a cada O.T.
- **Cierre y facturación**: parte de trabajo, albarán y reclamación automática del nº de pedido al cliente cuando lo exige.
- **Clientes**: ficha con razón social, NIF/CIF, teléfono, dirección, contacto de compras, contacto técnico (recibe los partes), correo de envío de facturas, fecha de la última factura y comercial responsable; buscador rápido. Un cliente sin factura en los últimos 3 años pasa a "antiguo" y deja de salir en la lista (se puede ver con "Todos").
- **Máquinas**: ficha con marca, modelo, bastidor, estado (propia, rent to rent, subalquilada o de cliente final), nº de contrato, características técnicas para el mecánico, horas y observaciones. El nº de flota lo asigna la aplicación al crearla (`F-26-0001`, correlativo por año; los antiguos de Karve se respetan). Tras el alta solo se cambian las horas y las observaciones; un administrativo puede corregir el resto. Desde la ficha del cliente se ven y se dan de alta sus máquinas. No se borran: se desactivan.
- **Usuarios**: el administrador da de alta al personal (técnicos internos, SAT externos y oficina) con su usuario, rol y contraseña, y puede cambiarla o desactivar a quien se marcha sin perder su historial. Cada técnico lleva su código de operario en Karve para imputar horas más adelante.
- **Integración con Karve** (el ERP): primero en solo lectura (clientes, máquinas, comercial de cada cliente y fecha de la última factura) y más adelante inventario, albaranes y numeración. Hasta que esté conectada, los clientes y las máquinas se dan de alta a mano.
- **Ayuda de IA**: redacta el parte para el cliente a partir de las notas del técnico y sugiere mantenimientos preventivos.

## Quién la usa

| Rol | Qué ve |
|---|---|
| Administrativo | Ve y edita todo, gestiona usuarios y es el único que corrige los campos bloqueados de una máquina |
| Responsable de Servicio Técnico | Toda la operativa: Tablero, planificación, asignaciones y maestros (no gestiona usuarios) |
| Gerencia | Solo lectura de todo |
| Gestor de SAT externos | Opera y aprueba solo las O.T. de SAT externos (y las que aún no tienen técnico) |
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

En desarrollo. **Fase 1 completada** (octubre de 2026): acceso con usuarios y roles, base de datos, API de O.T. y maestros, y la interfaz con Tablero, vista de tablet y listado. **Fase 2 en curso**: rediseño visual hecho y pantallas de Clientes, Máquinas y Usuarios, y cartera de clientes por comercial; sigue la carga inicial de maestros. El plan por fases está en `contexto/PLAN.md` (archivo local, no versionado).
