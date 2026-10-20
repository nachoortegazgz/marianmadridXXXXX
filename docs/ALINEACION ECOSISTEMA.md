# Auditoría del ecosistema Wix — Marian Madrid

Fecha: 20 de octubre de 2026

## Alcance y evidencia

Se revisaron la configuración general disponible, aplicaciones instaladas, capacidades declaradas por aplicaciones, estructura y muestras de datos del CMS, y la URL publicada. El sitio está publicado, usa dominio propio, tiene plan Premium, Editor clásico y Velo habilitado.

**Límite importante:** no existe una vía disponible en esta revisión para leer el árbol de archivos Velo del Editor. Por tanto, los hallazgos sobre frontend/backend se infieren de contratos CMS y datos, pero no equivalen a una revisión línea por línea del código. Para cerrar esa parte hace falta exportar o facilitar los módulos frontend, backend, web modules, eventos y HTML embebido.

## Resumen ejecutivo

El ecosistema presenta una arquitectura ambiciosa que combina Wix Bookings y Wix Stores con un catálogo propio, reservas de dos fases, caja, fiscalidad, inventario, contabilidad y control operativo. La estructura tiene buenas decisiones de seguridad —las colecciones transaccionales son administrativas— y contratos técnicos en inglés.

El principal riesgo no es la falta de componentes, sino la **duplicación de fuentes de verdad** y la ausencia visible de actividad en nueve subsistemas operativos. Hay 12 colecciones propias: solo `ServiciosCatalogo` y `ComplementosCatalogo` contienen datos en la muestra; las otras 10 están vacías. Esto puede significar preparación aún no conectada, código no ejecutado, eventos no activados o un entorno productivo que escribe en otro lugar.

## Inventario observado

- 32 colecciones totales: 12 propias y 20 administradas por aplicaciones Wix.
- 93 registros en `ServiciosCatalogo`.
- 36 registros en `ComplementosCatalogo`.
- Sin registros devueltos en `CitasF2`, `CajaActual`, `ControlOperativo`, `DatosFiscales`, `HistoricoCierresZ`, `InventarioStockVenta`, `LibroAsientosContablesDetalle`, `MovimientosCaja`, `MovimientosInventario` y `RegistrosHorariosStaff`.
- Aplicaciones relevantes: Wix Bookings, Wix Stores V1, Blog, Forms, Members, Gift Cards e Invoices V1.
- Ninguna aplicación instalada declaró capacidades adicionales específicas para asistentes.
- Solo se confirmó como URL publicada principal `https://www.marianmadrid.es/`.

## Hallazgos prioritarios

### P0 — Fuentes de verdad duplicadas

`ServiciosCatalogo` replica datos que también pertenecen a Wix Bookings: servicio, categoría, ubicación, precio, duración, pagos y visibilidad. `InventarioStockVenta` replica datos de Wix Stores: producto, variante, precio y stock.

**Riesgo:** una edición manual en Wix Bookings o Stores puede dejar desactualizado el catálogo propio, o viceversa. La web podría mostrar una duración/precio mientras la reserva o el cobro usa otra.

**Recomendación:** declarar por escrito la autoridad de cada campo. Propuesta:

- Wix Bookings: disponibilidad, servicio reservable, recursos, agenda y estado real de reserva.
- `ServiciosCatalogo`: contenido editorial, fases, exposición, recomendaciones y reglas propias.
- Wix Stores: stock vendible y variantes.
- Colecciones propias: proyecciones auditables, nunca autoridad primaria de Wix.

Toda sincronización debe guardar fecha, versión, origen y resultado de conciliación.

### P0 — Subsistemas críticos sin actividad observable

Caja, movimientos, contabilidad, inventario, cierres fiscales, control operativo, citas F2 y fichajes devolvieron cero registros.

**Riesgo:** si se consideran operativos, no hay evidencia de que estén recibiendo eventos. Fiscalidad y contabilidad pueden parecer implementadas por el esquema sin estar realmente funcionando.

**Recomendación:** ejecutar pruebas de extremo a extremo controladas: reserva simple, reserva dual, pago, reembolso, venta de producto, ajuste de stock, apertura/cierre de caja y fichaje. Verificar en cada paso el registro esperado, su correlación mediante `traceId` y la idempotencia.

### P0 — Inconsistencias en servicios auxiliares F2

