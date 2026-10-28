# Cierre de prioridades técnicas — 2026-10-23

## Estado final tras sincronización y publicación confirmadas

El usuario confirma que el repositorio y Wix Editor están sincronizados y publicados con el commit `4b6c46d68b900a73431b2ada098736877be3c018`. Se verificó que este SHA es `main` y que los cuatro checks asociados están completados con resultado `success`: validación, Booking/shared-core, caja/fiscal y regresión backend/E2E. La batería backend/E2E reportó 240/240 pruebas superadas. No se escribieron operaciones ficticias en ledgers productivos.

**Cierre del ciclo de despliegue:** completado. **Cierre de todas las obligaciones contables y de seguridad:** no completado; los dos riesgos restantes se dejan registrados con acciones explícitas.

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

La ejecución aislada de `npm audit fix --ignore-scripts` no encontró una solución completa compatible; la rama de auditoría no presenta diferencias de versión respecto a `main`. No se ha aplicado `--force` ni se han alterado versiones Wix a ciegas. La deuda de vulnerabilidades queda abierta hasta identificar qué paquetes pueden actualizarse sin romper la compatibilidad de Wix CLI/SDK y superar las pruebas completas. Se registra como seguimiento separado en GitHub; no se aplica `--force` ni se declara saneado el árbol.

## Límites de validación

- Las escrituras reales realizadas en Wix se limitaron a esquema y las tres filas de configuración de personal.
- No se escribieron ventas, devoluciones, reservas ni movimientos ficticios en los ledgers productivos.
- El commit integrado en `main` y publicado en Wix está confirmado por el usuario; los cuatro checks de ese SHA están verdes.
- La contabilidad PGC no se declarará cerrada hasta aprobar la matriz y probar asientos balanceados por tipo de operación.

## Actualización posterior — 2026-10-25

Este documento conserva el estado y las decisiones del corte del 23-10-2026. Después de ese corte, PR #166 integró en `main` la alineación de `MapaStaff`, los enums de `CitasF2` y la documentación asociada. La alineación del repositorio no implica que se haya publicado una nueva versión del sitio Wix; esta actualización no confirma publicación ni modificación adicional del CMS. La retirada física de campos históricos sigue pendiente de una migración verificada.
