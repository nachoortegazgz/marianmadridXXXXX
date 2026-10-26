# Auditoría del contrato de reservas Wix Bookings V2 — 2026-10-26

## Alcance

Revisión estática del flujo de reservas simple y dual en `main`, contrastada con los esquemas oficiales del JavaScript SDK `@wix/bookings`. Esta auditoría no equivale a una prueba en Wix Editor/Preview ni a una reserva real.

## Hallazgos corregidos en esta rama

### 1. Identificadores de ubicación enviados al SDK

El código construía las ubicaciones con `id` en `reservas.web.js` y `bookingCore.js`, y leía `location.id` en `bookingSaga.js`. El esquema SDK de Wix usa `_id` en los objetos `locations[]` de disponibilidad y en `bookedEntity.slot.location` de Writer V2. Usar `id` podía dejar sin aplicar el filtro de ubicación o perder la ubicación seleccionada.

Corrección: usar `_id` de forma coherente y usar `location._id` en la clave de caché y en la validación del contrato Writer V2.

### 2. Recurso y calendario de profesional en Writer V2

El slot de creación enviaba `resource: { id: resourceId }`, pese a que el esquema SDK define `resource._id` y `resource.scheduleId`. La validación interna también exigía `resource.id`, reforzando el contrato incorrecto.

Corrección: el slot Writer V2 incluye `resource: { _id: resourceId, scheduleId }`; la saga valida `resource._id`, `resource.scheduleId`, `location._id` y el `scheduleId` del slot.

### 3. Diferenciar respuestas del SDK y envelopes de webhook

No deben unificarse a ciegas los identificadores de procesos distintos. El SDK JavaScript de disponibilidad/Writer V2 y Bookings Reader V2 utiliza `_id` en los objetos de recurso/ubicación y en la reserva devuelta. En cambio, el ejemplo oficial del webhook `booking-created` presenta `createdEvent.entity.id`, `slot.resource.id` y `slot.location.id`.

Corrección: el balanceo y la reconciliación que consumen respuestas del SDK leen `_id`; el adaptador de webhooks conserva `id`, conforme al envelope oficial. Las pruebas deben modelar cada contrato por separado.

### 4. Validación nativa durante la creación de F2

F2 configuraba `skipAvailabilityValidation: true`. El bloqueo `ControlOperativo` solo coordina las solicitudes de esta aplicación; no impide reservas concurrentes realizadas desde otras superficies Wix.

Corrección: mantener `skipAvailabilityValidation: false` también en F2. La saga sigue haciendo revalidación exacta y bloqueo propio, y Wix conserva su comprobación final al crear la reserva.

### 5. Proyección de reservas simples

El contrato de `CitasF2` establece `pairToken: null` para una reserva simple, pero la saga persistía el token interno de transacción en la fila simple y en `meta.pairToken`.

Corrección: el token sigue usándose internamente para coordinar la transacción/idempotencia; solo se persiste en `CitasF2` cuando el servicio es dual. La fila `SIMPLE` queda con `pairToken: null`, conforme al contrato de proyección.

### 6. Documentación de F2 y pago

La Biblia describía `NO_FEE` y `skipSelectedPaymentOptionValidation: true` como si se enviaran al Writer V2 en F2. El código no establece `selectedPaymentOption` en el cuerpo de F2: solo registra `totalAmount: 0` y `noFee: true` en la proyección `CitasF2`.

Corrección: documentar el comportamiento real y marcar como pendiente de QA aislada el estado nativo de pago que Wix asigne a F2 y cómo lo reflejan los webhooks. No se ha inventado ni asumido un resultado real.

## Flujo lógico que debe preservar el código

- **Simple:** resolver servicio visible y datos del slot; revalidar disponibilidad; resolver un recurso y su `scheduleId`; adquirir los bloqueos; crear una reserva F1 con la validación nativa activada; persistir una fila `SIMPLE` con `pairToken: null`; si es online, generar el checkout para F1.
- **Dual:** comprobar `allowCombine` y `linkedPhases`; validar F1 y F2 y la duración de F2; exigir que el intervalo entre el fin de F1 y el inicio de F2 coincida exactamente con `exposureDuration`; resolver el mismo profesional para ambas fases; bloquear ambos intervalos; crear F1 y después F2 con validación nativa activada; compensar si falla una fase; persistir `DUAL_F1` y `DUAL_F2` con el mismo `pairToken`; imputar el importe en F1 y mantener F2 como fase interna sin tarifa propia en `CitasF2`.
- **Comunicación:** los errores de contexto/disponibilidad deben volver al widget con código y mensaje; disponibilidad puede reintentarse con límites; la mutación de reserva no debe repetirse a ciegas si el resultado es incierto.

## Referencias oficiales contrastadas

- [Bookings Writer V2 — Create Booking](https://dev.wix.com/docs/api-reference/business-solutions/bookings/bookings/bookings-writer-v2/create-booking)
- [Time Slots V2 — List Availability Time Slots](https://dev.wix.com/docs/api-reference/business-solutions/bookings/time-slots/time-slots-v2/list-availability-time-slots)

La diferencia entre `id` y `_id` aquí es la forma del **JavaScript SDK** utilizado por el repositorio. No debe inferirse la forma del SDK a partir de ejemplos de la API REST sin comprobar el esquema específico de la llamada.

## Validación pendiente

1. Ejecutar todos los workflows CI de la rama y corregir cualquier regresión.
2. Resolver el fallo conocido de Wix CLI Preview `PUBLISH_PIPELINE_TASK_NOT_FOUND`.
3. En Wix Preview/QA, verificar sin pagos reales: carga de servicio, disponibilidad en la ubicación correcta, asignación de profesional, creación simple, creación dual con gap exacto, compensación si F2 falla y proyección de webhooks.
4. Verificar explícitamente el estado nativo de pago de F2. No desplegar esta rama a producción hasta completar estos pasos.
