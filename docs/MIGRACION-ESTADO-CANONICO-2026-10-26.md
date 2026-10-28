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

### P0 — Verificación efectiva de acceso público a campos internos del CMS

El issue #100 registró históricamente lectura `ANYONE` para `ServiciosCatalogo` y `ComplementosCatalogo`. Sin embargo, el diccionario CMS y la auditoría de catálogo del 25-10-2026 informan permisos de colección `ADMIN` en lectura/escritura para ambas colecciones. Por tanto, **la exposición actual no queda confirmada por la evidencia más reciente**. Sigue pendiente comprobar lectura anónima directa, datasets, páginas dinámicas y widgets en el sitio publicado/QA. No cambiar permisos a ciegas: conservar las colecciones maestras privadas, mantener DTOs con allowlist y cerrar el issue solo tras verificar el acceso efectivo.

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


## Aclaración operativa del propietario — 2026-10-26

El propietario confirma que `https://www.marianmadrid.es/` es el sitio designado por él como **QA publicado**, creado para probar el sistema antes de preparar el sitio web definitivo, y que no tiene actividad comercial real. A efectos de este proyecto, se autoriza la simulación de uso real en ese sitio, con datos sintéticos y trazabilidad.

Esta aclaración de propósito no cambia los hechos técnicos observados: Wix lo identifica como publicado y con dominio propio; la cuenta conectada no expone otro sitio QA separado. El riesgo de que la web sea accesible públicamente sigue existiendo aunque el propietario indique que no tiene actividad real. Por ello, las pruebas deben cumplir estas condiciones:

- Usar exclusivamente datos ficticios; no utilizar datos de clientes reales.
- Desactivar avisos a participantes y recordatorios; no enviar mensajes externos.
- No ejecutar cobros, reembolsos, emisión de facturas fiscales ni integraciones bancarias reales.
- Las reservas de prueba deben llevar etiquetas y trazabilidad inequívocas de QA, y limpiarse antes de convertir el sitio en definitivo.
- Para caja, inventario, fichajes y cierres fiscales, registrar escenarios en una colección de auditoría QA dedicada, no alterar saldos contables reales ni producir documentos fiscales.
- La colección `SimulacionPreDespliegue` fue reportada por el propietario como eliminada el 2026-10-26. No asumir que existe ni volver a escribir en ella; resolver el esquema vivo y usar/crear una colección de auditoría QA dedicada tras comprobar el contrato de CMS.
- Una reserva real de Wix Bookings y un registro en CMS son escrituras persistentes; verificar sus IDs, estados, trazas y compensación/limpieza. No llamar “simulación completa” a una ejecución parcial ni dar por probado el flujo Cart V2/pago sin evidencia específica.

La validación real autorizada aquí es QA del propietario, no producción comercial. Mantener separadas las evidencias de pruebas automatizadas, simulaciones offline y operaciones persistentes realizadas en Wix.


## Actualización verificada — 2026-10-28

Este apartado complementa el corte anterior; no convierte la migración en certificada ni sustituye las validaciones pendientes.

