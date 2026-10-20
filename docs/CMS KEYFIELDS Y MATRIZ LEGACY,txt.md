# Esquema CMS actualizado y matriz de cambios
## Marian Madrid — Documento canónico de trabajo

**Estado:** propuesta consolidada para alinear CMS, backend y frontend.

> La Biblia SSOT se usa como referencia. Los keyfields persistidos del CMS se mantienen salvo eliminación explícita. Los nombres técnicos permanecen en inglés; las etiquetas visibles se diferencian por sistema de origen.

# Bloque 1 — Esquema actualizado del CMS

## Criterios canónicos

- `_id`, `_createdDate`, `_updatedDate` y `_owner` son campos nativos de Wix.
- `bookingId`, `serviceId`, `resourceId`, `scheduleId`, `orderId`, `refundId`, `memberId`, `wixProductId` y `wixVariantId` son campos personalizados que almacenan identificadores devueltos por Wix.
- `resourceId` identifica un recurso de Wix Bookings; `memberId` identifica un miembro de Wix Members.
- `serviceId` identifica el servicio oficial de Wix Bookings; `catalogId` identifica el registro del catálogo propio.
- Las etiquetas visibles no cambian el keyfield ni el contrato de código.
- Se mantienen `amount` y `totalAmount` hasta documentar sus fórmulas: importe base frente a total cobrado con impuestos.

## 1. CitasF2

| Keyfield | Etiqueta visible | Tipo | Origen | Función |
|---|---|---|---|---|
| `bookingId` | Wix Bookings — Booking ID | TEXT | Wix Bookings | Reserva oficial |
| `bookingType` | Reserva — Tipo de proceso | TEXT | Personalizado | `SIMPLE`, `DUAL_F1`, `DUAL_F2` |
| `bookingStatus` | Reserva — Estado interno | TEXT | Personalizado | Estado del proceso propio |
| `serviceId` | Wix Bookings — Service ID | TEXT | Wix Bookings | Servicio reservado |
| `resourceId` | Wix Bookings — Resource ID | TEXT | Wix Bookings | Recurso asignado |
| `scheduleId` | Wix Bookings — Schedule ID | TEXT | Wix Bookings | Calendario usado |
| `thirdPartyId` | Tercero fiscal — Tax ID | TEXT | Personalizado | Referencia fiscal |
| `catalogId` | Catálogo interno — Service ID | TEXT | Personalizado | Servicio propio relacionado |
| `cashMovementId` | Caja — Movement ID | TEXT | Personalizado | Movimiento de caja asociado |
| `dateYmd` | Operación — Fecha Madrid | TEXT | Personalizado | Fecha operativa `YYYY-MM-DD` |
| `slotStart` | Slot Bookings — Inicio UTC | DATETIME | Wix Bookings | Inicio oficial del slot |
| `slotEnd` | Slot Bookings — Fin UTC | DATETIME | Wix Bookings | Fin oficial del slot |
| `paymentStatus` | Pago — Estado interno | TEXT | Personalizado | `NOT_PAID`, `PAID`, etc. |
| `totalAmount` | Reserva — Importe total IVA incluido | NUMBER | Personalizado | Total de la reserva |
| `fiscalData` | Fiscal — Datos de reserva | OBJECT | Personalizado | Datos fiscales asociados |
| `invoicingDate` | Fiscal — Fecha de facturación | DATETIME | Personalizado | Fecha de facturación |
| `contactDetails` | Reserva — Datos de contacto | OBJECT | Personalizado | Contacto mínimo |
| `pairToken` | Reserva dual — Pair token | TEXT | Personalizado | Agrupa F1 y F2 |
| `sourceEventId` | Evento origen — Event ID | TEXT | Personalizado | Webhook/evento origen |
| `revision` | Registro — Revision | NUMBER | Personalizado | Versión propia |
| `meta` | Registro — Metadata | OBJECT | Personalizado | Metadatos |
| `traceId` | Trazabilidad — Trace ID | TEXT | Personalizado | Correlación end-to-end |

Eliminados: `staffResourceId`, `startDate`, `endDate`.