En muestras visibles, varios registros cuyo texto declara fases y duración concreta aparecen normalizados como `phase1Duration: 40`, `phase2Duration: 0`, `exposureDuration: 0` y `totalDuration: 40`, aunque la descripción indica, por ejemplo, 15 + 20 + 10 = 45 o 25 + 30 + 35 = 90.

**Riesgo:** si esos registros se usan como segunda fase vinculada, la ocupación y la revalidación exacta pueden ser incorrectas.

**Recomendación:** los F2 auxiliares no deben reinterpretar la duración total del servicio principal. Definir explícitamente qué representa cada registro: fase ejecutable, marcador interno o servicio reservable. Validar automáticamente que `totalDuration = phase1Duration + exposureDuration + phase2Duration` cuando aplique.

### P1 — Semántica ambigua de `linkedPhases`

`linkedPhases` es texto y contiene identificadores, mientras `allowCombine` controla el proceso dual. El nombre sugiere plural, pero el tipo solo expresa un valor y no existe integridad referencial.

**Riesgo:** enlaces huérfanos, confusión entre identificador de Bookings y registro CMS, y contratos distintos entre frontend y backend.

**Recomendación:** renombrar en una migración futura a un contrato singular inequívoco, o convertirlo en referencia/array estructurado. Hasta entonces, documentar que contiene exactamente un `serviceId` de Wix Bookings y validar su existencia antes de publicar el servicio.

### P1 — Slugs con caracteres no normalizados

Se observan slugs auxiliares con caracteres acentuados, como `f2-coloración-raíces-perfectas`, mientras otros están normalizados sin tildes.

**Riesgo:** discrepancias de codificación, rutas difíciles de comparar y fallos al resolver servicios desde URL.

**Recomendación:** normalización única: minúsculas, ASCII, guiones simples, sin espacios ni diacríticos; índice lógico de unicidad y redirección al cambiar un slug público.

### P1 — Contratos de nombres parcialmente alineados

La mayoría de claves técnicas están en inglés, pero persisten claves mixtas o españolas: `tipoImpositivo`, `codigoImpuesto`, `claveRegimen`, `cuentaContableIngreso`, `precioCosteBase`, `desgloseDetallado`, etc. Además, el campo multi-referencia entre servicios y complementos usa `name` en un lado y `ServiciosCatalogo_name` en el otro.

**Riesgo:** adaptadores repetidos, errores de mapeo y mayor coste de mantenimiento.

**Recomendación:** mantener compatibilidad externa, pero introducir una capa canónica con claves inglesas. Priorizar nombres semánticos para referencias: `addons` y `services`, manteniendo `addonId` como identidad y `addOnIds` solo como array de transporte hacia Bookings.

### P1 — Campos monetarios redundantes

En caja y contabilidad coexisten pares como `amount`/`totalAmount`, `debit`/`debitAmount`, `credit`/`creditAmount`, además de numerosos totales derivados.

**Riesgo:** valores divergentes y cierres imposibles de reconciliar.

**Recomendación:** distinguir claramente importe fuente, base, impuesto, total y valor derivado. Los derivados deberían calcularse o llevar versión y huella; no mantenerse manualmente sin una regla de precedencia.

### P1 — Colecciones públicas con metadatos internos

`ServiciosCatalogo` y `ComplementosCatalogo` permiten lectura pública. Además del contenido comercial exponen coste base, margen, notas internas, cuentas contables y clasificación fiscal.

**Riesgo:** aunque la interfaz no los muestre, un visitante podría consultar información interna sensible para el negocio.

**Recomendación:** separar vista pública y configuración privada. Mantener públicamente solo los campos necesarios para renderizar; mover costes, márgenes, notas y contabilidad a una colección administrativa o servirlos únicamente desde backend.

### P2 — Valores por defecto masivos en complementos

Muchos complementos comparten duración de 5 minutos, precio de 5 € y descripciones idénticas al nombre.

**Riesgo:** datos provisionales tratados como definitivos; impacto en disponibilidad y cobro.

**Recomendación:** añadir estado editorial (`DRAFT`, `REVIEWED`, `ACTIVE`) y bloquear el uso en reservas hasta revisión. Detectar automáticamente patrones sospechosamente uniformes.

### P2 — Imagen repetida en servicios

La muestra de servicios usa de forma repetida la misma imagen principal.

**Riesgo:** experiencia genérica, menor diferenciación y posible desalineación entre página de servicio y contenido.

