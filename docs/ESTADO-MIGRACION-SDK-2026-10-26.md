# Estado de migración SDK — Marian Madrid

**Corte documental:** 2026-10-26  
**Rama principal:** `main`  
**Último commit observado en main:** `1e576c499fd2c109bf71179d1bac82360212343b` (merge PR #204)  
**Siguiente cambio de código pendiente:** PR #205, rama `cleanup/sdk-migration-and-debt`, head `fc1effd43194c2746bad45f6d6f65cee3f0a2277`.  
**Corte canónico relacionado:** `docs/MIGRACION-ESTADO-CANONICO-2026-10-26.md`.

## Estado ejecutivo

**Migración parcial y activa; no está cerrada.** El flujo de pago de reservas Cart V2 ya está integrado en `main` mediante PR #204. El PR #205 propone alinear la versión del paquete eCommerce, regenerar lockfile con npm, retirar dependencias directas no importadas por el código y limpiar alias sin consumidores. PR #205 sigue abierto; sus cambios no deben atribuirse a `main` hasta que se fusione.

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

La consulta de checks y workflow runs asociada al commit de `main` `1e576c4...` no devolvió checks/runs. Estado correcto: **sin evidencia CI disponible en esa consulta**, no “CI aprobado”.

## Bloqueadores de cierre

1. Comprobar CI sobre el head exacto del PR #205 después de sus últimos cambios.
2. Resolver los 12 fallos de regresión o demostrar con evidencia que son defectos de base conocidos; no eliminar aserciones ni aceptar suites vacías.
3. Obtener un Wix Preview correcto y verificar reserva → URL Cart V2 → pago de prueba → sincronización posterior.
4. Completar el inventario de imports, dependencias, endpoints REST, contratos y consumidores. No concluir migración solo por búsqueda de nombres.
5. Validar la configuración efectiva de secretos, permisos y autorización de negocio.
6. Resolver el riesgo de lectura anónima de campos internos en CMS (issue #100) con una proyección pública segura y pruebas de acceso directo.
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