## 2. ServiciosCatalogo

| Keyfield | Etiqueta visible | Tipo | Origen | Función |
|---|---|---|---|---|
| `serviceId` | Wix Bookings — Service ID | TEXT | Wix Bookings | Identidad oficial del servicio |
| `sku` | Catálogo — Service SKU | TEXT | Personalizado | Código interno |
| `categoryId` | Wix Bookings — Category ID | TEXT | Wix Bookings | Categoría oficial |
| `category` | Catálogo — Category label | TEXT | Personalizado | Texto editorial |
| `locationId` | Wix Bookings — Location ID | TEXT | Wix Bookings | Ubicación oficial |
| `location` | Catálogo — Location label | TEXT | Personalizado | Nombre visible |
| `title` | Catálogo — Service title | TEXT | Personalizado | Nombre comercial |
| `slug` | Web — Service slug | TEXT | Personalizado | Ruta pública |
| `tagLine` | Catálogo — Service tagline | TEXT | Personalizado | Eslogan |
| `description` | Catálogo — Service description | TEXT | Personalizado | Descripción |
| `itemNature` | Catálogo — Item nature | TEXT | Personalizado | Naturaleza |
| `mainMedia` | Catálogo — Main media | IMAGE | Wix Media | Imagen principal |
| `recomendaciones` | Catálogo — Recommendations | TEXT | Personalizado | Recomendaciones |
| `price` | Catálogo — Base price | NUMBER | Personalizado | Precio base |
| `currency` | Catálogo — Currency | TEXT | Personalizado | Moneda |
| `taxIncluded` | Fiscal — Tax included | BOOLEAN | Fiscal | IVA incluido |
| `tipoImpositivo` | Fiscal — VAT rate | NUMBER | Fiscal | Tipo de IVA |
| `calificacionOperacion` | Fiscal — Operation classification | TEXT | Fiscal | Calificación fiscal |
| `precioCosteBase` | Interno — Base cost | NUMBER | Personalizado | Coste interno |
| `margin` | Interno — Margin rate | NUMBER | Personalizado | Margen |
| `totalDuration` | Bookings — Total duration | NUMBER | Personalizado | Duración total |
| `phase1Duration` | Bookings — Phase 1 duration | NUMBER | Personalizado | Fase 1 |
| `phase2Duration` | Bookings — Phase 2 duration | NUMBER | Personalizado | Fase 2 |
| `exposureDuration` | Bookings — Exposure duration | NUMBER | Personalizado | Separación |
| `linkedPhases` | Wix Bookings — Phase 2 Service ID | TEXT | Wix Bookings | Servicio F2 enlazado |
| `allowCombine` | Bookings — Dual combination allowed | BOOLEAN | Personalizado | Permite proceso dual |
| `onlinePayment` | Pago — Online allowed | BOOLEAN | Personalizado | Pago online |
| `inPersonPayment` | Pago — In-person allowed | BOOLEAN | Personalizado | Pago presencial |
| `pricingModel` | Catálogo — Pricing model | TEXT | Personalizado | Modelo de precio |
| `depositType` | Pago — Deposit type | TEXT | Personalizado | Tipo de depósito |
| `depositAmount` | Pago — Deposit amount | NUMBER | Personalizado | Importe de depósito |
| `clientHidden` | Catálogo — Hidden from client | BOOLEAN | Personalizado | Ocultación pública |
| `internalNotes` | Interno — Service notes | TEXT | Personalizado | Notas internas |
| `name` | Complementos — CMS references | MULTI_REFERENCE | CMS | Complementos vinculados |

## 3. ComplementosCatalogo