**Recomendación:** admitir fallback global explícito, pero distinguirlo de una imagen específica. Generar una lista de servicios que aún usan el fallback.

### P2 — Dependencia de identificadores sin integridad fuerte

Muchas relaciones entre reservas, pedidos, pagos, caja, inventario y fiscalidad se guardan como texto.

**Riesgo:** referencias huérfanas y dificultad para determinar el estado real.

**Recomendación:** definir claves de correlación y restricciones lógicas: `traceId` único por operación, `sourceEventId` único por evento, tokens idempotentes y conciliadores periódicos para Wix Bookings, Stores y pagos.

## Fricciones arquitectónicas

1. **Edición distribuida:** una misma entidad comercial se configura en Wix Bookings, CMS y posiblemente código.
2. **Estados paralelos:** reserva, pago, caja, fiscalidad y compensación pueden evolucionar por separado; no deben colapsarse en un único estado.
3. **Dificultad de diagnóstico:** `ControlOperativo` reúne deduplicación, reintentos, alertas y rate limiting en una tabla polimórfica grande.
4. **Carga cognitiva:** algunas colecciones superan ampliamente 40 campos y mezclan dato fuente, proyección, auditoría y presentación.
5. **Compatibilidad heredada:** Wix Stores e Invoices están en versión V1; cualquier código nuevo debe evitar contratos de versiones posteriores.

## Fortalezas

- Separación conceptual entre catálogo editorial y sistemas Wix.
- Uso extendido de `traceId`, huellas y secuencias para auditabilidad.
- Colecciones transaccionales restringidas a administración.
- Modelo explícito para fases, exposición, combinación y visibilidad al cliente.
- Identidad de complementos mediante `addonId` ya presente y consistente en las muestras.

## Plan recomendado

### Fase 1 — Contención

1. Retirar de lectura pública costes, márgenes, notas y contabilidad.
2. Congelar cambios estructurales hasta definir autoridades por campo.
3. Corregir servicios F2 y validar matemáticamente todas las duraciones.
4. Normalizar y comprobar unicidad de slugs, SKU, `serviceId` y `addonId`.

### Fase 2 — Verificación operativa

1. Crear una matriz evento → escritor → colección → estado esperado.
2. Ejecutar pruebas simples y duales con pago y compensación.
3. Verificar que cada mutación tiene lectura posterior y correlación.
4. Confirmar que editar en Bookings o Stores actualiza o invalida la proyección propia.

### Fase 3 — Simplificación

1. Separar `ControlOperativo` en idempotencia, reintentos y alertas si el volumen crece.
2. Reducir campos monetarios duplicados.
3. Estandarizar claves técnicas en inglés mediante adaptadores compatibles.
4. Convertir relaciones textuales críticas en referencias o contratos validados.

### Fase 4 — Revisión de código

Revisar estos bloques con los archivos reales:

- Resolución de servicio por slug.
- Mapeo `name`, `title`, `addonId` y `addOnIds`.
- Disponibilidad con ubicación de negocio y creación con ubicación del propietario.
- Selección exacta o balanceada de personal en backend.
- Revalidación inmediata antes de crear reservas.
- Coordinación y compensación de las dos reservas del proceso dual.
- Separación entre reserva, checkout, pago y confirmación.
- Exposición de funciones públicas y validación de entradas.
- Eventos de Bookings, Stores, pagos y reembolsos.

## Criterios de aceptación

- Un único sistema es autoridad para cada campo.
- Ninguna colección pública expone datos internos.
- Todos los servicios cumplen invariantes de duración y enlaces.
- Una reserva dual deja dos reservas coordinadas o una compensación verificable.
- Un checkout nunca se interpreta como pago ni confirmación.
- Cada evento externo es idempotente y trazable.
- Inventario, caja y contabilidad se concilian con sus fuentes Wix.
- Los estados mostrados al usuario provienen de una lectura final confirmada.

## Conclusión

La base es potente, pero actualmente hay señales de **sobreextensión del modelo antes de demostrar la conexión operativa**. La prioridad debe ser asegurar autoridad de datos, privacidad de campos, invariantes de servicios duales y pruebas end-to-end. Después conviene simplificar contratos y revisar el código real para determinar qué estructuras son activas, cuáles son redundantes y cuáles quedaron preparadas pero desconectadas.
