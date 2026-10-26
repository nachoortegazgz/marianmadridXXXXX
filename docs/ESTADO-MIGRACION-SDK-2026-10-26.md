# Estado de migración SDK — Marian Madrid

**Corte documental:** 2026-10-26  
**Rama principal:** `main`  
**Último commit observado en main:** `143b85cdec896f018c8f9bdb9858f78cd2d7d99e` (merge PR #206; incluye PR #205 y PR #204)  
**Última migración integrada:** PR #205, merge commit `5f3c44026c859b57abdc0429f3676021ed05b955`. **Corrección posterior en revisión:** PR #207.  
**Corte canónico relacionado:** `docs/MIGRACION-ESTADO-CANONICO-2026-10-26.md`.

## Estado ejecutivo

**Migración parcial y activa; no está cerrada.** El flujo de pago de reservas Cart V2 ya está integrado en `main` mediante PR #204. El PR #205 alineó la versión del paquete eCommerce, regeneró lockfile con npm, retiró dependencias directas no importadas por el código y limpió alias sin consumidores. Se fusionó en `main`, pero la validación observada de su head no superó todos los gates.

## Cambios confirmados en main (PR #204)

- **eCommerce:** la saga de reservas usa `cartV2.createCart` y `cartV2.getCheckoutUrl` desde `@wix/ecom`; las llamadas Checkout V1 se retiraron de este flujo.
- **Bookings:** el lector `extendedBookings.queryExtendedBookings` usa `@wix/bookings`; el resto de operaciones requiere inventario y validación de contratos.
- **Members:** seis módulos usan `members.getCurrentMember()` desde `@wix/members`: `security.web.js`, `security.js`, `horario.web.js`, `cajas.web.js`, `citasManager.web.js` y `reservas.web.js`.
- **Data:** `src/backend/dataAccess.js` centraliza operaciones CMS mediante `@wix/data` y `@wix/essentials`.
- **Secrets:** las lecturas están centralizadas en `src/backend/secretVault.js` mediante `@wix/secrets`; esto no demuestra que los valores requeridos estén configurados en Wix.
- **Catálogo:** el sitio productivo conserva Wix Stores Catalog V1. Catalog V3 queda aplazado por decisión explícita.
- **Facturas:** el sitio productivo usa Wix Invoices V1; no introducir estructuras V2 en esta fase.

## Cambios propuestos por PR #205 (no atribuir a main)

- Fijar `@wix/ecom@1.0.2542` y regenerar `package-lock.json` mediante npm.
- Eliminar dependencias directas no utilizadas tras inventario: `@wix/user-management`, `@wix/auto_sdk_bookings_extended-bookings`, `@wix/site-location`, `@wix/site-storage` y `@wix/site-window`. La dependencia auto-SDK podría continuar de forma transitiva si `@wix/bookings` la necesita.
- Retirar el alias sin consumidores `bookingCore._rankResourcesByLoad), consolidar imports duplicados de `bookingUtils` y eliminar el re-export redundante `_extractCartId`.
- Actualizar la matriz SSOT y el estado de migración.

## Evidencia de validación y límites

En el cuerpo del PR #205 se registran resultados de un head anterior: instalación y parseo correctos, `npm audit` con cero vulnerabilidades, ESLint en 58 archivos sin errores ni warnings y smoke test HTTPS satisfactorio. También se documentan **308 pruebas aprobadas y 12 fallidas en cinco suites**: concurrencia de reservas, procedencia de datos, sincronización nativa Bookings, `reservas.web` y flujos del sitio. No se deben ocultar ni debilitar esos fallos.

El mismo PR indica que Wix Preview estaba pendiente y que el inventario final/limpieza había avanzado después de la última validación. Por ello esos resultados históricos no demuestran el estado del head actual `fc1effd...`.

El head de PR #205 (`fc1effd...`) tuvo checks de regresión fallidos: 308 aprobadas y 12 fallidas en cinco suites. Wix Preview falló con `PUBLISH_PIPELINE_TASK_NOT_FOUND` y timeout. El smoke test público y el diagnóstico de calidad pasaron. No hay evidencia de que esos fallos se hayan resuelto al fusionar; PR #207 aborda dos causas verificables. El estado correcto es **gates bloqueados**, no “CI aprobado”.

## Bloqueadores de cierre

1. Comprobar CI sobre el head exacto del PR #205 después de sus últimos cambios.
2. Resolver los 12 fallos de regresión o demostrar con evidencia que son defectos de base conocidos; no eliminar aserciones ni aceptar suites vacías.
3. Obtener un Wix Preview correcto y verificar reserva → URL Cart V2 → pago de prueba → sincronización posterior.
4. Completar el inventario de imports, dependencias, endpoints REST, contratos y consumidores. No concluir migración solo por búsqueda de nombres.
5. Validar la configuración efectiva de secretos, permisos y autorización de negocio.
6. Verificar el riesgo histórico de lectura anónima de campos internos en CMS (issue #100): la auditoría CMS más reciente informa permisos ADMIN, pero falta evidencia de acceso anónimo directo, datasets y páginas publicadas. Mantener DTO público con allowlist y no asumir exposición ni resolución sin prueba.
7. Habilitar QA Wix aislada para E2E reales (issue #96). Las pruebas con mocks deben etiquetarse como simulación offline, no E2E real (issue #115).

## Comandos de validación

```powershell
npm ci
npm run lint
npm run test:layer1
npm run test:layer2
npm test
```

Ejecutar en el head que se pretende fusionar y adjuntar los resultados. Si `npm ci` no es compatible con el lockfile presente, registrar el motivo en lugar de cambiar silenciosamente de procedimiento.

## Seguridad y publicación

No se han realizado cambios en Wix producción como parte de este corte documental. No crear reservas, pagos, reembolsos, facturas, fichajes ni cierres sintéticos en producción. No publicar cambios de código hasta que pasen los gates de regresión, Preview y flujo de pago en QA aislada.
=======
# SDK migration and cleanup status — Marian Madrid

Cut-off: 2026-10-26
Active branch: cleanup/sdk-migration-and-debt
Previous integration: PR #204 (Cart V2, Members, Bookings reader, CMS field-ID alignment)
Current change: dependency lockfile reconciliation and minimal backend cleanup

## Verified implementation state

- **eCommerce:** online booking saga uses `cartV2.createCart` and `cartV2.getCheckoutUrl` from `@wix/ecom`; Checkout V1 calls are removed from this flow.
- **Package alignment:** `@wix/ecom` is pinned to `1.0.2542` in `package.json` and `package-lock.json`. The lockfile was regenerated by npm in GitHub Actions; no integrity hashes were hand-written.
- **Direct dependency cleanup:** removed `@wix/user-management`, `@wix/auto_sdk_bookings_extended-bookings`, `@wix/site-location`, `@wix/site-storage`, and `@wix/site-window` from direct dependencies because application source does not import them. The Bookings auto-SDK package may remain transitively through `@wix/bookings`; that is expected if required upstream. npm regenerated the lockfile.
- **Bookings:** `extendedBookings.queryExtendedBookings` is imported from `@wix/bookings`; test mocks use the same namespace.
- **Members:** six backend modules use `members.getCurrentMember()` from `@wix/members`: `security.web.js`, `security.js`, `horario.web.js`, `cajas.web.js`, `citasManager.web.js`, and `reservas.web.js`.
- **Data and Secrets:** CMS access is centralized in `backend/dataAccess.js` using `@wix/data` and `auth.elevate`; secret reads are centralized in `backend/secretVault.js` using `@wix/secrets`.
- **Targeted backend cleanup:** removed the unused deprecated `bookingCore._rankResourcesByLoad` compatibility alias; consolidated duplicate `bookingUtils` imports in `bookingSaga.js`; removed its redundant `_extractCartId` re-export.
- **Catalog:** Catalog V1 remains unchanged. Catalog V3 is explicitly deferred.

## Remaining validation gates

1. Run focused Cart V2 and Members/Bookings contract tests, full backend regression, lint and dependency audit on this exact branch.
2. Compare any regression failures against the previously observed baseline (307 passed, 12 failed across five suites); the current branch head reports 308 passed and 12 failed across the same five suites. These match the known baseline failure count; no syntax cascade is present.
3. Confirm a successful Wix Preview build and test the complete booking → Cart V2 checkout redirect → payment → post-payment synchronization flow.
4. Review the final diff before merge. No production publish is authorized by this status note.

## Legacy inventory

The source search found no remaining production imports of `wix-ecom-backend`, `wix-bookings.v2`, `wix-members-backend`, or `wix-secrets-backend`. Remaining mentions are migration documentation or comments. Velo-native APIs such as `$w`, `wix-web-module`, and HTTP functions are not SDK-migration targets merely because they are not npm SDK imports.
\n\n## Actualización posterior al merge PR #205\n\nEl merge del PR #205 no convierte automáticamente en verdes los checks fallidos que se observaron en su head. El PR #207 corrige (1) el desajuste entre `INVENTORY_MOVEMENT_TYPE` y la lista hard-coded del hook CMS y (2) la falta de propagación de errores forzados de consulta en el mock `@wix/data`. Estos cambios deben validarse por CI antes de fusionarse. Los demás fallos fiscales/de fixtures y la causa de Preview siguen abiertos hasta nueva evidencia.\n