# Auditoría de integridad de operaciones y CMS

Fecha: 23 de octubre de 2026  
Sitio: Marian Madrid Peluquería y Estética  
Modo de pruebas: mocks offline del repositorio; las lecturas de esquema se hicieron sobre el CMS publicado.

## Alcance

Se compararon los campos que escriben los productores backend con los campos de las colecciones CMS existentes. Las pruebas de flujo escriben únicamente en `wixDataMock`; no se insertaron reservas, ventas, pagos, fichajes ni cierres de prueba en los ledgers productivos.

## Cambios confirmados en el CMS publicado

### `MovimientosInventario`

Se añadieron los campos opcionales que el productor ya escribía pero que faltaban en el esquema:
- `productName` — snapshot del nombre del producto.
- `catalogId` — identificador del producto del maestro interno.
- `orderId`, `refundId`, `referenceId` — referencias de origen.
- `actorEmail`, `actorMemberId` — identidad del actor, cuando proceda.
- `requiresWixReconciliation`, `nativeCommercialMovement` — estado/origen de conciliación.
- `magnitude` — signo del delta de stock.

El campo `movementId` ya existía. El backend se alinea con `InventarioStockVenta.name`; no lee el campo inexistente `productName` del maestro. Se eliminó el fallback de `stockExpected`: `stockOnHand` y `stockReserved` deben ser cantidades canónicas válidas.

### `InventarioStockVenta`

Se añadieron `lastInventoryMovementAt` y `lastInventoryMovementId`, campos que el backend ya actualizaba tras cada movimiento. La fila de stock puede así señalar el último registro de `MovimientosInventario` que la modificó.

### `MovimientosCaja`

Se añadieron campos opcionales que los escritores fiscales/caja ya emitían y que no existían en el esquema:
`surchargeRate`, `irpfWithholdingRate`, `withholdingBase`, `correctionReason`, `previousInvoiceNumber`, `previousInvoiceIssueDate`, `issuerInvoiceNumber`, `correctionAmount`, `issuerLegalName`, `isB2B`, `issuedByThirdPartyOrRecipient`, `thirdPartyLegalName`, `issuerThirdPartyTaxId`, `nonSubjectReason`, `cashBasisRegime`, `article20Exempt`, `linkedAdvanceId`, `vatAccrualStatus`, `bankReconciliationReference`, `resourceId`, `recordSource`, `lineItems`, `accountingSign`, `giftCardId`, `giftCardOperation`, `serviceIdRedeemed`, `generationTimestamp`, `digitalSignature`, `aeatPayload`, `verificationQR`, `hashAlgorithm` y `signatureAlgorithm`.

Se eliminó `customerEmail` del payload fiscal de la tarjeta regalo para no replicar PII en el ledger financiero; el dato de contacto debe permanecer en la fuente de contactos/tarjetas regalo.

### `HistoricoCierresZ`

Se añadieron los campos opcionales que el cierre Z genera:
`totalRefunds`, `totalTips`, `totalAdjustments`, `totalOperations`, `startTicketNumber`, `endTicketNumber`, `movementTypeBreakdown`, `taxTypeBreakdown`, `auditedRecordsCount`, `closingSource`, `closingSchemaVersion`, `timeZone` y `closedAt`.

## Correcciones de código y cobertura E2E preparadas en PR #89

- La proyección contable recibe el registro de caja ya persistido, con su `_id` CMS.
- `LibroAsientosContablesDetalle.sourceMovementId` y `cashMovementId` apuntan al movimiento real de caja; no a `transactionId`.
- La huella contable toma `MovimientosCaja.hash` y `previousRecordHash`; se eliminan los aliases legacy `debit` y `credit`.
- La fecha de la factura rectificada se convierte a tipo CMS `DATE`.
- Los E2E verifican los campos clave de caja, la proyección contable, el cierre Z y el fichaje horario.
- Se retiró `createdAt` de la marca de idempotencia en `ControlOperativo`; se conserva el campo nativo `_createdDate`.
- El E2E de inventario comprueba venta, devolución, origen de evento, IDs Wix, catálogo interno, stock anterior/posterior, idempotencia y rechazo de maestro de stock inválido.

### Tarjetas regalo y referencias a reservas

- La redención consultaba `taxRate`, que no es el campo canónico del catálogo publicado. Se cambió a `ServiciosCatalogo.tipoImpositivo`; el valor real se guarda como fracción decimal (por ejemplo, `0.21`) y `taxIncluded` se expone en el catálogo.
- La redención ya no usa el IVA general como fallback si falta el servicio o su tipo impositivo. Devuelve un error explícito y no registra el movimiento.
- Venta y canje de tarjeta regalo guardan un snapshot de líneas, el ID de tarjeta, el ID interno de catálogo cuando aplica, el tipo de operación y el `traceId`.
- `MovimientosCaja.linkedBookingIds` es `ARRAY_STRING` en el CMS; se corrigió la escritura para conservar un array de GUIDs, no una cadena CSV.

