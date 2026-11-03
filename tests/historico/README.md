# Arneses históricos (Fases 1 y 2)

Pruebas tal y como se ejecutaron entre el 2026-10-22 y el 2026-10-27, contra la interfaz anterior al pivote a Field Service Management (2026-11-02). **No pasan sobre el código actual** y no se mantienen: la cabecera ya agrupa Clientes y Máquinas en "Maestros", no hay chips de origen ni avisos de Karve, los clientes no se desactivan a mano, las máquinas tienen edición restringida y los roles `admontaller` y `financiero` se migraron a `responsable_st` y `administrativo`.

| Script | Fase / ticket | Resultado entonces |
|---|---|---|
| `navegador-prueba-revamp.js` | F2-01 revamp UI/UX | 41/41 |
| `cliente-prueba-clientes.js`, `navegador-prueba-clientes.js` | F2-02 clientes v1 | 25/25 + 33/33 |
| `navegador-prueba-datos.js`, `comprobar-datos.js` | script de datos de prueba | 14/14 + 18/18 |
| `cliente-prueba-maquinas.js`, `navegador-prueba-maquinas.js` | F2-03 máquinas v1 | 44/44 + 43/43 |
| `cliente-prueba-usuarios.js`, `navegador-prueba-usuarios.js` | F2-04 usuarios | 54/54 + 39/39 |
| `cliente-prueba-comercial.js`, `navegador-prueba-comercial.js` | F2-05 cartera y jefe comercial | 59/59 + 29/29 |

Los arneses de la Fase 1 (acceso, permisos, API, interfaz) vivieron solo en el área de trabajo temporal del asistente y no se conservaron.
