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

## Pendientes y límites que siguen abiertos

- **Resuelto en esta revisión documental:** los checklists de la Biblia que negaban la existencia de `MapaStaff.active` y cuestionaban `staffMemberId` como clave canónica se han corregido. La colección tiene 19 campos en el esquema vivo; el runtime exige `active === true` y no usa `wixStaffMemberId` como fallback.
- **Wix Stores Catalog V3 sigue pendiente:** la Biblia ya no marca esa migración como completada. Hace falta ADR, implementación, pruebas y verificación del runtime antes de declararla finalizada.
- `assertCitasF2` está exportado pero, según el contrato comentado en `src/backend/validation.js`, no está conectado a hooks CMS de `CitasF2`. No afirmar cobertura del 100 % de escrituras hasta validar todas las rutas de persistencia.
- La retirada física de `wixStaffMemberId`, `sortOrder`, `sourceSystem` o `schemaVersion` requiere una migración verificada; esta revisión no borra campos ni datos del CMS.

## Validación y límites

La comprobación del esquema fue de solo lectura. No se escribieron reservas, ventas, devoluciones, movimientos de caja ni datos personales. La alineación documental/runtime de PR #166 ya está integrada en `main` (merge commit `f6557f6a5506a9fc3a39af4fa8adbbe9891db589`). La consulta disponible no devolvió ejecuciones de workflow asociadas a ese merge, por lo que este informe no certifica CI. No se ha confirmado una publicación de Wix como parte de esta intervención.
