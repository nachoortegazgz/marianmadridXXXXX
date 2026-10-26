# Estado canónico de migración y plan de cierre — 2026-10-26

## Propósito y precedencia

Este documento fija el corte verificable de la migración del repositorio `nachoortegazgz/marianmadridXXXXX` a fecha 2026-10-26. Prevalece sobre informes de migración anteriores cuando describan el estado del código antes de los merges y commits enumerados aquí. No sustituye la Biblia SSOT ni autoriza cambios de producción.

**Estado global:** migración parcial y activa. No declarar finalización hasta disponer de pruebas locales/CI verdes, revisión de contratos y validación real en Wix QA aislada. Un paquete instalado o un merge no prueba equivalencia funcional ni despliegue correcto.

## Fuentes comprobadas

- Rama de integración: `main`.
- Último commit observado: `1e576c499fd2c109bf71179d1bac82360212343b`, merge del PR #204, titulado “Migrate booking payment flow to Wix eCommerce Cart V2 SDK”, creado el 2026-10-26.
- En el historial reciente también constan cambios de alineación CMS, rechazo de variantes de campos retirados, retirada de referencias obsoletas de MapaStaff y aplazamiento explícito de Catalog V3.
- `package.json` contiene scripts `lint`, `test:layer1`, `test:layer2` y `test`, y dependencias SDK para Bookings, Data, eCommerce, Members, Secrets y otros módulos Wix.
- `src/backend/dataAccess.js` centraliza operaciones CMS mediante `@wix/data` y `@wix/essentials`; requiere auditoría de permisos y de uso efectivo de `auth.elevate` por operación.
- `src/backend/mmSecrets.js` contiene nombres canónicos de secretos, no prueba que esos secretos estén configurados en Wix.
- El estado combinado de checks y la consulta de runs asociados al commit #204 no devolvieron checks/runs. Esto significa **sin evidencia CI disponible en esa consulta**, no que las pruebas hayan pasado.
- El sitio Wix `www.marianmadrid.es` está publicado, es Wix Editor con Velo, Bookings instalado, Stores Catálogo V1 e Invoices V1. No se debe aplicar Catalog V3 ni Invoices V2 al sitio actual sin una migración específica aprobada.

## Corrección de afirmaciones anteriores

1. No describir toda la migración del SDK como “pendiente de inventario”: ya hay migraciones integradas, incluido el flujo Cart V2 del PR #204.
2. No describir la migración como “completada”: no hay evidencia CI verificable para el commit de corte ni E2E real contra un sitio QA aislado.
3. La presencia de `@wix/data`, `@wix/bookings`, `@wix/ecom` o `@wix/secrets` en dependencias no demuestra que todos los consumidores estén migrados o que sus contratos sean equivalentes.
4. Mantener Wix Stores Catálogo V1 e Invoices V1 en el sitio de producción. Catalog V3 permanece aplazado y debe tratarse como proyecto separado.
5. No confundir simulación offline con pruebas E2E reales de Wix.
6. La documentación de CMS debe distinguir entre esquema observado, contrato SSOT, consumidor de código y valor real persistido. Un campo que no aparece en el esquema vivo no debe seguir leyéndose como alias silencioso; los datos que no se puedan mapear deben fallar de forma segura y quedar documentados para reconciliación.

## Bloqueadores y riesgos que no deben ocultarse

### P0 — Exposición de campos internos en CMS

El issue #100 documenta que las colecciones `ServiciosCatalogo` y `ComplementosCatalogo` permiten lectura anónima y contienen campos internos (por ejemplo costes/márgenes o clasificación contable). Una allowlist del backend no protege frente a la lectura directa del CMS. No cambiar permisos a ciegas: inventariar datasets, páginas dinámicas y widgets; crear/validar una proyección pública mínima; migrar consumidores; después restringir colecciones internas y probar acceso anónimo en QA.

### P0 — No hay E2E real de Wix demostrado

El issue #96 documenta que producción es el único sitio con las aplicaciones necesarias confirmado en el análisis previo. Los mocks y suites offline no prueban reservas/pagos reales. No crear operaciones sintéticas, reservas, pagos, reembolsos, facturas, fichajes ni cierres en producción. Identificar o preparar un sitio QA aislado con apps, CMS, roles y modo de pago de prueba equivalentes.

### P1 — Simulación integral aún no demuestra ejecución real

