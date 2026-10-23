# Arquitectura de catálogo privado

**Estado:** objetivo de arquitectura vigente para Marian Madrid.

## Colecciones canónicas

- `ServiciosCatalogo`: fuente maestra de servicios, reglas, fases, duración, precio y metadatos internos.
- `ComplementosCatalogo`: fuente maestra de complementos.
- Ambas colecciones permanecen privadas, con permisos CMS `ADMIN`.

## Lectura desde la web

Los métodos web públicos acceden al catálogo únicamente desde backend mediante `backend/dataAccess`. El backend construye un DTO explícito con los campos necesarios para mostrar y reservar un servicio. Nunca debe devolverse un registro CMS completo.

Los campos de coste, margen, notas internas y fiscalidad/contabilidad quedan fuera del DTO público. Los servicios duales deben resolver F2 desde la misma colección canónica y fallar de forma cerrada si el vínculo no existe o es inválido. Los bonos se resuelven por `pricingPlanId` además de su slug.

## Sin colecciones espejo

No se mantienen `ServiciosCatalogoPublico` ni `ComplementosCatalogoPublico`. No se implementa replicación, sincronización ni publicación manual hacia colecciones espejo.

## Orden seguro de retirada

1. Fusionar el código que deja de consultar las colecciones espejo.
2. Publicar ese código en Wix.
3. Probar fichas, bonos, servicios simples y duales, y confirmar minimización del DTO.
4. Verificar que no hay consumidores directos de las colecciones espejo.
5. Borrar las dos colecciones espejo por sus IDs exactos.
6. Confirmar que las fuentes maestras conservan sus registros y permisos privados.

No borrar ni alterar las colecciones canónicas ni sus registros durante esta operación.
