# Estado técnico verificado — 2026-10-28

## Alcance

Snapshot de solo lectura para el repositorio `nachoortegazgz/marianmadridXXXXX` y el sitio Wix `www.marianmadrid.es`. No se crearon reservas ni se modificaron datos del sitio.

## GitHub

- PR #263 — `ci: align quality gates with project Node.js runtime` — fusionada el 2026-10-28.
- Merge commit: `d83aa65145950435df5f4fd569e0586902ae9c6e`.
- `.github/workflows/quality-gates.yml` usa Node.js `24.22.1`.
- CI de PR #263: éxito en instalación de dependencias, suite completa, Layer 1, Layer 2, `git diff --check` y ESLint sin avisos.
- El workflow de calidad tiene permisos de solo lectura y no publica en Wix.

## Wix — identidad y configuración

- Sitio confirmado: `Marian Madrid Peluquería y Estética`.
- Site ID: `188bed94-177c-4bc9-a9f0-35080d874f3e`.
- Wix Bookings está instalado; Stores Catalog V1 e Invoices V1 siguen siendo las versiones observadas.
- Zona horaria `Europe/Madrid`; moneda EUR.

## Wix Bookings y CMS — auditoría de solo lectura

- Catálogo nativo de Bookings: 94 servicios.
- Colección CMS `ServiciosCatalogo`: 95 registros devueltos.
- Entradas duales en CMS: 24.
- Servicios nativos ocultos: 24.
- Comparación de las 24 entradas duales: cero discrepancias en IDs F1/F2, visibilidad esperada y duraciones de fase frente a Wix Bookings.
- Consultas de disponibilidad confirmaron combinaciones del mismo profesional con los gaps configurados de 25, 35, 40 y 45 minutos para cuatro servicios duales muestreados.
- Para `Corte Clásico`, Wix devolvió slots reservables para el 29 de octubre–4 de noviembre de 2026. La primera página de 100 slots tenía cursor de continuación.
- La disponibilidad nativa y los tests offline no demuestran que el flujo personalizado cree, cobre y sincronice una reserva completa.

## Bloqueo pendiente

El workflow de Wix CLI Preview de PR #223 (run 246) falló con `PUBLISH_PIPELINE_TASK_NOT_FOUND`. Por tanto:

1. El ajuste del contrato de ubicación del SDK está fusionado y las comprobaciones de CI correspondientes finalizaron correctamente.
2. La Preview de Wix y la validación de extremo a extremo siguen pendientes.
3. No se ha publicado código desde esta sesión y no se debe declarar producción validada.

## Siguiente secuencia

1. Resolver el fallo de infraestructura de Preview: conservar logs completos, Request ID y Deployment ID; comprobar `wix whoami`; como máximo un reintento en entorno limpio. Si persiste, escalar a Wix.
2. Mantener el bloqueo de publicación hasta disponer de Preview válida.
3. Continuar inventario de backend/frontend y documentación, en ramas separadas, con pruebas reproducibles y revisión de cada PR.
4. Tras Preview: probar reserva simple, dual F1/F2, hueco exacto, mismo recurso, cancelación/compensación y flujo de pago en entorno controlado antes de publicar.

## Referencias

- PR #223: https://github.com/nachoortegazgz/marianmadridXXXXX/pull/223
- PR #263: https://github.com/nachoortegazgz/marianmadridXXXXX/pull/263
- Quality gates: https://github.com/nachoortegazgz/marianmadridXXXXX/blob/main/.github/workflows/quality-gates.yml
- Wix CLI for Sites: https://dev.wix.com/docs/develop-websites/articles/workspace-tools/developer-tools/git-integration-wix-cli-for-sites/wix-cli-for-sites-commands
- Bookings time slots: https://dev.wix.com/docs/api-reference/business-solutions/bookings/time-slots/time-slots-v2/list-availability-time-slots
