# Continuidad de sesión — capa 2 y trazabilidad
**Fecha:** 2026-10-23  
**Estado:** hito de auditoría parcial; NO declarar el sistema fiscalmente certificado ni la sincronización live verificada.

## Estado del repositorio
- Repositorio canónico: https://github.com/nachoortegazgz/marianmadridXXXXX
- HEAD de `main` al crear esta nota: `5884ecc6f16c352d6823e1d37cb7925b3d34f401`.
- PR #77 (idempotencia y trazabilidad del webhook de reservas): integrado en main.
- PR #78 (esquema de cierre Z): integrado en main aunque CI quedó rojo. No asumir que la integración equivale a validación.
- Sitio Wix: el usuario afirma que Editor y repositorio están sincronizados y publicados. El contexto Wix confirmó estado Published, pero no se ha demostrado igualdad exacta de bytes entre el HEAD de GitHub y el runtime publicado.

## Cambios de capa 2 preparados en PR #78
- `HistoricoCierresZ`: añade al writer `closeDate`, `operationDate` como Date, `fiscalPeriod`, `closedBy`, `recordDomain`, `totalTaxBase`, `totalTaxAmount` y `snapshotJSON`.
- Cierre manual: resuelve staff a partir del miembro autenticado; falla cerrado si no puede resolverlo.
- Cron: actor `SYSTEM_CRON`, dominio `SYSTEM`.
- Añade `cajas.z-close-schema.test.mjs` a la gate de capa 2.
- En la ejecución de CI, el test nuevo de contrato pasó (3/3).

## Bloqueante encontrado al cerrar sesión
PR #78 quedó integrado pese a CI fallido. Fallo reproducible:
- Suite: `src/backend/tests/site.flows.e2e.test.mjs`
- Caso: `FLOW-CAJA-01`, línea aproximada 298; aserción alrededor de línea 336.
- La venta en efectivo incrementa `netAmount=50`, `cashAmount=50`, `salesCount=1`, pero `totalOperations` queda en 0; la prueba espera que las operaciones estén contabilizadas.
- Log asociado: `Ledger idempotent duplicate detected` para `transactionId=e2e-tx-0001`.
- Resultado visto: layer 2 82 pass / 1 fail; suite canónica 229 pass / 1 fail. Otros gates de CI también fallaron por el mismo FLOW-CAJA-01.
- No arreglarlo relajando la aserción sin investigar. Revisar el flujo de claim idempotente, el fixture/harness, la persistencia del movimiento y el incremento de `totalOperations`. Determinar si el código descarta erróneamente la primera transacción como duplicada o si el test reutiliza una clave.
- Revisar también el error registrado `registrarFichaje failed` en la misma suite para decidir si es ruido de un test negativo esperado o un fallo adicional oculto.

## Reservas: estado de validación
- Las pruebas automatizadas `events.native-booking-sync.test.mjs` pasan 7/7 en el CI consultado.
- Las pruebas `reservas.web.test.mjs` pasan 70/70.
- **No se ejecutó una reserva real simple ni dual en el sitio publicado.** No afirmar validación end-to-end de Wix Bookings. Antes de cualquier prueba real, acordar ventana y datos de prueba; evitar tocar la reserva sintética existente:
  - ID `cdd8ad7c-c774-4999-8554-dfff025cd6ca`
  - Corte Clásico, 27-10-2026, 11:00–11:30 Europe/Madrid
  - Contacto QA `PRUEBA QA NO CLIENTE 01 - NO ATENDER`
- No se han creado ni modificado reservas reales ni registros CMS durante estos cambios.

## Orden recomendado para la próxima sesión
1. **P0 — detener integración de cambios funcionales hasta reparar FLOW-CAJA-01.** Descargar logs completos, inspeccionar `cajas.web.js`, ledger/claim idempotente y fixtures; añadir prueba específica de primera escritura + replay + contador.
2. Reejecutar gates completos; exigir verde antes de nuevos merges.
3. Revisar `HistoricoCierresZ_beforeInsert` y el esquema CMS vivo para verificar que el writer satisface todos los obligatorios; comprobar que `snapshotJSON` no excede el límite de campo y que los hashes son verificables.
4. Inspeccionar todas las rutas de caja, fichaje, reservas y webhooks para comprobar `traceId`, actor, resultado, errores y marcador persistido en colecciones canónicas; diferenciar auditoría operativa de cumplimiento legal.
5. Solo con gates verdes, diseñar y ejecutar una prueba controlada de reserva simple y otra dual en producción, con consentimiento explícito para crear/cancelar las reservas de prueba. Verificar evento nativo, `CitasF2`, `ControlOperativo`, idempotencia, compensación dual y notificaciones.
6. Verificar publicación/sincronización efectiva de Wix por una comprobación independiente; no inferirla de la fecha de publicación.
7. Mantener intacta la reserva sintética indicada arriba salvo autorización explícita.

## Criterio de cierre del hito
No cerrar la capa 2 hasta tener: CI verde, cierre Z probado contra CMS real, trazabilidad de cada proceso crítico, verificación de runtime publicado, y pruebas simples/duales documentadas. Esto no constituye por sí solo certificación de cumplimiento legal; el encaje normativo debe revisarse con el asesor fiscal/Veri*Factu correspondiente.
