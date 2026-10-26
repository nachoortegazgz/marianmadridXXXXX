# Estado de migración SDK y limpieza backend — Marian Madrid

Corte: 2026-10-26
Rama de trabajo: `cleanup/sdk-minimal-backend-2026-10-26`
PR: pendiente de abrir tras validación inicial.
Producción Wix: sin publicación de estos cambios.

## Cambios integrados en main antes de esta rama

- **eCommerce:** el flujo de pago de reservas usa Cart V2 mediante `cartV2.createCart` y `cartV2.getCheckoutUrl` desde `@wix/ecom`; se retiró el uso de Checkout V1 en ese flujo.
- **Bookings:** las lecturas de reservas extendidas usan `extendedBookings.queryExtendedBookings` desde `@wix/bookings`.
- **Members:** seis módulos backend usan `members.getCurrentMember()` desde `@wix/members`; se retiraron imports runtime de `wix-members-backend` y el mock legacy.
- **CMS:** el acceso central pasa por `@wix/data` y `auth.elevate` en `backend/dataAccess.js`; secretos pasan por `@wix/secrets` en `backend/secretVault.js`.
- **IDs CMS:** los escritores usan los IDs canónicos actuales comunicados: `snapshotJSON`, `staffMemberId`, `NIFEmisor`, `NIFDestinatario`, `IRPFWithholdingAmount`, `IRPFWithholdingRate`, `payloadAEAT` y `transactionId`. No reintroducir `snapshotJson` ni `wixStaffMemberId`.

## Cambios de esta rama

- Migradas las opciones de lectura fuerte de `consistencyMode: "strong"` a `consistentRead: true` en `bookingCore.js`, `bookingSaga.js` y `crons.js`.
- Simplificado `dataAccess.js`: retirado el soporte de los alias legacy `consistencyMode` y cadena `"strong"`; conservada la opción canónica `consistentRead`.
- Eliminados del adaptador CMS los exports sin consumidores verificados: `bulkInsert`, `bulkUpdate`, `bulkRemove`, `queryReferencedItems`, sus wrappers privados y factories elevadas. También retirados `CONSISTENCY.EVENTUAL` y el helper `order` sin consumidores internos.
- `secretVault.js` crea la función elevada una sola vez al cargar el módulo, en lugar de recrearla por cada lectura.
- `package.json` actualizado a `@wix/ecom@1.0.2542`; retiradas las dependencias directas sin imports en el código: `@wix/auto_sdk_bookings_extended-bookings` y `@wix/user-management`.
- `package-lock.json` regenerado por npm en GitHub Actions, no editado manualmente. El paquete de extended bookings puede seguir apareciendo como dependencia transitiva de `@wix/bookings`; no se elimina manualmente del lockfile.

## Inventario de imports legacy

En el código runtime no se han encontrado imports de:
- `wix-ecom-backend` para el flujo de Checkout V1.
- `wix-bookings.v2`.
- `wix-members-backend`.
- `wix-secrets-backend`.
- `wix-data` como API de acceso CMS directo.

Las referencias históricas en documentación y mocks de pruebas no son imports runtime. Las APIs nativas de Velo que siguen siendo necesarias no se consideran legacy por el mero hecho de no pertenecer al SDK modular.

## Estado de validación

- La suite Cart V2 tuvo 2/2 pruebas contractuales aprobadas en CI previo a esta rama.
- El smoke test HTTPS público pasó en CI previo.
- El último diagnóstico previo comunicó ESLint sin errores ni avisos y `npm audit` sin vulnerabilidades.
- La regresión backend previa registró 307 aprobadas y 12 fallidas en cinco suites. Debe repetirse sobre esta rama y compararse con el baseline; no se consideran resueltas por estos cambios.
- Wix Preview y el flujo real reserva → checkout → pago → sincronización posterior requieren nueva validación.
- La actualización de dependencias se considera lista para probar, no certificada, hasta que pasen instalación limpia, tests, lint y Preview.

## Alcance y seguridad

- Catalog V1 se conserva temporalmente. Catalog V3 está expresamente aplazado.
- No se ha publicado código de esta rama en producción Wix.
- No fusionar mientras queden fallos de regresión sin explicar, errores de contrato SDK o validación Preview pendiente.
- No rebajar controles de permisos, seguridad, contabilidad, fiscalidad, idempotencia o compensación de reservas para conseguir una suite verde.