| Keyfield | Etiqueta visible | Tipo | Origen | Función |
|---|---|---|---|---|
| `addonId` | Wix Bookings — Add-on ID | TEXT | Personalizado | Identidad del complemento |
| `sku` | Catálogo — Add-on SKU | TEXT | Personalizado | SKU |
| `name` | Catálogo — Add-on name | TEXT | Personalizado | Nombre |
| `description` | Catálogo — Add-on description | RICH_TEXT | Personalizado | Descripción |
| `itemNature` | Catálogo — Add-on nature | TEXT | Personalizado | Naturaleza |
| `durationMinutes` | Bookings — Added duration | NUMBER | Personalizado | Duración añadida |
| `price` | Catálogo — Add-on price | NUMBER | Personalizado | Precio |
| `taxIncluded` | Fiscal — Tax included | BOOLEAN | Fiscal | IVA incluido |
| `tipoImpositivo` | Fiscal — VAT rate | NUMBER | Fiscal | Tipo de IVA |
| `codigoImpuesto` | Fiscal — Tax code | TEXT | Fiscal | Código de impuesto |
| `claveRegimen` | Fiscal — Regime key | TEXT | Fiscal | Régimen |
| `cuentaContableIngreso` | Contabilidad — Income account | TEXT | PGC | Cuenta de ingreso |
| `traceId` | Trazabilidad — Trace ID | TEXT | Personalizado | Correlación |
| `ServiciosCatalogo_name` | Servicios vinculados — CMS references | MULTI_REFERENCE | CMS | Relación con servicios |

Se conserva `addonId`, no `addOnId`. `addOnIds` solo es el nombre del array de transporte hacia Bookings.

## 4. CajaActual

| Keyfield | Etiqueta visible | Tipo | Función |
|---|---|---|---|
| `id` | Caja — Logical ID | TEXT | ID lógico |
| `singletonKey` | Caja — Singleton key | TEXT | Discriminador |
| `fiscalPeriod` | Fiscal — Fiscal period | TEXT | Periodo `YYYY-MM` |
| `currentSequence` | Caja — Current sequence | NUMBER | Secuencia actual |
| `isOpen` | Caja — Open status | BOOLEAN | Estado de apertura |
| `cashRegisterStatus` | Caja — Register status | TEXT | Estado operativo |
| `openedBy` | Caja — Opened by | TEXT | Usuario de apertura |
| `staffResourceId` | Caja — Responsible staff resource ID | TEXT | Responsable de caja |
| `operationDate` | Caja — Operation date | DATE | Fecha operativa |
| `openedAt` | Caja — Opened at | DATETIME | Apertura |
| `closedAt` | Caja — Closed at | DATETIME | Cierre |
| `lastMovementAt` | Caja — Last movement at | DATETIME | Último movimiento |
| `openingAmount` | Caja — Opening amount | NUMBER | Fondo inicial |
| `cashAmount` | Caja — Cash amount | NUMBER | Efectivo |
| `cardAmount` | Caja — Card amount | NUMBER | Tarjeta |
| `voucherAmount` | Caja — Voucher amount | NUMBER | Vales |
| `otherAmount` | Caja — Other payment amount | NUMBER | Otros medios |
| `salesCount` | Caja — Sales count | NUMBER | Número de ventas |
| `salesAmount` | Caja — Sales amount | NUMBER | Ventas |
| `refundCount` | Caja — Refund count | NUMBER | Número de devoluciones |
| `refundAmount` | Caja — Refund amount | NUMBER | Devoluciones |
| `paymentCount` | Caja — Payment count | NUMBER | Número de pagos |
| `paymentAmount` | Caja — Payment amount | NUMBER | Pagos |
| `totalInAmount` | Caja — Total inflow | NUMBER | Entradas |
| `totalOutAmount` | Caja — Total outflow | NUMBER | Salidas |
| `netAmount` | Caja — Net amount | NUMBER | Neto |
| `expectedCash` | Caja — Expected cash | NUMBER | Efectivo teórico |
| `countedCash` | Caja — Counted cash | NUMBER | Efectivo contado |
| `difference` | Caja — Cash difference | NUMBER | Diferencia |
| `differenceReason` | Caja — Difference reason | TEXT | Motivo |
| `stateHash` | Caja — State hash | TEXT | Huella de estado |
| `versionState` | Caja — State version | NUMBER | Versión |
| `sequenceCounters` | Caja — Sequence counters | OBJECT | Contadores |
| `traceId` | Trazabilidad — Trace ID | TEXT | Correlación |

