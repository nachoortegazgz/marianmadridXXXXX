# Migración canónica del catálogo — 2026-10-23

## Estado

**Proyecciones públicas creadas y pobladas; lector público fusionado en `main`; publicación Wix y QA final pendientes.** Este documento no declara cerrada la migración ni autoriza borrar campos o registros.

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

La edición de `ServiciosCatalogo` y `ComplementosCatalogo` es manual por parte del staff, por decisión expresa del negocio. **No debe añadirse sincronización automática** entre las colecciones fuente y las proyecciones públicas. La proyección pública se actualiza mediante un procedimiento manual controlado cuando el staff decide publicar cambios. La ausencia de sincronización automática no es un defecto ni una deuda técnica.

El procedimiento manual debe mantener trazabilidad y coherencia: revisar los cambios aprobados en la fuente, trasladar únicamente los campos permitidos a la proyección correspondiente, validar referencias F1/F2 y precios/duraciones, comprobar los conteos e IDs afectados y verificar el resultado público. No se deben publicar datos internos ni asumir relaciones de complementos no confirmadas. La cadencia y la persona responsable deben definirse operativamente por el negocio; no se presuponen aquí.

## Estado de la proyección pública

Se crearon y poblaron de forma aditiva las colecciones `ServiciosCatalogoPublico` (95 registros) y `ComplementosCatalogoPublico` (36 registros). Ambas tienen lectura `ANYONE` y escritura restringida a `ADMIN` a nivel de colección / `PRIVILEGED` en data permissions. La verificación de lectura autenticada confirma que no existen campos sensibles en su esquema ni en los ítems. Las colecciones fuente permanecen intactas y con permisos `ADMIN`.

PR #103 fusionada en `main` cambia los métodos públicos para consultar `ServiciosCatalogoPublico`; los flujos internos de reserva/fiscalidad conservan `ServiciosCatalogo`. La proyección incluye `addOnOptions=[]` porque el CMS fuente no contiene relaciones de complemento pobladas. El código no debe publicarse hasta ejecutar la batería de QA contra la proyección ya poblada.

**Control operativo requerido:** dado que el staff actualiza las colecciones fuente manualmente y la proyección se publica de forma deliberada, el riesgo a controlar no es la falta de automatización, sino la omisión o el error en el procedimiento manual de publicación. No implementar hooks ni sincronización automática.

## Trabajo pendiente para cierre completo

1. Inventariar datasets, páginas dinámicas y componentes del Editor Wix que lean directamente los dos catálogos privados; el árbol completo del Editor no está disponible en esta revisión del repositorio.
2. Sincronizar/publicar el código de `main` en Wix Editor sin cambiar permisos ni borrar datos.
3. Ejecutar prueba de lectura anónima directa para las dos proyecciones y confirmar denegación en las dos colecciones privadas.
4. Ejecutar en QA independiente páginas dinámicas, fichas, complementos, reserva simple y reserva dual (F1, exposición, F2, cancelación/compensación).
5. Definir y documentar el procedimiento manual de publicación de catálogo (aprobación, campos permitidos, validaciones, trazabilidad y comprobación posterior); no implementar sincronización automática.
6. Resolver asignaciones de complementos con una fuente de negocio verificable; no inferirlas del nombre ni del tipo de servicio.
7. Verificar conteos, IDs y referencias tras publicar. No borrar filas ni columnas durante esta fase.
8. Solo después de esas pruebas, cerrar issue #100 con evidencia reproducible.

## Criterio de cierre

La migración solo se considera terminada cuando la web pública utiliza las proyecciones, las colecciones privadas no son accesibles anónimamente, los flujos simples/duales pasan QA real y la conciliación demuestra cero pérdida y cero duplicación. Los tests offline no sustituyen esa evidencia.
