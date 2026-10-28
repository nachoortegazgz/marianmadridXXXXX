# Estado de migración SDK y limpieza — Marian Madrid
> **Estado histórico, no corte actual.** Este informe describe el estado observado el 2026-10-26 y sus referencias a PRs reflejan ese momento. Para el estado verificable más reciente, usar [MIGRACION-ESTADO-CANONICO-2026-10-26.md](MIGRACION-ESTADO-CANONICO-2026-10-26.md), cuya actualización del 2026-10-28 registra el commit actual, los contratos de Capa 1 y los resultados CI. No interpretar los estados de revisión antiguos de este documento como estado actual.

**Corte:** 2026-10-26  
**Rama principal observada:** `main` (incluye PR #204–#207)  
**Migración eCommerce integrada:** PR #204 y PR #205  
**Limpieza backend en revisión:** PR #209  
**Correcciones fiscales/caja en revisión:** PR #210  
**Publicación Wix:** no se ha publicado código de estas ramas en producción.

## 1. Estado actual en main

- **eCommerce:** la saga de reservas usa Cart V2 mediante `cartV2.createCart` y `cartV2.getCheckoutUrl` desde `@wix/ecom`. El uso de Checkout V1 se retiró de este flujo.
- **Dependencias:** `@wix/ecom@1.0.2542` está fijado en `package.json` y `package-lock.json`; npm generó el lockfile. Se retiraron dependencias directas sin imports de producción comprobados.
- **Bookings:** el lector `extendedBookings.queryExtendedBookings` usa `@wix/bookings`; el resto de operaciones requiere inventario y validación de contratos.
- **Members:** seis módulos backend usan `members.getCurrentMember()` desde `@wix/members`.
- **Data:** `backend/dataAccess.js` centraliza el acceso CMS mediante `@wix/data` y `auth.elevate`.
- **Secrets:** las lecturas se centralizan en `backend/secretVault.js` mediante `@wix/secrets`; esto no demuestra que los secretos requeridos estén configurados en Wix.
- **CMS:** los IDs canónicos comunicados para el esquema actual incluyen `snapshotJSON`, `staffMemberId`, `NIFEmisor`, `NIFDestinatario`, `IRPFWithholdingAmount`, `IRPFWithholdingRate`, `payloadAEAT` y `transactionId`. No reintroducir `snapshotJson` ni `wixStaffMemberId`.
- **Catálogo y facturas:** se conserva Stores Catalog V1 y Wix Invoices V1. Catalog V3 queda aplazado por decisión operativa.

## 2. Limpieza backend propuesta en PR #209

- Unificar lecturas fuertes con `consistentRead: true` en `bookingCore.js`, `bookingSaga.js` y `crons.js`.
- Eliminar del adaptador CMS los alias de consistencia antiguos y los exports sin consumidores internos verificados: `bulkInsert`, `bulkUpdate`, `bulkRemove`, `queryReferencedItems`, `CONSISTENCY.EVENTUAL` y `order`.
- Reutilizar la función elevada de Secrets SDK en lugar de recrearla en cada llamada.
- Añadir una prueba de regresión para que la superficie pública de `dataAccess.js` se mantenga mínima y canónica.

La primera ejecución de esta rama reportó `npm ci` correcto, ESLint correcto y **309 pruebas aprobadas / 12 fallidas en 5 suites**. Ese resultado pertenece al head de limpieza antes de combinar las correcciones fiscales más recientes; no certifica el head combinado actual. No se han debilitado las pruebas.

## 3. Correcciones fiscales/caja en PR #210

El head de código `04a5b17...` reportó **320/320 pruebas, 38 suites, 0 fallos**, con Layer 1 163/163, Layer 2 99/99, Booking regression, Validate, Quality diagnostics, smoke test público y `npm audit` aprobados. Los commits posteriores de esa PR son documentales, según su descripción. Wix Preview sigue pendiente.

Los resultados de PR #210 no prueban por sí solos que la limpieza de PR #209 esté validada; después de integrar ambas líneas hay que volver a ejecutar los gates sobre el head exacto.

## 4. Bloqueadores de cierre

1. Ejecutar regresión completa, Layer 1, Layer 2, lint, instalación limpia y audit en el head combinado tras integrar las correcciones fiscales/caja.
2. Completar Wix Preview con éxito.
3. Validar en un sitio QA aislado el flujo reserva → URL Cart V2 → pago de prueba → sincronización posterior. La cuenta Wix observada solo expone el sitio de producción, por lo que no se deben generar transacciones sintéticas allí.
4. Completar el inventario de llamadas/contratos SDK y revisar cualquier import legacy residual; una búsqueda de nombres por sí sola no certifica migración total.
5. Verificar configuración real de secretos y permisos de negocio.
6. Comprobar acceso anónimo directo a campos internos del CMS, datasets y páginas dinámicas antes de afirmar que la exposición está resuelta.

## 5. Nota sobre permisos CMS

El informe aportado en la conversación indica permisos `ADMIN` para las 13 colecciones. Sin embargo, la consulta REST de Wix documentada el 26-10-2026 en PR #210 devuelve valores literales `CMS_EDITOR` para operaciones de las colecciones operativas y `PRIVILEGED` para escritura/borrado de `ServiciosCatalogo` y `ComplementosCatalogo`. No son necesariamente el mismo nivel de configuración. No cambiar permisos a ciegas: contrastar en Wix el valor REST efectivo y las reglas de acceso anónimo.

## 6. Seguridad y publicación

No fusionar ni publicar hasta que los gates pasen sobre el head exacto y el flujo de pago se valide en QA aislada. No crear reservas, pagos, reembolsos, facturas, fichajes ni cierres sintéticos en producción.