Eliminado: `initialAmount`. Se conserva `staffResourceId` aquí porque representa al responsable de caja, no necesariamente el recurso de una cita.

## 5. MovimientosCaja

Se mantienen `amount` y `totalAmount` hasta cerrar la fórmula fiscal. `hash` es la huella fiscal de este dominio.

| Keyfield | Etiqueta visible | Tipo | Función |
|---|---|---|---|
| `transactionId` | Pago — Transaction ID | TEXT | Idempotencia del cobro |
| `sequenceNumber` | Fiscal — Invoice sequence | NUMBER | Secuencia |
| `movementType` | Caja — Movement type | TEXT | Hecho económico |
| `eventType` | Evento — Event type | TEXT | Evento origen |
| `fechaOperacion` | Fiscal — Operation date | DATE | Fecha fiscal |
| `recordTimestamp` | Registro — Timestamp | DATETIME | Registro |
| `staffResourceId` | Caja — Registering staff resource ID | TEXT | Responsable |
| `bookingId` | Wix Bookings — Booking ID | TEXT | Reserva vinculada |
| `linkedBookingIds` | Wix Bookings — Linked Booking IDs | ARRAY_STRING | Reservas vinculadas |
| `orderId` | Wix eCommerce — Order ID | TEXT | Pedido |
| `refundId` | Wix Payments — Refund ID | TEXT | Reembolso |
| `thirdPartyId` | Tercero fiscal — Tax ID | TEXT | Tercero |
| `catalogId` | Catálogo interno — Item ID | TEXT | Catálogo |
| `pairToken` | Reserva dual — Pair token | TEXT | Agrupación F1/F2 |
| `paymentMethod` | Pago — Payment method | TEXT | Medio de pago |
| `channelType` | Pago — Channel type | TEXT | Canal |
| `amount` | Caja — Base amount | NUMBER | Importe base |
| `totalAmount` | Caja — Total amount with tax | NUMBER | Total cobrado |
| `taxBase` | Fiscal — Tax base | NUMBER | Base imponible |
| `taxAmount` | Fiscal — Tax amount | NUMBER | Cuota fiscal |
| `accountingAmount` | Contabilidad — Accounting amount | NUMBER | Importe contable |
| `hash` | VeriFactu — Record hash | TEXT | Huella fiscal |
| `previousRecordHash` | VeriFactu — Previous record hash | TEXT | Huella anterior |
| `traceId` | Trazabilidad — Trace ID | TEXT | Correlación |

Eliminados: `cuotaTotal`, `recordHash`, `regimeKey`. Se conserva `claveRegimen` como campo fiscal canónico si existe en la colección.

## 6. DatosFiscales

Se mantienen `taxId`, `recordType`, `thirdPartyType`, `legalName`, `taxRegime`, `verifactuEnabled`, `verifactuVersion`, `fechaInicioVerifactu`, `tipoUsoPosibleMultiOT` e `indicadorMultiplesOT`, además de los datos de contacto y domicilio. Las etiquetas visibles deben diferenciar `Fiscal — Tax ID`, `Fiscal — Record type`, `Fiscal — Legal name` y `Fiscal — Tax regime`.

## 7. HistoricoCierresZ

Se mantienen las identidades de cierre e inventario con etiquetas diferenciadas: `Inventario — Closing ID`, `Wix Stores — Product ID`, `Fiscal — Fiscal period`, `Fiscal — AEAT submission status`, `Caja — Closing hash`, `Trazabilidad — Trace ID`.

## 8. LibroAsientosContablesDetalle

Se mantienen `debitAmount`, `creditAmount`, `recordHash` y `previousRecordHash`. Se eliminan `debit` y `credit` por duplicidad. Las etiquetas son `Contabilidad — Debit amount`, `Contabilidad — Credit amount`, `Contabilidad — Entry hash` y `Contabilidad — Previous entry hash`.

## 9. InventarioStockVenta

Se mantienen `stockId`, `productId`, `variantId`, `wixProductId`, `wixVariantId`, `stockOnHand`, `stockReserved` y `stockAvailable`, con estas etiquetas:

- `Inventario interno — Stock ID`
- `Catálogo interno — Product ID`
- `Catálogo interno — Variant ID`
- `Wix Stores — Product ID`
- `Wix Stores — Variant ID`
- `Stock — Physical units`
- `Stock — Reserved units`
- `Stock — Sellable units`

No son duplicados: representan identidad interna, identidad Wix y tres estados distintos del stock.

## 10. MovimientosInventario

Se mantienen `movementId`, `movementToken`, `movementType`, `wixProductId`, `wixVariantId`, `quantity`, `quantityDelta`, `stockBefore`, `stockAfter`, `sourceEventId`, `thirdPartyId`, `operationDescription`, `recordTimestamp` y `traceId`. `sourceEventId` es el canónico; no se sustituye por `eventoOrigenId`.

## 11. ControlOperativo

Se mantienen `payload`, `eventId`, `bookingId`, `resourceId`, `serviceId`, `transactionId`, `orderId`, `refundId`, `pairToken`, `totalAmount` y `traceId`. Se eliminan `payloadJson`, `createdAt` y `updatedAt` cuando solo duplican los campos nativos Wix. `status` conserva la etiqueta `Control — Status`; `operationDescription` conserva `Control — Operation description`.

## 12. RegistrosHorariosStaff

Se mantienen `memberId`, `resourceId`, `staffName`, `recordType`, `clockEventType`, `dayKey`, `monthKey`, `recordedAt`, `recordedTime`, `registeredBy`, `registeredByMemberId`, `deviceIpAddress`, `adjustmentReason`, `signature`, `notes`, `meta` y `traceId`.

Etiquetas clave:

- `Wix Members — Member ID`
- `Wix Bookings — Resource ID`
- `Wix Members — Registering member ID`
- `Staff — Display name`
- `Time clock — Event type`
- `Time clock — Recorded at`

# Bloque 2 — Matriz de cambio e IDs legacy

## Campos eliminados del CMS

| Colección | Legacy eliminado | Actual canónico | Motivo |
|---|---|---|---|
| `CitasF2` | `staffResourceId` | `resourceId` | Duplicado solo dentro de CitasF2 |
| `CitasF2` | `startDate` | `slotStart` | Duplicaba inicio UTC |
| `CitasF2` | `endDate` | `slotEnd` | Duplicaba fin UTC |
| `CajaActual` | `initialAmount` | `openingAmount` | Duplicidad del fondo inicial |
| `MovimientosCaja` | `cuotaTotal` | `taxAmount` | Cuota fiscal canónica |
| `MovimientosCaja` | `recordHash` | `hash` | Huella canónica de movimientos de caja |
| `MovimientosCaja` | `regimeKey` | `claveRegimen` | Duplicidad de idioma |
| `LibroAsientosContablesDetalle` | `debit` | `debitAmount` | Duplicidad contable |
| `LibroAsientosContablesDetalle` | `credit` | `creditAmount` | Duplicidad contable |
| `ControlOperativo` | `payloadJson` | `payload` | Objeto estructurado canónico |
| `ControlOperativo` | `createdAt` | `_createdDate` | Duplicaba Wix |
| `ControlOperativo` | `updatedAt` | `_updatedDate` | Duplicaba Wix |

## Aliases de campo que el backend debe dejar de producir

| Legacy | Canónico |
|---|---|
| `terceroId` | `thirdPartyId` |
| `catalogoId` | `catalogId` |
| `movimientoCajaId` | `cashMovementId` |
| `dateYMD` / `ymd` / `date` | `dateYmd` |
| `slugUrl` | `slug` |
| `naturalezaItem` | `itemNature` |
| `imageUrl` / `mainMediaUrl` | `mainMedia` |
| `taxRate` | `tipoImpositivo` |
| `calificacionOperacionAEAT` | `calificacionOperacion` |
| `phase2ServiceId` / `linkFases` / `linkedPhasess` | `linkedPhases` |
| `hiddenClient` / `hiddenCliente` / `ocultoCliente` | `clientHidden` |
| `staffMemberId` | `memberId` |
| `type` | `movementType` |
| `controlStatus` | `status` |
| `concept` | `operationDescription` |
| `aeatSubmissionStatus` | `estadoEnvioAEAT` |
| `balancesByMethod` | `totalesMedioPago` |
| `computerSystemId` | `idSistemaInformatico` |
| `fiscalPayloadSnapshot` | `payloadFiscal` |
| `detailedBreakdown` | `desgloseDetallado` |
| `entryHash` / `lineHash` | `recordHash` en contabilidad |
| `prevHash` | `previousRecordHash` |

