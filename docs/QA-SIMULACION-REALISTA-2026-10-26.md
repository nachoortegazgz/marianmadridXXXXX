# Plan de simulación realista del sitio Marian Madrid — 2026-10-26

## Objetivo
Ejecutar pruebas E2E persistentes sobre el sitio que el propietario designa como QA: https://www.marianmadrid.es/. El sitio está publicado, pero el propietario confirma que no tiene actividad comercial real y autoriza datos sintéticos.

## Estado previo confirmado
- Wix Site ID: `188bed94-177c-4bc9-a9f0-35080d874f3e`.
- Wix Editor clásico con Velo; Wix Bookings instalado.
- Wix Stores Catalog V1 e Invoices V1; no migrar a V3/V2 dentro de esta campaña.
- CMS de negocio existente: `CitasF2`, `CajaActual`, `MovimientosCaja`, `HistoricoCierresZ`, `LibroAsientosContablesDetalle`, `MovimientosInventario`, `RegistrosHorariosStaff`, `MapaStaff`, `ServiciosCatalogo`, `ComplementosCatalogo`.
- El propietario informa que `SimulacionPreDespliegue` está eliminada. No usar esa colección.
- Los permisos observados en el CMS no sustituyen la comprobación de acceso anónimo desde la web.

## Reglas de seguridad
1. Contactos sintéticos con dominio `.invalid`; nada de PII real.
2. Reservas: no notificar a participantes, no enviar SMS, no iniciar pagos; etiquetar como `QA_TEST` y guardar `traceId`.
3. No generar facturas fiscales ni invocar proveedores de pago, email, SMS o bancos.
4. No escribir valores de saldo/cierre en colecciones contables de producción; usar un registro de auditoría QA independiente para los escenarios de caja, stock, fichajes y cierres.
5. Antes de crear la colección de auditoría, leer el esquema y permisos CMS vivos; no reutilizar nombres de colecciones borradas sin verificación.
6. Cada escritura debe tener clave de idempotencia, ID devuelto y lectura de verificación. Si no puede garantizarse la compensación, parar antes de mutar.
7. Antes de publicar el sitio definitivo, eliminar/cancelar todas las reservas QA, borrar registros sintéticos de auditoría y repetir un barrido para verificar limpieza.

## Escenarios mínimos
| ID | Área | Prueba | Evidencia exigida |
|---|---|---|---|
| BK-01 | Agenda | Reserva nativa simple en slot real disponible | Booking ID, servicio, `resourceId`, horario, estado y lectura posterior |
| BK-02 | Agenda | Reserva dual F1+F2 mediante motor del repositorio | IDs de fases, separación por exposición, rollback si falla F2 |
| BK-03 | Agenda | Colisión/revalidación de slot | Una sola reserva aceptada y error controlado en la segunda |
| BK-04 | Agenda | Contacto sintético, notificaciones desactivadas | Confirmación de que no hubo envío externo |
| CMS-01 | CMS | Lectura/escritura de registro QA y lectura posterior | ID, revisión y `traceId` |
| CMS-02 | Seguridad | Acceso anónimo a colecciones privadas y proyecciones públicas | Denegación de privadas y funcionamiento de páginas públicas |
| PAY-01 | Checkout | Verificar construcción del Cart V2 sin pagar | Cart/checkout ID si el endpoint lo permite, sin captura ni orden pagada |
| PAY-02 | Pagos | Simular fallido/pendiente con fixture o sandbox | No marcar cita como pagada/confirmada indebidamente |
| CASH-01 | Caja | Simular entrada/salida, regalo y devolución | Solo fixture/auditoría QA; no saldo contable real ni factura fiscal |
| INV-01 | Inventario | Venta/ajuste y compensación | Stock de prueba aislado y trazabilidad |
| STAFF-01 | Personal | Horario y recurso | `resourceId` no confundido con `staffMemberId`, `eventsScheduleId` o `serviceId` |
| FISC-01 | Fiscal | Tipos F2/F1/R1 y cierre Z como reglas/fixtures | Sin emitir documento fiscal ni cierre contable real |
| CLEAN-01 | Limpieza | Cancelar/borrar todos los artefactos QA creados | Inventario final en cero y evidencia de limpieza |

## Criterios de aprobación
- Todos los escenarios llevan resultado PASS/FAIL/BLOCKED, `traceId`, fecha, versión de código y evidencia de lectura posterior.
- No se considera real E2E lo que solo ejecuta mocks.
- No se considera pagado un carrito/checkout sin confirmación de pago real del sandbox.
- No cerrar la campaña si hay un escenario P0 de seguridad bloqueado, fallos de sincronización de reservas o artefactos QA sin limpiar.
- No publicar sobre el sitio definitivo hasta revisión de resultados y plan de rollback.

