# CitasF2 — contrato de proyección auxiliar de reservas

## Propósito

`CitasF2` es la proyección interna auxiliar de las reservas de Wix Bookings. Sirve para conciliación interna, contexto de servicio, trazabilidad y conexión posterior con caja/fiscalidad. **No sustituye a Wix Bookings como autoridad de existencia, estado nativo ni disponibilidad de agenda.**

## Modelo canónico

| Caso | Filas en CitasF2 | `bookingType` | `pairToken` |
|---|---:|---|---|
| Reserva simple | 1 | `SIMPLE` | `null` |
| Reserva dual, fase 1 | 1 | `DUAL_F1` | Obligatorio |
| Reserva dual, fase 2 | 1 | `DUAL_F2` | El mismo token que F1 |

Una reserva dual son dos reservas nativas independientes de Wix Bookings, vinculadas en la proyección por un `pairToken` común. No se debe usar Multi-Service Booking ni representar el hueco de exposición como una cita reservada.

## Claves y trazabilidad

- `bookingId`: identificador nativo, único por fila.
- `bookingType`: clasificación canónica `SIMPLE`, `DUAL_F1` o `DUAL_F2`.
- `pairToken`: obligatorio en ambas fases duales; nulo en una simple.
- `sourceEventId`: identificador del evento nativo que originó la proyección cuando la fila se crea desde un webhook.
- `meta.projectionRole = AUXILIARY_BOOKING_LEDGER`: identifica el propósito de la proyección.
- `traceId`: trazabilidad interna obligatoria.

Los eventos nativos pueden crear una fila `SIMPLE` si todavía no existe una fila de la saga. Si la saga ya creó la fila, el webhook solo puede actualizar el estado permitido: no debe borrar ni sustituir `pairToken`, `bookingType`, importes, notas ni metadatos de la saga.

## Reglas de lectura y consistencia

1. Consultar Wix Bookings para disponibilidad y estado nativo.
2. Usar `CitasF2` como proyección auxiliar y para carga/conciliación interna.
3. Al combinar agenda nativa y proyección, deduplicar por `bookingId`; una cita no puede contabilizarse dos veces.
4. Para cálculo de carga, excluir reservas canceladas y estados que no ocupen agenda.
5. No considerar una operación dual completa hasta que F1 y F2 estén persistidas con el mismo `pairToken`; ante fallo de F2, ejecutar la compensación de la saga.
6. Procesar webhooks con idempotencia y no marcar el evento como completado antes de persistir correctamente la proyección.

## Cambios de esta revisión

- Se incorpora `sourceEventId` al mapa canónico de campos y al documento escrito por `bookingCore`.
- La proyección creada por `wixBookingsV2_onBookingConfirmed` marca en `meta` su rol auxiliar y tipo de origen.
- Las pruebas comprueban que una reserva simple conserva el evento de origen y que un webhook no degrada una fila dual creada por la saga.

## Alcance de despliegue

El cambio de código no modifica por sí mismo la definición CMS ni publica el código en Wix Editor. La colección viva `CitasF2` ya contiene los campos `bookingType`, `pairToken`, `sourceEventId`, `slotStart`, `slotEnd`, `dateYmd`, `serviceId`, `resourceId`, `scheduleId`, `meta` y `traceId`; por tanto, esta revisión no requiere añadir campos nuevos en el CMS. Tras fusionar y desplegar, hay que verificar una cita simple y las dos filas de una cita dual en el sitio publicado.
