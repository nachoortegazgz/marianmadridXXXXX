# Informe de alineación CMS Keyfields y runtime — 2026-10-25

## Alcance y regla de autoridad

Repositorio: `nachoortegazgz/marianmadridXXXXX`.

Este informe distingue:
- **Esquema vivo comprobado por API Wix en esta revisión**: solo para las colecciones enumeradas en «Verificación viva».
- **Inventario documental**: el archivo `docs/CMS KEYFIELDS.md` registra 13 colecciones de negocio y sus revisiones.
- **Runtime**: las claves que el backend realmente lee y escribe; los comentarios de código no sustituyen la inspección de consumidores.

No se modificaron colecciones, filas, permisos ni publicación de Wix.

## Verificación viva

| Colección | Revisión observada | Comprobación relevante |
|---|---:|---|
| `MapaStaff` | 11 | 19 campos; 15 campos de negocio/referencia + 4 de sistema; permisos ADMIN en insert/update/remove/read. |
| `ServiciosCatalogo` | 193 | `staffMembers` es `MULTI_REFERENCE` a `MapaStaff`; clave de servicio `serviceId`; campo de visualización `slug`. |
| `CajaActual` | 45 | `openingAmount` es la clave del fondo inicial; no sustituir por `initialAmount`. |
| `HistoricoCierresZ` | 32 | `totalesMedioPago` es `OBJECT`; `estadoEnvioAEAT` es `TEXT`. |
| `LibroAsientosContablesDetalle` | 24 | `debitAmount`, `creditAmount`, `accountingAmount`, `recordHash` y `previousRecordHash` existen con sus tipos documentados. |
| `RegistrosHorariosStaff` | 9 | `resourceId`, `memberId`, `recordType`, `clockEventType`, `recordedAt` y `traceId` existen. |

El resto de las colecciones conserva en esta revisión el inventario de `docs/CMS KEYFIELDS.md`; no se declara una nueva comprobación viva para ellas en este informe.

## Correcciones documentales/runtime aplicadas en esta rama

1. `docs/BIBLIA SSOT (v10.0) — MARIANMADRID.ES.txt`: el estado CMS de cancelación se documenta como `CANCELLED`; Wix Bookings nativo usa `CANCELED` y el traductor convierte entre ambos.
2. La Biblia identifica `staffMemberId` y `active` como claves reales de `MapaStaff`. `wixStaffMemberId` queda documentado como campo duplicado histórico que el runtime no debe usar como fallback.
3. `docs/CMS_STAFF_MAP.md`: corregida la etiqueta visible de la referencia. El campo `ServiciosCatalogo.staffMembers` aparece como `miembrosPersonal` en el esquema vivo; la referencia inversa generada en `MapaStaff` es `Servicios vinculados`.
4. `src/backend/internalConfig.js`: eliminado `UPDATED` de `BOOKING_STATUS`; es un tipo de evento webhook, no un estado de reserva.
5. `src/backend/booking/bookingCore.js`: eliminado el mapeo que trataba `UPDATED` como `CONFIRMED`.
6. `src/backend/tests/booking.core.concurrency.test.mjs`: añadida regresión para confirmar que `UPDATED` no se acepta como estado de reserva.
7. `src/backend/security.web.js`: corregidos comentarios obsoletos que afirmaban que `MapaStaff` ya no existía. La fachada no consulta la colección directamente; delega en `backend/staff.js`.

## Contrato canónico de MapaStaff

Campos de runtime: `resourceId`, `staffMemberId`, `scheduleId`, `memberId`, `staffName`, `rolBookings`, `rolWebsite`, `thirdPartyId` y `active`.

- La búsqueda del mapeo se hace por `resourceId`.
- La autorización requiere `active === true` y un `rolWebsite` permitido.
- `staffMemberId` es el identificador del perfil nativo de Bookings; no es intercambiable con `resourceId`.
- `displayName` es el campo de visualización CMS, no un alias de escritura para `staffName`.
- `wixStaffMemberId` permanece físicamente en CMS, pero el runtime no debe leerlo como fallback.
- Los permisos CMS observados son ADMIN para insert/update/remove/read; no exponer estas filas a clientes anónimos.

## Estados de CitasF2

Enums canónicos en `backend/internalConfig.js`:

- `bookingStatus`: `PENDING`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `REFUNDED`, `NO_SHOW`.
- `paymentStatus`: `UNDEFINED`, `NOT_PAID`, `PENDING_PAYMENT`, `PENDING_LEDGER`, `PAID`, `PARTIALLY_PAID`, `REFUNDED`, `PARTIALLY_REFUNDED`, `EXEMPT`.

El CMS es texto y no impone estos enums en el esquema; el runtime debe validar antes de persistir. No confundir el estado CMS `CANCELLED` con el estado nativo Wix `CANCELED`. `UPDATED` describe un evento, no un estado.

## Inconsistencias que requieren cierre posterior

- Resuelto en esta revisión documental: se corrigen las afirmaciones antiguas sobre la inexistencia de `active` y el carácter no canónico de `staffMemberId`. El contrato actual está resumido en «Contrato canónico de MapaStaff» y detallado en `docs/CMS KEYFIELDS.md` / `docs/CMS_STAFF_MAP.md`.
- Resuelto en esta revisión: el checklist ya no declara completada la migración a Catalog V3. La migración sigue pendiente de ADR, implementación, pruebas y verificación del runtime/CI.
- `assertCitasF2` está exportado pero, según el contrato comentado en `src/backend/validation.js`, no está conectado a hooks CMS de `CitasF2`. No afirmar cobertura del 100 % de escrituras hasta validar todas las rutas de persistencia.
- La retirada física de `wixStaffMemberId`, `sortOrder`, `sourceSystem` o `schemaVersion` requiere una migración verificada; esta revisión no borra campos ni datos del CMS.

## Estado tras la revisión documental del 2026-10-25

- La Biblia y el diccionario tratan `docs/CMS KEYFIELDS.md` como inventario detallado de las 13 colecciones; no duplicar nuevas tablas en informes de auditoría sin indicar fecha y fuente.
- Las etiquetas visibles son texto para personas; no se les exige `camelCase`. El keyfield técnico conserva su contrato exacto.
- Los estados CMS de `CitasF2` usan `CANCELLED` (dos L), mientras Wix Bookings nativo usa `CANCELED` (una L). `UPDATED` es un evento, no un estado de reserva.
- La migración de Stores Catalog V1 a Catalog V3 continúa pendiente de ADR, implementación y pruebas; un checklist histórico no debe presentarla como completada.
- `assertCitasF2` está exportado, pero no conectado a hooks CMS `beforeInsert`/`beforeUpdate`; no declarar validación universal de todas las escrituras.

## Validación y límites

Esta intervención actualiza únicamente documentación en una rama separada. No se modifica código, esquema CMS, datos, permisos ni publicación Wix. Antes de integrar, revisar el diff documental completo y comprobar que los enums y nombres coinciden con el runtime actual.