## Límite de esta campaña
Las pruebas reales requieren ejecutar cada flujo a través de los endpoints/UI que realmente usa la web y confirmar persistencia en Wix. Las llamadas administrativas directas a APIs de Bookings solo prueban el API nativo y no sustituyen una prueba del frontend Velo ni del flujo Cart V2. No se debe afirmar que la campaña completa ha pasado hasta que cada escenario tenga evidencia.


## Resultados de ejecución real en Wix — 2026-10-26

### Entorno y artefactos
- Sitio designado como QA por el propietario: `https://www.marianmadrid.es/` (publicado; sin actividad comercial real declarada por el propietario).
- Colección `SimulacionPreDespliegue`: no existe; el propietario confirmó que fue eliminada.
- Colección nueva de auditoría `QAE2ESimulaciones`: creada y verificada con `insert/update/remove/read = ADMIN`.

### Resultados observados
| ID | Resultado | Evidencia |
|---|---|---|
| CMS-01 | PASS | Se creó y leyó la colección privada de auditoría y se escribieron registros con `traceId` e IDs de Wix. |
| STAFF-01 | PASS parcial | Servicio `Corte Clásico` y recurso disponible de Andrea resueltos; `resourceId` (`07f7344f-e7e4-4c53-854b-47fd82ac8d40`) se mantuvo separado del `staffMemberId` y del `scheduleId`. |
| BK-01 | PASS — API nativa | Reserva confirmada `2a8f441d-0942-4904-b218-7fb5feaa80d1`; 27-10-2026, 09:00–09:30 `Europe/Madrid`; servicio `Corte Clásico`; recurso `ANDREA STAFF`; contacto sintético `qa-booking-20261026@example.invalid`; `selectedPaymentOption=OFFLINE`; `paymentStatus=UNDEFINED`; avisos y SMS desactivados. La lectura posterior por Bookings Reader V2 confirma la reserva. |
| BK-02 | PASS parcial | Tras la reserva, el slot 09:00–09:30 dejó de aparecer en la lista de disponibilidad. No se intentó crear una segunda reserva duplicada. |
| CMS-BOOKING-PROJECTION | BLOCKED / investigar | La reserva nativa existe, pero no apareció su fila correspondiente en `CitasF2` al consultar el CMS. El repositorio contiene un handler `wixBookingsV2_onBookingConfirmed` que debería proyectar reservas nativas. No insertar manualmente la fila para no ocultar un posible problema de evento/despliegue; verificar que el handler está desplegado y recibe el webhook. |
| PAY-01 / PAY-02 | NOT RUN | No se creó carrito/checkout ni se probó el sandbox de pagos. No se hizo ningún cobro. |
| CASH-01 / INV-01 / FISC-01 | NOT RUN | No se alteraron caja, inventario, fichajes ni cierres contables y no se emitió documento fiscal. Esos flujos deben probarse mediante sus handlers de QA o fixtures aislados; no se consideran aprobados por tener un registro de auditoría. |
| CMS-02 | NOT RUN | La colección de auditoría es privada por permisos CMS, pero falta probar desde un contexto anónimo real el acceso a colecciones privadas y proyecciones públicas. |
| FRONTEND-E2E / DUAL-BOOKING / CART-V2 | NOT RUN | La reserva se creó mediante la API administrativa nativa de Wix, no a través del frontend Velo. No demuestra el flujo de reserva dual del repositorio ni Cart V2. |

### IDs y trazabilidad
- Reserva nativa: `2a8f441d-0942-4904-b218-7fb5feaa80d1`.
- Trace principal: `QA_E2E_BOOKING_20261026_CORTESIMPL_ANDREA_0900`.
- Colección de auditoría: `QAE2ESimulaciones`.
- Registro de creación inicial: `a8e62fd5-e645-4de0-b00b-fb24d443a830`.
- Registro de verificación final: `f0e5010e-e373-4a99-ad57-26bfb415247f`.
- Registro de comprobación de slot consumido: `a1a96a5b-0dcf-490a-96bb-71eb5a79e6bb`.

### Estado de campaña
**Parcial, no completa.** Se ha probado una reserva nativa persistente y su lectura posterior, y se ha registrado la evidencia en CMS. El bloqueo principal es confirmar la proyección a `CitasF2` vía webhook y ejecutar los flujos frontend/dual/Cart V2. Caja, inventario, fiscal y acceso anónimo siguen pendientes. La reserva QA permanece en la agenda para inspección y debe cancelarse antes de convertir el sitio en definitivo.
