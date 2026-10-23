# Cierre de prioridades técnicas — 2026-10-23

## Estado de esta intervención

### 1. Contabilidad PGC: bloqueada de forma segura

La proyección anterior no podía certificarse como partida doble: producía una única línea con debe y haber iguales en una misma cuenta. El backend deja ahora de escribir esa proyección y genera una tarea idempotente en `ControlOperativo` (`controlType=RECONCILIATION`, `kind=ACCOUNTING_PGC`, `reason=PGC_MAPPING_NOT_APPROVED`) vinculada al movimiento de caja, hash y traceId.

**No equivale a certificar la contabilidad.** Sigue pendiente aprobar con la asesoría la matriz de cuentas y contrapartidas por tipo de operación (venta de servicio/producto, IVA, cobro, devolución, anticipo y tarjeta regalo). Hasta entonces, la salida contable se mantiene en conciliación y no se crean asientos engañosos.

### 2. MapaStaff: esquema y datos canónicos verificados

Se inspeccionaron en vivo las tres filas de `MapaStaff` y se cotejaron `resourceId`, `staffMemberId`, `scheduleId` y contacto contra Wix Bookings; los tres contactos también se resolvieron mediante Contacts y Members. Se añadieron los campos `memberId`, `rolBookings`, `rolWebsite`, `staffName`, `thirdPartyId`, `scheduleId` y `staffMemberId`, y se completaron las tres filas existentes.

Los roles de negocio siguen la Biblia SSOT: Marian = `ADMIN`; Andrea y Alba = `ESTILISTA`. `thirdPartyId` permanece vacío porque no se ha formalizado el vínculo con `DatosFiscales`. Se conservan por ahora `wixStaffMemberId`, `active` y `sortOrder` como columnas de transición para no romper la versión publicada anterior. No deben retirarse hasta publicar y validar la nueva versión.

El código de la rama hace que `staff.js` obtenga `rolWebsite`, `memberId`, `staffMemberId` y `scheduleId` desde `MapaStaff`; si falta la fila o el rol canónico, la autorización falla cerrada.

### 3. Importe de reservas nativas: conciliación explícita

Cuando el webhook nativo de Wix Bookings no proporciona un importe fiable, se conserva la marca `amountReconciliationRequired` y se añade una tarea idempotente `RECONCILIATION/BOOKING_AMOUNT` con el `bookingId`, `serviceId`, evento origen y causa. No se inventa precio ni se convierte el cero técnico en un importe comercial real.

### 4. Dependencias

La ejecución aislada de `npm audit fix --ignore-scripts` no encontró una solución completa compatible; la rama de auditoría no presenta diferencias de versión respecto a `main`. No se ha aplicado `--force` ni se han alterado versiones Wix a ciegas. La deuda de vulnerabilidades queda abierta hasta identificar qué paquetes pueden actualizarse sin romper la compatibilidad de Wix CLI/SDK y superar las pruebas completas.

## Límites de validación

- Las escrituras reales realizadas en Wix se limitaron a esquema y las tres filas de configuración de personal.
- No se escribieron ventas, devoluciones, reservas ni movimientos ficticios en los ledgers productivos.
- Los cambios de código siguen sujetos a CI y a la sincronización/publicación en Wix Editor después de integrar la rama.
- La contabilidad PGC no se declarará cerrada hasta aprobar la matriz y probar asientos balanceados por tipo de operación.