### Corte de código
- Rama observada: `main`.
- Commit observado: `3880802ef3067a46eda6310036bb15b35cde7519` (merge del PR #244, `hotfix/lazy-sdk-proxy-elevation`).
- Rama de trabajo para esta revisión: `migration/layer1-complete-2026-10-28`.
- `src/backend/dataAccess.js` importa `@wix/data` y `@wix/essentials`; su contrato de prueba exige elevación diferida mediante una función callable.
- `src/backend/dataLegacyAdapter.js` no existe en el árbol observado. La prueba `unit.ssot.v5011.test.mjs` exige que siga retirado.
- La búsqueda de código indexada para `wix-members-backend`, `wix-ecom-backend`, `wix-bookings.v2` y `wix-secrets-backend` devolvió referencias en documentación, pero no devolvió módulos de producción en los resultados consultados. Esto es evidencia de búsqueda, no una garantía equivalente a ejecutar un análisis local exhaustivo.
- La búsqueda de `dataLegacyAdapter` encontró menciones residuales en comentarios y en el cargador de pruebas; deben distinguirse de imports activos y no justifican restaurar el adaptador.

### Ajustes de esta rama
- Los encabezados de los nueve módulos principales de Capa 1 (`dataAccess.js`, `internalConfig.js`, `validation.js`, `staff.js`, `bookingUtils.js`, `bookingCore.js`, `bookingSaga.js`, `reservas.web.js` y `citasManager.web.js`) se han reducido a responsabilidad, imports estáticos detectados, exports detectados y una nota que remite el historial real a Git. No se ha alterado el cuerpo funcional de esos módulos en este cambio.
- `run-layer1.mjs` incorpora `dataAccess.wixdata-query.test.mjs` y `sdk.lazy-elevation.contract.test.mjs`, para que los contratos del acceso CMS y de elevación diferida formen parte de la puerta de Capa 1.

### Pendiente de evidencia
- Ejecutar y revisar `npm ci`, `npm run lint`, `npm run test:layer1`, `npm run test:layer2` y `npm test` en CI o entorno reproducible.
- Revisar el resultado de CI asociado a esta rama/PR; no se declara ningún test aprobado hasta observar sus resultados.
- Verificar en el sitio Wix de QA los flujos de reserva simple/dual, checkout/pago de prueba, compensación, permisos y sincronización. La revisión de archivos y las pruebas offline no demuestran el comportamiento real de Wix.
- No se ha publicado ningún cambio en Wix ni en el sitio web desde esta actualización de repositorio.


## Actualización de seguimiento — 2026-10-28, después del PR #245

- El PR #245 se fusionó en `main` como commit `c36045fa4bf43f2107700cdc3c6019e81c841971`.
- En ese PR se actualizaron los encabezados contractuales de los nueve módulos principales de Capa 1, se incorporaron dos suites al gate `test:layer1` y se corrigieron aserciones obsoletas de los contratos CMS/widget.
- Para el head del PR #245, CI confirmó éxito en Layer 1, Layer 2, booking regression, backend security/regression, lint/full test y quality diagnostics. El resumen inicial de la suite completa fue 335 aprobados/5 fallidos; después de corregir los contratos obsoletos, el workflow completo terminó en `success`.
- El workflow de Wix CLI Preview falló en dos intentos con `PUBLISH_PIPELINE_TASK_NOT_FOUND` (“PublishPipelineTask not found for given deployment id”), después de autenticar e instalar correctamente la CLI. Esto impide afirmar que Preview se haya validado; no demuestra por sí solo un fallo de código. No se publicó nada en Wix.
- La rama `cleanup/layer1-dependency-history-2026-10-28` continúa la limpieza documental de dependencias de Capa 1 y elimina referencias comentadas al adaptador retirado. Estos cambios siguen pendientes de su propio CI/PR.


## Fase siguiente — retirada del query builder propio (integrada en main)

PR #247 y PR #248 fusionados en `main` el 2026-10-28. Commit actual de integración: `6927fe636e292b19014622903e9ca72459f00f2d`.

### Cambios funcionales propuestos
- Migrados los consumidores de `query as dalQuery` a `queryItems({ dataCollectionId, filter, sort, limit, offset, consistency })` y filtros `wql.*`: `staff.js`, `security.js`, `bookingCore.js`, `bookingSaga.js`, `reservas.web.js`, `events.js`, `eventLog.js`, `crons.js`, `horario.web.js`, `cajas.web.js`, `inventario.web.js`, `fiscalDocuments.web.js` y `fiscalAggregator.web.js`.
- Retirados de `dataAccess.js` la clase `QueryBuilder` y la exportación `query()`. La API de consultas queda basada en objetos y operaciones nombradas.
- Reescrita la prueba de contrato de acceso CMS para comprobar consultas simples, compuestas, rangos, lecturas consistentes y ausencia de la API de compatibilidad.
- Actualizada la paginación consumidora al contrato real de `queryItems`: `hasNext` booleano y `next` función o `null`.
- `inventario.web.js` declara expresamente la búsqueda por prefijo de `productName`: el filtro SDK v2 no ofrece un operador genérico de subcadena y el builder anterior ya degradaba texto a prefijo.

### Estado verificado
- PR #247 introdujo la retirada del query builder; la primera ejecución de CI detectó una regresión en la paginación de carga de reservas y cuatro aserciones de pruebas ligadas a la API anterior.
- PR #248 corrigió la paginación y actualizó esas aserciones. En el head validado de PR #248 terminaron en `success`: Layer 1, Layer 2, booking regression, backend security/regression, Validate (lint y pruebas completas) y Quality diagnostics.
- Wix CLI Preview sigue fallando con `PUBLISH_PIPELINE_TASK_NOT_FOUND` antes de completar la vista previa. El mismo fallo se ha observado en PR #245, #246 y #248. No se ha publicado nada en Wix; la validación real de la plataforma sigue pendiente.


## Confirmación de cierre de la migración DAL — 2026-10-28

- La rama `main` ya no exporta `query()` ni contiene la clase `QueryBuilder` en `src/backend/dataAccess.js`.
- Los 13 módulos consumidores que importaban `query as dalQuery` fueron migrados a `queryItems` y filtros `wql` explícitos; se verificó por búsqueda de código en la rama de trabajo y el CI de PR #248.
- La paginación se normalizó al contrato `hasNext: boolean`, `next: function|null`. El bug de uso de `hasNext()` quedó corregido antes de cerrar PR #248.
- La prueba `dataAccess.wixdata-query.test.mjs` comprueba que el export legacy `query` ya no existe y cubre filtros simples, compuestos, rango y lectura consistente.
- **Cierre de código: aprobado por CI offline. Cierre de producción Wix: no aprobado**, hasta resolver el error de Preview y probar el flujo real de reservas simples/duales, caja/fiscalidad y permisos en un entorno Wix de QA.
