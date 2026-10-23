# Plantilla de aprobación de matriz contable PGC

**Estado:** pendiente de cumplimentar y aprobar por la asesoría.  
**Importante:** este documento no asigna cuentas ni constituye asesoramiento contable. No activar asientos automáticos hasta recibir aprobación escrita y convertir la matriz aprobada en reglas y pruebas.

## 1. Datos de aprobación

| Campo | Valor a completar |
|---|---|
| Empresa / titular fiscal | [PENDIENTE] |
| NIF y régimen fiscal aplicable | [PENDIENTE POR ASESORÍA] |
| Asesoría / profesional responsable | [PENDIENTE] |
| Versión de matriz | [PENDIENTE] |
| Fecha de aprobación | [PENDIENTE] |
| Documento de aprobación firmado o correo conservado | [PENDIENTE] |

## 2. Matriz por operación

La asesoría debe especificar **todas las líneas del asiento** por cada operación, no solo una cuenta de caja. Repetir las filas de línea cuando una operación necesite más de dos apuntes. Indicar si el tratamiento depende del medio de cobro, momento de devengo, tipo de cliente o documento fiscal.

| ID | Operación | Nº línea | Cuenta PGC debe | Cuenta PGC haber | Base/importe de cálculo | Tratamiento IVA | Momento de reconocimiento | Documento origen | Contrapartida/reversión | Aprobación |
|---|---|---:|---|---|---|---|---|---|---|---|
| PGC-01 | Venta de servicio prestado | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Ticket/factura aplicable | [PENDIENTE] | [ ] |
| PGC-02 | Venta de producto | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Pedido/ticket/factura | [PENDIENTE] | [ ] |
| PGC-03 | Cobro en efectivo | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | No inferir IVA por el cobro | [PENDIENTE] | Movimiento de caja + documento origen | [PENDIENTE] | [ ] |
| PGC-04 | Cobro con tarjeta / proveedor de pago | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | No inferir IVA por el cobro | [PENDIENTE] | Pago confirmado + liquidación | Comisiones y liquidación: [PENDIENTE] | [ ] |
| PGC-05 | Devolución de venta / reembolso | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Rectificación aplicable: [PENDIENTE] | [PENDIENTE] | Devolución enlazada al origen | Reversión y documento rectificativo: [PENDIENTE] | [ ] |
| PGC-06 | Anticipo de cliente | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Devengo/IVA del anticipo: [PENDIENTE] | [PENDIENTE] | Recibo/factura de anticipo aplicable | Aplicación posterior: [PENDIENTE] | [ ] |
| PGC-07 | Venta de tarjeta regalo | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Tratamiento según tipo de vale: [PENDIENTE] | [PENDIENTE] | Venta + saldo emitido | Vencimiento/devolución: [PENDIENTE] | [ ] |
| PGC-08 | Canje de tarjeta regalo | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Tratamiento en canje: [PENDIENTE] | [PENDIENTE] | Canje enlazado al saldo original | Evitar duplicar ingreso: [PENDIENTE] | [ ] |
| PGC-09 | Comisión o ajuste de liquidación | [ ] | [PENDIENTE] | [PENDIENTE] | [PENDIENTE] | Tratamiento del gasto: [PENDIENTE] | [PENDIENTE] | Extracto de liquidación | Diferencias pendientes: [PENDIENTE] | [ ] |

## 3. Reglas de integridad que debe validar la implementación

- Cada asiento debe tener identificador estable de origen, traceId y clave de idempotencia.
- La suma del debe debe ser exactamente igual a la suma del haber, usando la precisión monetaria definida por la asesoría.
- Cada línea debe utilizar una cuenta aprobada para ese tipo de operación y régimen fiscal.
- La entrega duplicada de un mismo evento no debe duplicar el asiento.
- Las anulaciones y devoluciones deben enlazar al asiento y documento de origen; no editar ni borrar registros contables históricos.
- Si falta una cuenta, una regla fiscal o el documento requerido, la operación permanece en conciliación y no genera un asiento parcial.
- Deben existir pruebas por operación, repetición del evento, devolución, fallo parcial y conciliación.

## 4. Condiciones para habilitar producción

- [ ] Asesoría cumplimenta todas las líneas y reglas de cálculo.
- [ ] Aprobación escrita conservada junto a esta versión de la matriz.
- [ ] Implementación revisada contra la matriz aprobada, sin cuentas por defecto ni inferencias.
- [ ] Tests automatizados prueban equilibrio debe/haber e idempotencia por operación.
- [ ] Las tareas pendientes de conciliación existentes tienen un plan de resolución aprobado.
- [ ] Validación controlada en entorno QA separado, sin modificar libros ni movimientos de clientes reales.

**Hasta cumplir estos puntos, mantener el bloqueo PGC_MAPPING_NOT_APPROVED y las tareas en conciliación. No activar asientos automáticos basándose en los ejemplos de esta plantilla.**