## Hallazgos que no deben ocultarse

1. **Precio nativo de Bookings no expuesto:** la proyección nativa guarda `totalAmount = 0` y `meta.amountReconciliationRequired = true` cuando el webhook no trae importe fiable. Es una ausencia declarada, no debe sustituirse por un precio supuesto.
2. **Contabilidad PGC:** el productor actual crea una sola línea con `debitAmount` y `creditAmount` iguales y un único `accountCode`. Aunque la trazabilidad de origen se corrige en PR #89, eso no demuestra un asiento de doble partida válido con cuentas de contrapartida e IVA. Hace falta definir/aprobar la matriz contable por tipo de operación antes de certificar la contabilidad.
3. **`MapaStaff` está desalineada con la Biblia SSOT:** el esquema publicado observado contiene campos legacy (`wixStaffMemberId`, `active`, `sortOrder`) y no todos los campos canónicos documentados (`memberId`, `rolBookings`, `rolWebsite`, `staffName`, `thirdPartyId`, `scheduleId`). Además, el resolver de personal deriva el rol web de configuración de código y de Bookings, no de una fila canónica de `MapaStaff`. No se migró esta colección porque hacerlo correctamente requiere resolver/verificar los IDs reales del personal y no inventarlos.
4. **Los E2E no certifican por sí solos el CMS real:** el runtime Wix puede tener restricciones de esquema, permisos o webhooks distintos del mock. Tras integrar los PR, hay que ejecutar una prueba controlada en QA y comparar una lectura real de cada registro con su fuente nativa, sin crear operaciones ficticias en los ledgers productivos.

## Criterio de aceptación

Una operación solo se considera completa si:
- conserva el ID nativo de origen y el ID CMS de destino;
- persiste `traceId`, marca temporal y estado canónico;
- guarda los importes/desgloses que la app de origen realmente expone;
- identifica explícitamente los datos no expuestos o pendientes de conciliación;
- no sustituye un dato desconocido por cero, un ID de otra fuente o un valor supuesto;
- respeta la inmutabilidad de los ledgers y la idempotencia.


## Revalidación de MapaStaff — 2026-10-25

La inspección posterior del esquema vivo de Wix CMS confirma que `MapaStaff` existe como colección `NATIVE`, etiqueta `MAPA_STAFF`, revisión 11, campo de visualización `displayName`, 19 campos y permisos ADMIN para lectura/escritura/borrado. El punto 3 anterior queda como hallazgo histórico del corte del 2026-10-23, no como estado actual.

Correcciones realizadas en la rama `fix/cms-keyfields-runtime-alignment-2026-10-25`:

- Se documenta el esquema real y se actualizan Biblia SSOT y diccionario CMS.
- `staffMemberId` es el identificador canónico del perfil de Bookings; `wixStaffMemberId` permanece en CMS como duplicado histórico, pero el runtime ya no lo usa como fallback.
- `staffName` es el nombre canónico consumido por backend; `displayName` sigue siendo el campo de visualización CMS.
- El resolver exige `active === true`; los mapeos inactivos o sin estado explícito no conceden rol.
- El health check incorpora `BUSINESS_COLLECTIONS.MAPA_STAFF`.

No se modificaron filas ni permisos del CMS. El runtime se integró mediante PR #166; la regresión causada por fixtures sin `active` se corrigió y pasó CI en PR #167. No se publicó Wix.


## Revalidación de keyfields fiscales — 2026-10-25

Se volvieron a consultar por API oficial los esquemas vivos de las 13 colecciones CMS. En las colecciones fiscales, los nombres canónicos actuales confirmados son:

- `MovimientosCaja.aeatPayload` (OBJECT), `irpfWithholdingRate` (NUMBER), `irpfWithholdingAmount` (NUMBER), `nifEmisor` (TEXT) y `nifDestinatario` (TEXT).
- `HistoricoCierresZ.snapshotJson` (TEXT), respetando exactamente mayúsculas/minúsculas.

Los escritores actuales de caja ya usan `aeatPayload`, `irpfWithholdingRate`, `irpfWithholdingAmount`, `nifEmisor`, `nifDestinatario` y `snapshotJson`; la divergencia comprobada estaba en las tablas documentales, que conservaban variantes antiguas (`payloadAEAT`, `IRPFWithholdingRate`, `NIFEmisor`, `NIFDestinatario`, `IRPFWithholdingAmount` y `snapshotJSON`). Se corrigieron Biblia SSOT y diccionario CMS sin renombrar ni alterar campos de producción.

La revisión de nombres y tipos no sustituye una auditoría de obligatoriedad, permisos de cada registro o validación fiscal funcional. No se modificaron datos del CMS ni se publicó Wix.
