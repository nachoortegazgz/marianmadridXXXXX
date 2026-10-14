# PLAN DE REFACTORIZACIÓN 2.0 — Código mínimo, funcional, fiable, profesional, cero legacy, 100 % buenas prácticas, cero duplicados

**Fecha:** 2026-10-15 · **Base analizada:** HEAD working tree (post PR #10 + fixes emailManager/permisos)
**Alcance:** `src/backend` (25 módulos + `booking/`, ≈20.4k LOC), `src/pages` (34 archivos, ≈1.85k LOC), `src/public` (4 módulos, ≈2.1k LOC).
**Método:** barrido automatizado de exports muertos (script incluido abajo, §6), verificación grep símbolo a símbolo sobre el código real (no sobre adjuntos KB), ejecución parcial de la suite offline con el loader de mocks (`node --loader tests/loader.mjs` → suites individuales en verde; `run-all.mjs` completo sin ejecutar por timeout del entorno).

---

## 0. Línea base verificada (qué NO hay que hacer ya)

| Verificación | Resultado |
|---|---|
| P0 históricos (queueFiscalRecovery, BOOKING_TYPE.DUAL_F1, imports v12 en crons/fiscalAggregator, MapaStaff en reservas, totalPrice/status, _fetchLiveRevision) | ✅ **Cerrados en HEAD** — confirmados por grep directo |
| `suppressAuth: true` / `consistentRead: true` / import de `dataLegacyAdapter` en código ejecutable | ✅ **0 usos reales** (≈30 menciones restantes son cabeceras/changelogs → Fase 6) |
| Grafo de imports páginas→backend | ✅ Solo `.web.js`; DAL única `dataAccess.js`; `MapaStaff` eliminado hasta de `staff.js` |
| Contrato jobs.config ↔ crons.js | ✅ 8/8 funciones presentes y exportadas |
| Suite offline | ⚠️ Ejecutable suite a suite con loader; **sin script `npm test`** (H-02 sigue abierto) |

**Conclusión:** el sistema es funcional y los contratos están sanos. El 100 % de la deuda restante es **superficie muerta y acoplamiento oculto**, no bugs. Este plan es una operación de reducción, no de reparación.

---

## 1. FASE R1 — Fiabilidad estructural (P0, medio día)

**R1-1 · Import dinámico a módulo inexistente (bomba de humo).**
`eventLog.js:618` importa `backend/contabilidad` (no existe). La proyección contable de VENTA_LINEA/RECTIFICATIVA/AJUSTE **falla siempre y en silencio** (log.warn). Además `_proyectarFacturaRecibida` (línea ~650) es un stub `return undefined` muerto.
→ **Decisión ADR recomendada: eliminar** `_proyectarAsientoContable` + rama del switch + stub `_proyectarFacturaRecibida` (−40 LOC). La partida doble ya queda cubierta por el ledger append-only `MovimientosCaja` y hooks de `data.js`. Si algún día se requiere Plan General Contable, resucitar desde git como módulo propio con mapa de cuentas aprobado.

**R1-2 · `npm test` inexistente.**
`package.json` no tiene script `test`; `run-all.mjs` funciona pero nadie lo invoca en CI.
→ Añadir: `"test": "node --no-warnings --loader ./src/backend/tests/loader.mjs src/backend/tests/run-all.mjs"` y `"test:single": …`. Verificar timeout razonable (la suite completa puede tardar >2 min; subir `timeout` de jobs.config no aplica aquí, solo CI).

**R1-3 · Dynamic imports innecesarios (acoplamiento oculto).**
Verificados uno a uno:
| Ubicación | Justificación real | Acción |
|---|---|---|
| `citasManager.web.js:1424` → `_invalidateCachesInternal` de reservas | **Ninguna**: citasManager ya importa estáticamente de `backend/reservas.web.js` (línea 100) y reservas **no** importa citasManager → no hay ciclo | Convertir a import estático (añadir al import existente) |
| `crons.js:144` → `registerBookingPayment` de cajas | ¿Ciclo? `cajas.web.js` no importa crons → **no hay ciclo**; verificar contra eventLog antes de tocar | Convertir a estático si el barrido de ciclos lo confirma; si persiste riesgo, documentar con comentario canónico `// DYN-IMPORT- justified: <ciclo>` |
| `horario.web.js:100` → `findStaff` | Módulo huérfano (ver R2-1) | Se resuelve al retirar el módulo |
| `eventLog.js:658` → `inventario.web.js` | eventLog es backend-no-web; inventario es webMethod module → patrón válido anti-ciclo | Mantener + comentario justificado |
| `marianAdministrationController.js:120` | Router dinámico frontend intencional | Mantener (es el diseño del bridge) |
Regla nueva: **máx. 2 dynamic imports justificados en todo el repo**, cada uno con comentario `DYN-IMPORT`.

---

## 2. FASE R2 — Retirada de API pública muerta (P1, 1 día)

Barrido automatizado (comando en §6): **9 webMethods/exportaciones con 0 consumidores internos**. Todos los webMethods son retirables *desde el repo*; el único riesgo son consumidores externos al repo (widgets HTML incrustados, automatizaciones Wix Studio). **Salvaguarda obligatoria previa:** checklist manual en el Editor + 7 días de logs de acceso a webMethods antes de cada retirada, commit atómico revertible por símbolo.

| Símbolo | Archivo | Precondición extra | Acción |
|---|---|---|---|
| `calcularHorasTrabajadas`, `getResumenHoras`, `registrarAjusteHorario` (+ resto de horario.web.js, 586 LOC) | `horario.web.js` | Ninguna: 0 refs de página/controlador; protección RD 8/2019 vive en `data.js`+`validation.js` (hooks de `RegistrosHorariosStaff` intactos) | **R2-1 · Retirada total del módulo** (−586 LOC). ⚠️ Consecuencia verificada: `signTimeclockRecord`/`verifyTimeclockSignature` de `securityEngine.js` quedan sin escritor en el repo (solo horario los usaba) → desexportar y documentar ADR: si los fichajes se reactivan desde Wix Studio, resucitar ambos con git. |
| `rescheduleDualBookings`, `rescheduleExistingBooking` | `citasManager.web.js` | Lógica interna viva (`revalidateExactAvailabilitySlot` sí se usa); posible consumidor: UI de reprogramación externa | Retirar envoltorio webMethod, **conservar** las funciones internas que consumen otros flujos |
| `registerGiftCardSale`, `registerGiftCardRedemption` | `cajas.web.js` | Página TARJETAS REGALO es stub → decisión de producto conjunta | Si no hay feature: retirar webMethods + stub de página en el mismo commit |
| `generateInventoryClosing`, `listInventoryClosings` | `inventario.web.js` | `generateInventoryClosing` bloquea con "destination collection unverified" → **nunca funcionó** | Retirar (−~120 LOC) o terminar la feature; no dejar API que devuelve error permanente |
| `getQuarterlyTaxSummaryInternal` | `fiscalAggregator.web.js` | Usada intra-módulo (línea 542) | Solo **desexportar** (§R3) |

**R2-2 · Exports totales sin uso ni interno (eliminar outright):**
`cajas.executeLedgerWithBackoff`, `logger.withLogging`, `responseUtils.isSuccess`, `responseUtils.toWebMethodResult`, `security.isKeyPersistentlyBlocked`, `security.requireStaffCollaborator`, `securityEngine.buildStateHash`, `widgetBridge.buildResponseType`, `bookingCore.CMS_BOOKING_STATUS`, `bookingCore.CMS_PAYMENT_STATUS`, `internalConfig.{TIPO_IMPOSITIVO_VALIDOS, ROL_BOOKINGS, POSITIVE_INVENTORY_MOVEMENT_TYPES, NEGATIVE_INVENTORY_MOVEMENT_TYPES}`, `validation.{assertControlOperativo, assertMovimientosInventario, expectedInventoryMagnitude}`.
⚠️ **NO tocar** `data.js :: CajaActual_before{Insert,Update,Remove}` — falsos positivos del barrido: son hooks Velo invocados por convención de nombre por el runtime, no por import. Documentar esta excepción en el script de barrido (lista blanca de convenciones Velo: `*_before*`, `*_after*`, `wixData*`, `wixBookingsV2_*`, `wixEcom_*`, `init*` de pages).

**Total estimado retirada R2: ≈900–1000 LOC.**

---

## 3. FASE R3 — Desexportar superficie interna (P1, medio día)

Símbolos usados **solo dentro de su archivo** → quitar `export` (reduce superficie API sin tocar comportamiento; algunos son alcanzados por tests → mover esos tests a la puerta pública correspondiente o mantener export con comentario `@internal-test-only`):

- `bookingCore`: `_areSlotsContiguous`, `_buildSlotLockControl`, `_extractResourceIdsFromSlot`, `_projectCertifiedSlot`, `_projectWriterSlotFromAvailability`, `buildLockKeys`
- `bookingUtils`: `resolveNativeAddOnIds` · `cajas`: `validateFiscalConfig` · `eventLog`: `getEventoPorId`, `actualizarEstadoPagoFactura`, `registrarFacturaRecibida`, `listarFacturasRecibidas`, `getFacturaRecibida`, `reconciliarProyecciones` (estos 6 son webMethods → van con checklist R2 primero)
- `securityEngine`: **re-verificado** — sus únicos consumidores externos son `hashSHA256`, `hashChain` (cajas, eventLog) e `hmacSha256Hex` (inventario). Los demás (`buildClosingHash`, `buildRecordHash`, `buildStateHash`, `generateJWT`, `verifyJWT`, `timingSafeEqual`, `signTimeclockRecord`, `verifyTimeclockSignature`) no tienen ningún import externo en todo el repo. Nota: la verificación JWT de webhooks en `events.js` usa `wixClient.webhooks.process()` (SDK), **no** `verifyJWT` propio → los JWT internos son eliminables con seguridad. Consecuencia en cascada: `internalConfig.JWT` queda sin consumidor → retirar también (R2-2). Timeclock (`sign/verifyTimeclockSignature`) se retira tras R2-1.
- ~~`validation`: `assertControlOperativo`, `assertMovimientosInventario`, `expectedInventoryMagnitude`~~ → **MUERTOS REALES, eliminar**: verificado que `data.js` NO los importa (sus hooks de `ControlOperativo` validan inline; la cabecera de `validation.js:27` afirma "consumido por data.js" pero es un comentario obsoleto). El único consumidor externo real de `validation.js` es `assertValidEnum` (bookingCore) e `isValidNifOrEuVat` (data.js). Retirar junto con el resto en R2/R3 y corregir la cabecera.
- `reservas.web`: `_mapServiceToDTO`, `_getAvailableDaysInternal`, `_toPublicService`, `_mapServiceImport2ToUX` (uso intra-módulo verificado) · `security`: `registerPersistentBlock`
- `mmUtils`: `numberOrZero`, `madridOffsetMinutes`, `CURRENCY_CONFIG` (uso intra-archivo), `SITE` (0 refs tras retirar comentarios) → evaluar mover a sección privada
- Convención (H-53 heredado): público sin `_`, privado con `_`; aplicar rename solo en los símbolos que sobreviven a R2/R3.

---

## 4. FASE R4 — Deduplicación (P1, 1 día)

**R4-1 · `public/mmUtils.js` −15 funciones muertas** (~200 LOC): `cleanGuid`, `isDateYmd`, `buildLocalDateRange`, `toMadridIsoZ`, `getMadridTime`, `getMadridMonthKey`, `madridOffsetMinutes`(si nada lo usa tras retirar toMadrid*), `formatUtcOffset`, `toBoolean`, `booleanValue`, `getReferenceIds`, `_maskTaxId`, `isPlainObject`, `toMadridIsoLocal`, `SITE`.
**R4-2 · Espejos SSOT frontend↔backend** (`SITE`, `SLOT_SEARCH`, `BOOKINGS_ADDON_CONFIG` en mmUtils vs `internalConfig.js`): dos opciones — (a) **recomendada, mínima**: borrar los espejos sin consumidor tras R4-1 y dejar en mmUtils solo lo que las páginas usan; (b) si algún espejo tiene consumidor, añadir `tests/configMirrorParity.test.mjs` (deep-equal mmUtils↔internalConfig, precedente: `crons.jobsConfigParity.test.mjs`).
**R4-3 · Helpers duplicados en páginas:** `normalizeAddOnIds` inline en `Calendario de reservas 2.q39h6.js:222` → mover a `mmUtils` y usar también en `Pagina de servicio 2.xnfr4.js` si replica la lógica; `_safeTrim` inline en `ConfirmacionReserva.q5vps.js:140` → importar de mmUtils (la página ya importa otras cosas de allí).
**R4-4 · `qrHelper.js`:** eliminar alias `buildVerifactuQrUrl = generateVerifactuQrUrl` manteniendo **un solo nombre canónico** (el que consume ConfirmacionReserva: `buildVerifactuQrUrl`); desexportar `AEAT_VERIFACTU_ENDPOINTS`, `extractVerifactuData`, `generateVerifactuQrUrl` (uso intra-módulo).
**R4-5 · Páginas duplicadas:** `Página de servicio.af54v.js` (stub) vs `Pagina de servicio 2.xnfr4.js` (383 LOC, la que sirve tráfico vía widgetBridge) y `Calendario de reservas 2.q39h6.js` — confirmar sitemap del editor y retirar el stub perdedor (requiere verificación manual Wix; no borrar a ciegas).

---

## 5. FASE R5 — Higiene profesional (P2, 1 día)

- **R5-1 · Cabeceras-changelog → `CHANGELOG.md` global** (o por módulo grande). ≈230 líneas de changelog solo en reservas.web.js; objetivo −800 LOC de comentarios históricos en todo el repo. Cabecera estándar fija: `MODULE / VERSION / RESPONSIBILITY / DEPENDENCIES / OWNER`. Incluir en la migración la limpieza de las ~30 menciones textuales a `suppressAuth/consistentRead/dataLegacyAdapter` (Fase legacy ya cerrada → nada que auditar, solo texto).
- **R5-2 · Comentarios obsoletos:** `marianAdministrationController.js:102-104` (referencias comentadas a `staff.web` inexistente) → limpiar junto con R2-1.
- **R5-3 · ESLint en CI:** `npm run lint` existe; añadir a pipeline con `--max-warnings 0` y reglas `no-unused-vars` + detección de exports sin uso (plugin `import/no-unused-modules` con `exportsDefault` o el script de barrido §6 como job).
- **R5-4 · READMEs:** `src/backend/README.md`, `src/pages/README.md`, `src/public/README.md` → actualizar grafo de dependencias tras retiradas; documentar la lista blanca de convenciones Velo (§R2-2) para que futuros barridos no marquen hooks.
- **R5-5 · `permissions.json` / `jobs.config`:** re-sincronizar tras R2 (quitar entradas de horario si existieran; validar con test de paridad ya existente).

---

## 6. Herramienta de barrido (incluida en el plan, guardar como `src/backend/tests/dead-export-sweep.sh`)

```bash
#!/bin/bash
# Sweep de exports muertos. Lista blanca de convenciones Velo (runtime llama por nombre):
VL='^CajaActual_|_before|_after|^wixBookingsV2_|^wixEcom_|^init'
for f in $(find src -name "*.js" -not -path "*__tests__*" -not -path "*/tests/*"); do
  grep -hoE "^export (async function|function|const|let) [A-Za-z_][A-Za-z0-9_]*" "$f" \
  | awk '{print $NF}' | sort -u | while read s; do
    echo "$s" | grep -qE "$VL" && continue
    refs=$(grep -rlw "$s" src --include="*.js" --include="*.mjs" | grep -v "^$f$" | wc -l)
    own=$(grep -cw "$s" "$f")
    [ "$refs" -eq 0 ] && [ "$own" -le 1 ] && echo "MUERTO TOTAL: $f :: $s"
    [ "$refs" -eq 0 ] && [ "$own" -gt 1 ] && echo "SOLO INTERNO: $f :: $s"
  done
done
```
Nota: usar `grep -rlw` con rutas entre comillas y `find -print0` si hay nombres con espacios (los ficheros de `src/pages` con espacios se omitieron en el primer barrido → re-ejecutar cubriéndolos antes de dar por buena la lista).

---

## 7. Ejecución, orden y métricas

| Orden | Entregable | LOC estimados | Criterio de salida |
|---|---|---|---|
| 1 | R1 (fiabilidad) | −40 | Suite `npm test` verde; 0 imports a módulos inexistentes; ≤2 dynamic imports justificados |
| 2 | R2 (API muerta) | −950 | Checklist Editor + 7 días logs por símbolo; suite verde |
| 3 | R3 (desexportar) | −0 (superficie) | Barrido: 0 "MUERTO TOTAL"; exports públicos = contratos reales |
| 4 | R4 (dedupe) | −350 | 0 helpers duplicados pages↔public; parity test de espejos activo |
| 5 | R5 (higiene) | −800 | `npm run lint` 0 warnings; cabecera plantilla única |

**Objetivo final:** backend+public ≈ 22.5k → **≈18.5k LOC (−18 %)** sin pérdida funcional; E2E 15/15; grep de aceptación legacy = 0 (también en texto); toda retirada en commit atómico revertible.

**Despliegue:** internalConfig → security/securityEngine/logger/responseUtils → eventLog → cajas/citasManager/inventario/fiscalAggregator → horario (retirada) → reservas → public/pages. Nunca retirar webMethods en el mismo deploy que cambios de backend-no-web.

**Riesgos principales:** (1) consumidores externos al repo de los webMethods → mitigado con logs 7 días; (2) features a medias (gift cards, cierres inventario) → decidir producto vs retirada explícita, no dejar API fallante; (3) hooks Velo falsamente muertos → lista blanca del barrido.