## Valores legacy de estado

| Legacy | Canónico |
|---|---|
| `UNPAID` / `NO_PAGADO` | `NOT_PAID` |
| `PAGADO` | `PAID` |
| `PENDIENTE_PAGO` | `PENDING_PAYMENT` |
| `PENDIENTE_ASIENTO` | `PENDING_LEDGER` |
| `REEMBOLSADO` | `REFUNDED` |
| `REEMBOLSADO_PARCIAL` | `PARTIALLY_REFUNDED` |
| `EXENTO` | `EXEMPT` |
| `NORMAL` | `SIMPLE` |
| `DUAL` | `DUAL_F1` o `DUAL_F2` según el registro |
| `PACKAGE` / `SUSCRIPCION` | Requieren clasificación explícita; no se aceptan como tipo de reserva |
| `CONFIRMADO` | `CONFIRMED` |
| `CANCELADO` | `CANCELED` |
| `REEMBOLSADO` | `REFUNDED` |
| `PENDIENTE` | `PENDING` |

## Tratamiento de `staffResourceId`

No se elimina globalmente:

- En `CitasF2`: eliminado; se usa `resourceId`.
- En `CajaActual`: se conserva como responsable de caja.
- En `MovimientosCaja`: se conserva como staff que registra el movimiento.

## Tratamiento de identificadores similares

| Pareja | Decisión |
|---|---|
| `bookingId` / `pairToken` | Ambos se conservan: reserva Wix frente a agrupador dual propio |
| `serviceId` / `catalogId` | Ambos se conservan: servicio Wix frente a catálogo propio |
| `resourceId` / `memberId` | Ambos se conservan: recurso Bookings frente a usuario Members |
| `amount` / `totalAmount` | Ambos se conservan hasta documentar la fórmula fiscal |
| `hash` / `recordHash` | Se conservan por dominio: caja/fiscal frente a contabilidad |
| `stockOnHand` / `stockReserved` / `stockAvailable` | Se conservan: físico, reservado y vendible |
| `_id` / IDs Wix almacenados | Se conservan: identidad CMS frente a identidad externa Wix |
| `addonId` / `addOnIds` | `addonId` es identidad; `addOnIds` solo array de transporte |

## Acciones de backend obligatorias

1. Buscar y eliminar lecturas/escrituras de los 12 campos eliminados.
2. Rechazar aliases legacy en validadores de entrada.
3. Normalizar estados antes de persistir.
4. Validar que los IDs Wix se obtienen de la respuesta oficial y no del `_id` CMS.
5. Mantener la decisión de personal en backend.
6. Mantener disponibilidad y creación de reserva como pasos separados.
7. Validar F2 con:

```js
totalDuration === phase1Duration + exposureDuration + phase2Duration
```

8. Confirmar que el checkout no equivale a pago ni a reserva confirmada.
9. Usar `addonId` para construir `addOnIds`.
10. Verificar cada cambio leyendo de nuevo el esquema CMS.

## Estado documental

- **Canónico:** keyfields actuales aprobados.
- **Eliminado:** campos duplicados retirados del CMS.
- **Backend pendiente:** aliases y campos eliminados aún deben comprobarse en código real.
- **Etiqueta pendiente:** las etiquetas visibles requieren aplicación/verificación individual en CMS.
- **ADR necesario:** fórmula exacta de `amount`/`totalAmount` y alcance de `hash`/`recordHash` entre dominios.
