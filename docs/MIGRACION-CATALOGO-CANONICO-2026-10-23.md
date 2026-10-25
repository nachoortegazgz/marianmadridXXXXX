# Migración canónica del catálogo — 2026-10-23

## Estado

**Decisión vigente:** usar exclusivamente `ServiciosCatalogo` y `ComplementosCatalogo` como colecciones maestras privadas. Las colecciones espejo `ServiciosCatalogoPublico` y `ComplementosCatalogoPublico` ya fueron eliminadas de Wix. No deben recrearse ni utilizarse como fallback.

## Autoridad de datos

- Wix Bookings: servicio reservable, recursos, disponibilidad y reservas.
- `ServiciosCatalogo`: contenido editorial, reglas de servicio, fases y metadatos internos.
- `ComplementosCatalogo`: maestro interno de complementos.
- DTO público: allowlist explícita; nunca serializar un registro CMS completo.
- Costes, margen, notas internas y clasificación fiscal/contable: nunca en una proyección pública.

## Auditoría de solo lectura del CMS publicado

Sitio: `188bed94-177c-4bc9-a9f0-35080d874f3e`.

| Comprobación | Resultado observado |
|---|---:|
| Registros en `ServiciosCatalogo` | 95 |
| Registros en `ComplementosCatalogo` | 36 |
| Entradas de servicio con `itemNature=SERVICIO_PROPIO` | 93 |
| Entradas con `catalogEntryType=SERVICE` explícito | 1 |
| Entradas con `catalogEntryType=PRICING_PLAN` | 1 |
| Servicios duales | 24 |
| Servicios duales con fases/duraciones obligatorias ausentes | 0 |
| Enlaces duales no resueltos contra los `serviceId` del catálogo | 0 |
| Duplicados observados de `serviceId`, `slug` o `addonId` | 0 |
| Registros con `availableStaff` | 0 |
| Registros con campo `status` | 0 |
| Registros con valor de relación CMS `name` devuelto en los ítems de servicio | 0 |

Campos internos encontrados en el catálogo de servicios: `precioCosteBase`, `margin`, `internalNotes` y `tipoImpositivo` aparecen en 93 registros. En los 36 complementos aparecen `tipoImpositivo`, `cuentaContableIngreso`, `codigoImpuesto` y `claveRegimen`.

La consulta actual de metadatos de Wix devuelve permisos de colección `ADMIN` para lectura, inserción, actualización y borrado tanto en `ServiciosCatalogo` como en `ComplementosCatalogo`. Esto contradice el hallazgo histórico del issue #100 que registraba lectura `ANYONE`; se debe conservar la evidencia actual y comprobar acceso anónimo directo tras publicar las proyecciones.

Aunque el esquema de `ServiciosCatalogo` contiene el campo multi-reference `name`, la consulta de los 95 registros no devolvió ese campo en ningún ítem. Por tanto, no hay evidencia de relaciones de complementos pobladas en el catálogo de servicios. La migración no debe inventar asignaciones: primero hay que definir las relaciones servicio-complemento a partir de datos de negocio verificables.

## Cambios de contrato incluidos en esta fase

- El mapper canónico es `_mapServiceToDTO`; se elimina el nombre legado `_mapServiceImport2ToUX`.
- Los complementos del servicio se leen desde la relación CMS canónica `ServiciosCatalogo.name` (multi-reference a `ComplementosCatalogo`), sin fallback a campos inexistentes/legacy `addOnOptions` o `addons` dentro del registro CMS.
- El nombre comercial del complemento procede de `ComplementosCatalogo.name`; se elimina el alias `nombreComplemento`.
- El DTO de transporte conserva `addOnOptions` como estructura pública, separada del keyfield relacional de CMS.

## Operativa intencionada del catálogo y de la proyección pública

La edición de `ServiciosCatalogo` y `ComplementosCatalogo` es manual por parte del staff. No existe una segunda colección de catálogo que haya que publicar o sincronizar. Las dos colecciones maestras mantienen permisos privados (`ADMIN`); los métodos web públicos leen desde backend mediante la capa de acceso a datos y construyen un DTO con allowlist explícita. Nunca se serializa el registro CMS completo.

La visibilidad se limita por dos capas: permisos privados de CMS y minimización de datos en los métodos públicos. Costes, márgenes, notas internas y campos fiscales/contables no forman parte del DTO. Las relaciones de complementos solo se exponen cuando se resuelven con datos reales de `ComplementosCatalogo`; no se inventan asignaciones.

## Estado de la reversión

Las colecciones espejo `ServiciosCatalogoPublico` y `ComplementosCatalogoPublico` ya se eliminaron de Wix. Este nombre solo puede aparecer en documentación histórica o en tests negativos que comprueben que el código no intenta leerlas. No recrearlas, no consultarlas y no añadir fallbacks.

El cambio de código sustituye el lector de la proyección por `_getServiceBySlugOrIdInternal`, que consulta `ServiciosCatalogo` a través de `backend/dataAccess` y devuelve un DTO reducido. Se añade búsqueda por `pricingPlanId` para conservar la resolución de bonos. Las colecciones fuente y sus registros no se borran ni se migran.

## Trabajo pendiente para cierre completo

1. Aprobar y fusionar el cambio de código cuando pase CI.
2. Publicar el código actualizado en Wix y comprobar ficha simple, bono, servicio dual (F1, exposición, F2), servicio oculto y errores de catálogo.
3. Confirmar que las lecturas públicas no devuelven campos internos y que las dos colecciones maestras siguen privadas.
4. Confirmar mediante búsqueda estática que el código activo no consulta ninguna colección espejo.
5. Ejecutar tests offline y smoke tests del sitio publicado; comprobar explícitamente que el catálogo funciona sin las colecciones eliminadas.
6. Mantener los nombres de las colecciones eliminadas únicamente en pruebas negativas y contexto histórico, sin dependencias operativas.

## Criterio de cierre

La migración solo se considera terminada cuando el backend lee exclusivamente de las colecciones maestras privadas, los DTO públicos aplican allowlist, las colecciones privadas no son accesibles anónimamente, los flujos simples/duales pasan QA real y la conciliación demuestra cero pérdida y cero duplicación. Los tests offline no sustituyen esa evidencia.