El issue #115 distingue entre validar un fixture y ejecutar los 12 escenarios end-to-end offline con escrituras observadas en mocks. El informe debe etiquetarse `OFFLINE_MOCK_SIMULATION` y no como E2E real.

### P1 — Catálogo V3 aplazado

El issue #114 exige especificación, inventario de consumidores, mapeo y rollback antes de migrar. No mezclar esta iniciativa con limpieza general ni ejecutar endpoints `/stores/v3/` en el sitio Catalog V1.

## Orden de ejecución obligatorio

### Fase A — Documentación y corte (rama separada)

- Mantener este documento como corte canónico y usarlo para reconciliar informes previos.
- Localizar cada documento de estado, migración, QA y CMS que afirme estados incompatibles; actualizarlo en esta rama con la referencia al corte y conservar decisiones históricas sin presentarlas como estado actual.
- Revisar el diff y abrir PR; no fusionar documentación contradictoria sin inspección.

### Fase B — Inventario reproducible del código

- Registrar por archivo y función: API/import actual, SDK destino, uso real, consumidores, datos sensibles, permisos, pruebas y decisión (migrar/mantener/eliminar).
- Buscar imports clásicos, REST/fetch, URLs `wixapis.com`, módulos `wix-data`, `wix-members-backend`, `wix-bookings`, referencias Stores V1/V3 e Invoices V1/V2.
- No reemplazar APIs Velo que sigan siendo válidas ni retirar módulos sin equivalencia funcional demostrada.
- Validar especialmente `resourceId`, `staffMemberId`, `eventsScheduleId` y `serviceId`: nunca intercambiarlos.

### Fase C — Bloqueadores funcionales y de seguridad

1. Proteger las colecciones CMS con campos internos sin romper las páginas públicas.
2. Auditar `dataAccess.js`: cada operación elevada debe tener una justificación de autorización; `elevate()` no sustituye la autorización de negocio.
3. Verificar Wix Secrets, llamadas externas, redacción de logs, límites y errores controlados.
4. Verificar reservas simples y duales: disponibilidad separada de creación, revalidación inmediata, estados coherentes, idempotencia y compensación si F2 falla.
5. Verificar flujo Cart V2: crear checkout no equivale a pago ni a reserva confirmada.
6. Mantener Stores V1 e Invoices V1 en producción mientras no exista migración independiente validada.

### Fase D — Gates automatizados

En entorno reproducible, ejecutar y conservar la salida de:

```powershell
npm ci
npm run lint
npm run test:layer1
npm run test:layer2
npm test
```

Si el repositorio no tiene lockfile compatible con `npm ci`, documentar el bloqueo y no sustituir silenciosamente el procedimiento. Registrar commit, versión de Node/npm, resultado, duración y suites fallidas. Corregir errores antes de continuar. Confirmar que el runner canónico realmente incluye todas las suites requeridas y que ninguna suite vacía se considera éxito.

### Fase E — QA real y liberación controlada

- Ejecutar escenarios de reserva simple/dual, colisión simultánea, fallo F2, pago fallido/pendiente, webhook duplicado, reintento, permisos anónimos, CMS público/privado, stock y cierre de caja en un sitio QA separado.
- Capturar evidencia, IDs de prueba sintéticos, `traceId`, resultados y compensaciones; no incluir PII ni secretos en artefactos.
- Comparar el contrato CMS vivo con el canónico y comprobar lecturas/escrituras en ambas direcciones.
- Publicar solo tras aprobación de tests y revisión del diff; definir rollback antes de tocar producción.

## Criterios de finalización

La migración solo se podrá declarar cerrada cuando:
- El inventario de APIs y consumidores esté completo y cada excepción tenga justificación.
- No existan aliases/lecturas legacy sin consumidores documentados ni fallback silencioso.
- Los contratos de reservas, pagos, CMS y frontend estén cubiertos por pruebas reproducibles.
- Lint y todas las suites pasen en un commit identificado y los checks estén visibles.
- La lectura anónima de colecciones privadas esté denegada sin romper la web pública.
- La QA real de Wix esté separada de producción y exista evidencia verificable.
- La Biblia SSOT, el diccionario CMS y los informes de estado no se contradigan.
- No se haya cambiado la configuración de producción sin una validación y un plan de reversión.

## Limitación de este corte

Este documento se basa en el estado del repositorio y en el contexto de Wix consultados durante esta revisión. No afirma haber ejecutado comandos npm en un equipo local, ni haber publicado código en Wix, ni haber comprobado la configuración de secretos o las pruebas E2E reales.
