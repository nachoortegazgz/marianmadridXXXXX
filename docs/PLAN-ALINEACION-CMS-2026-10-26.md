# Plan de alineación CMS, runtime y documentación — 2026-10-26

Repositorio: `nachoortegazgz/marianmadridXXXXX`

## Estado y regla de autoridad

El diccionario `docs/CMS KEYFIELDS.md` documenta 13 colecciones, incluida `MapaStaff`. El esquema vivo de Wix es la autoridad para keyfields, etiquetas visibles, tipos, referencias y permisos. Las etiquetas visibles no alteran los nombres técnicos. No se han cambiado datos ni el esquema de producción en esta fase documental.

## Orden obligatorio

### P0 — Contrato CMS ↔ código

1. Comparar cada campo leído/escrito por backend y frontend con el keyfield actual del CMS.
2. Registrar discrepancias por colección, archivo, función y operación (lectura/escritura).
3. Corregir los nombres no canónicos sin crear alias ni fallbacks.
4. Añadir pruebas de contrato y casos de regresión por cada corrección.
5. No retirar campos del CMS hasta revisar los consumidores y los registros persistidos.

### P0 — MapaStaff ya existe

La colección ya está creada: revisión 11, 19 campos (15 de negocio/referencia y 4 del sistema Wix). Runtime: `resourceId` = recurso Bookings; `staffMemberId` = miembro de Bookings. `wixStaffMemberId` es un campo duplicado histórico y no se debe consultar como fallback. No crear otra colección de personal.

### P0 — Prohibición de colecciones espejo

No crear colecciones espejo de servicios ni complementos. Utilizar `ServiciosCatalogo`, `ComplementosCatalogo`, `MapaStaff` y las referencias CMS existentes. La existencia de un nuevo requisito no justifica por sí sola una nueva colección.

### P1 — Código mínimo y deuda técnica

Tras resolver los contratos CMS: detectar y retirar código muerto, duplicado, legacy, comentarios obsoletos, wrappers prescindibles y verificaciones redundantes. Cambios pequeños, pruebas reproducibles, cobertura de regresión y CI verde. No eliminar tests valiosos sin demostrar que la cobertura se conserva. La meta es el backend mínimo funcional, no reducir líneas a costa de fiabilidad.

### P1 — Wix Stores Catalog V3

Migración pendiente. Inventariar todas las APIs/consumidores actuales; confirmar el contrato de destino; migrar adaptadores; probar productos, variantes, stock, imágenes y referencias; documentar rollback. No declararla completa hasta que todos los consumidores y pruebas pasen.

## Evidencia de cierre

Cada fase debe informar: archivos afectados, keyfields corregidos, pruebas ejecutadas, resultados CI, riesgos de datos y estado de despliegue. Cambios en GitHub no sincronizan automáticamente Wix Editor ni publican en producción.


## Updated visible labels

The attached CMS dictionary proposes `personalMiembros` for `ServiciosCatalogo.staffMembers` and `serviciosCatalogoPersonalMiembros` for `ServiciosCatalogo_staffMembers`. The live Wix API queried on 2026-10-26 still returns `miembrosPersonal` and `Servicios vinculados`; reconcile this before claiming the labels are live. These are labels, not keyfields; code must continue to use technical IDs.
