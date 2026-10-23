# Simulación integral del ecosistema — QA aislada

Fecha: 2026-10-23  
Entorno: fixtures sintéticos/offline; **no producción Wix**.  
Propósito: documentar los recorridos críticos, el rastro esperado en cada sistema y los criterios de aceptación antes de autorizar pruebas de escritura contra un entorno QA aislado.

## Regla de seguridad

Ningún escenario de este paquete crea reservas, cobros, facturas, fichajes, movimientos de caja, movimientos de inventario ni cierres en el CMS productivo. Los registros del fixture son datos sintéticos y no acreditan que una operación haya ocurrido. No deben enviarse a AEAT, clientes, agenda real ni libros contables. Los registros fiscales/contables reales no deben borrarse para “limpiar” pruebas.

## Evidencia disponible antes de esta simulación

- El cierre técnico anterior informa 240/240 pruebas backend/E2E superadas y cuatro checks verdes en el commit publicado.
- La verificación postpublicación de solo lectura de `MapaStaff` encontró esquema canónico revision 10, tres profesionales y permisos de escritura restringidos a ADMIN.
- Las pruebas existentes son principalmente offline con mocks. No equivalen a ejecutar una compra, reserva o cobro real de extremo a extremo en Wix.
- La proyección PGC permanece bloqueada hasta aprobación de la matriz de cuentas por asesoría.
- Cuando Wix Bookings no facilita un importe fiable, el backend debe generar conciliación; no inventar el precio.
- El catálogo es Stores V1 e Invoices V1. No se deben usar endpoints V3/V2 para esas aplicaciones.

## Escenarios sintéticos y recorrido de datos

El fixture `ecosystem-workflow-simulation.fixture.json` especifica 12 escenarios con `scenarioId`, `traceId`, datos ficticios, pasos, colecciones esperadas, invariantes y resultado esperado.

| ID | Flujo | Resultado esperado | Barrera principal |
|---|---|---|---|
| BK-01 | Reserva simple | Reserva nativa creada y confirmación coherente | Disponibilidad revalidada y precio nativo |
| BK-02 | Servicio de dos fases | F1 y F2 con exposición y sin colisión | Lock/idempotencia y rollback |
| BK-03 | Falla al crear F2 | No dejar una reserva parcial huérfana | Compensación verificable |
| PAY-01 | Checkout pendiente → pago confirmado | Confirmación solo tras evento fiable | Webhook idempotente; no confiar en frontend |
| PAY-02 | Pago confirmado, reserva fallida | Tarea de conciliación/compensación | No perder el pago ni inventar reserva |
| CAN-01 | Cancelación y devolución | Estado, devolución y auditoría correlacionados | No duplicar refund; política aplicable |
| POS-01 | Venta de servicio, efectivo/tarjeta | Movimiento de caja con fuente y desglose fiscal | Ticket/factura y registro fiscal según caso real |
| STO-01 | Pedido online de producto | Movimiento inventario una sola vez | Idempotencia y reconciliación con Stores V1 |
| GC-01 | Compra y canje de tarjeta regalo | Separar venta, saldo y canje | Tratamiento fiscal aprobado; no duplicar ingreso |
| CASH-01 | Cierre Z automático/manual | Snapshot, totales y hash trazables | Solo movimientos completados; cron idempotente |
| TIME-01 | Entrada/salida laboral | Registro de jornada y correcciones trazables | Identidad autenticada, integridad y acceso limitado |
| ACC-01 | Proyección contable | Mantener en conciliación hasta aprobación | No emitir asiento PGC con cuentas no aprobadas |

## Invariantes de aceptación

1. Cada intento lleva `scenarioId`, `traceId`, `sourceEventId` y clave de idempotencia sintéticos.
2. Repetir un mismo evento no duplica reserva, cobro, devolución, stock ni movimiento de caja.
3. Fallo parcial implica compensación o tarea de conciliación explícita; nunca éxito silencioso.
4. Separar reserva, checkout, pago confirmado, servicio prestado, movimiento de caja, documento fiscal y asiento contable.
5. El importe se obtiene de la fuente comercial autorizada; si falta o no es fiable, marcar conciliación pendiente.
6. El inventario disponible es coherente con stock físico menos reservas, y cada variación tiene movimiento enlazado.
7. Los cierres solo incluyen movimientos completados y guardan snapshot reproducible, rango temporal y actor.
8. Los registros laborales identifican persona, hora y origen; acceso restringido y correcciones auditables.
9. Las tareas PGC permanecen bloqueadas hasta que la asesoría apruebe cuentas y contrapartidas por operación.
10. Las pruebas automatizadas no utilizan datos personales reales ni escriben en CMS productivo.

## Límites legales

Este paquete es una prueba técnica de escenarios y controles, no una certificación de cumplimiento. La obligación fiscal concreta depende de la operación, régimen aplicable, configuración efectiva de facturación/Veri*Factu y validación profesional. La asesoría debe aprobar la matriz PGC y los tratamientos fiscales de tarjetas regalo, anticipos, devoluciones y ventas antes de activar esos flujos en producción.

## Qué falta para declarar integración real E2E

- Ejecutar los recorridos con servicios Wix reales en un sitio QA separado o con una estrategia de test explícitamente soportada por Wix.
- Comprobar agenda y CMS antes/después de cada escenario, con IDs devueltos por Wix y trazas de evento.
- Validar pagos con proveedor sandbox/test, sin cobros reales.
- Probar fallos inyectados y reintentos contra las integraciones reales.
- Ejecutar escaneo de dependencias y cerrar issue #94 con actualización compatible.
- Obtener matriz PGC aprobada y cerrar issue #93 con asientos por líneas balanceados y pruebas de idempotencia.
- Adjuntar resultados de cada ejecución y limpieza exclusiva de los datos QA creados por ese run.

## Estado honesto

Este commit añade el plan de simulación y los fixtures; **no afirma que los 12 escenarios hayan sido ejecutados contra Wix real**. Las pruebas unitarias/offline existentes y la comprobación de solo lectura en producción son evidencias separadas. No se publicará código funcional ni se tocarán datos reales como parte de este paquete documental.
