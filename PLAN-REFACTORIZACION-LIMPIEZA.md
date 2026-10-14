# PLAN DE REFACTORIZACIÓN Y LIMPIEZA — Objetivo: código mínimo, funcional, fiable, profesional, cero legacy, 100 % buenas prácticas, cero duplicados

**Fecha:** 2026-10-15 · **Base analizada:** HEAD (merge PR #10, ssot-refactoring-plan-v12)
**Alcance analizado:** `src/backend` (25 módulos + `booking/`, ≈20.356 LOC), `src/pages` (34 archivos, ≈1.852 LOC), `src/public` (4 módulos, ≈2.124 LOC).
**Método:** auditoría estática verificada por grep (grafo de imports, exports muertos, webMethods sin consumidor, duplicados, markers legacy, dynamic imports, espejos SSOT).

---

## 0. Estado de salud actual (línea base verificada)

| Dimensión | Estado | Evidencia |
|---|---|---|
| Contratos P0 históricos | ✅ Sanos | `events.js` ya envía `totalAmount:`/`operationDescription:` a `queueFiscalRecovery` (4 llamadas, firmas alineadas con cajas.web v5010). `internalConfig` v12 sin `SITE_ID`/`IGIC`/`EU_VAT_PREFIXES`; `BOOKING_FIELDS.META` presente. |
| Legacy runtime | ✅ Erradicado | `suppressAuth`, `consistentRead`, `dataLegacyAdapter`: **0 usos en código ejecutable** (solo 24+6 menciones en cabeceras/changelogs). |
| Grafo de imports | ✅ Sin violaciones | Ninguna página importa un módulo backend que no sea `.web.js`. `dataAccess.js` es la DAL única; helpers compartidos viven solo en `public/mmUtils.js` (0 duplicados de `_safeTrim`/`makeTraceId`/`withTimeout` en backend). |
| Cobertura real de páginas | ⚠️ Concentrada | Solo 5 páginas con lógica: Calendario 2, Pagina de servicio 2, ConfirmacionReserva, ZONA MARIAN, ZONA STAFF. 29 stubs Wix (0–10 líneas). |
| Deuda principal | 🔴 Código muerto | ≈20 exports internos muertos, 16 webMethods sin consumidor, módulo entero huérfano (`horario.web.js`), import dinámico roto (`backend/contabilidad`), 17 funciones muertas en `mmUtils`, 4 constantes muertas en `internalConfig`. |

---

## 1. HALLAZGOS DETALLADOS (verificados)

### FASE 1 — P0: Fiabilidad (arreglar antes de limpiar)

**H-01 · Import dinámico roto (bomba de humo).**
`eventLog.js:618` → `await import("backend/contabilidad")`, pero **no existe `src/backend/contabilidad.js`**. El fallo se captura, por lo que la proyección contable (`_proyectarAsientoContable`, llamada en `eventLog.js:600`) **falla silenciosamente siempre**. LibroAsientosContablesDetalle nunca recibe proyecciones automáticas.
→ **Decisión ADR requerida:** (a) eliminar el bloque y documentar que la contabilidad se delega al ledger fiscal existente, o (b) implementar el módulo. Recomendado: **(a)** (principio "código mínimo"; la partida doble ya se valida en hooks de `data.js`).

**H-02 · Suite de tests inexecutable.**
`node src/backend/tests/run-all.mjs` → `ERR_MODULE_NOT_FOUND: Cannot find package 'backend'` (los alias Wix `backend/*` y `public/*` no resuelven fuera del runtime Velo). `npm test` no existe en `package.json`. La suite E2E no puede correr en CI local.
→ Crear script `npm test` + resolver alias vía loader propio (`tests/loader.mjs` ya existe: auditarlo y conectarlo a `run-all.mjs` con `node --import`/`--loader`).

**H-03 · Dynamic imports como acoplamiento oculto.**
- `crons.js:144` → `await import("backend/cajas.web.js")` para `registerBookingPayment` (evita ciclo con eventLog; debe documentarse o extraerse a capa `ledgerWriter`).
- `citasManager.web.js:1424` → `await import(...)` para `_invalidateCachesInternal` (residuo: ya hay patrón de import estático en el mismo módulo).
- `horario.web.js:100` → `await import("backend/staff")` para `findStaff`.
→ Sustituir por imports estáticos donde no exista ciclo real; si existe, extraer la función compartida a un módulo hoja (p. ej. `booking/cacheInvalidation.js`).

### FASE 2 — P1: Exports muertos (superficie API inflada)

**H-10 · `reservas.web.js` — proxies/dead exports eliminables (~12 símbolos):**
`getServiceForBookingInternal` (0 refs), `_resolveAddonContextPublic` (0), `_getStaffDisplayNamePublic` (0), `_cleanExpiredDualSlotsInternal` (0), `invalidateCachesInternal` (webMethod sin consumidor), `resolveServiceId` (webMethod sin consumidor; sí se usa la variante `_Internal`), `resolveStaffForSlot` (webMethod sin consumidor). Los `_*Internal` con consumidores reales (bookingSaga, citasManager, crons) **se mantienen pero dejan de estar exportados innecesariamente si solo se usan intra-módulo**: `_mapServiceToDTO` (1 ref interna), `_mapServiceImport2ToUX` (1), `_toPublicService` (1) → quitar `export`.

**H-11 · `cajas.web.js`:** `executeLedgerWithBackoff` (0 refs), `_invalidateSecretCache` (0 refs externas) → desexportar/eliminar.

**H-12 · `security.js`:** `isKeyPersistentlyBlocked` (0), `requireStaffCollaborator` (0) → eliminar o consumir.

**H-13 · `responseUtils.js`:** `isSuccess` (0), `toWebMethodResult` (0); **`logger.js`:** `withLogging` (0); **`securityEngine.js`:** `buildStateHash` (0) → eliminar.

**H-14 · `inventario.web.js`:** `recordOnlineInventoryOrderInternal` / `recordOnlineInventoryRefundInternal` (solo refs internas) → desexportar. `validateFiscalConfig` (cajas) solo usado intra-módulo → desexportar.

### FASE 3 — P1: WebMethods sin consumidor (API pública muerta)

De 41 webMethods totales, **9 cero-consumidor** (verificado: 0 referencias fuera de su propio archivo de definición, incluyendo tests):

| Módulo | webMethods muertos | Acción |
|---|---|---|
| `horario.web.js` | calcularHorasTrabajadas, getResumenHoras, registrarAjusteHorario (+ resto del módulo) | **Ver H-20** |
| `citasManager.web.js` | rescheduleDualBookings, rescheduleExistingBooking | Riesgo medio: flujos de negocio con lógica interna viva (`revalidateExactAvailabilitySlot` sí se usa internamente). Verificar panel externo antes de retirar. |
| `cajas.web.js` | registerGiftCardSale, registerGiftCardRedemption | Página "TARJETAS REGALO" es stub → decidir feature flag o retirada conjunta. |
| `inventario.web.js` | generateInventoryClosing, listInventoryClosings | Sin UI → retirar o exponer vía controller. |

Nota de precisión (re-verificada): `confirmPayment`, `getHistorialFichajes`, `invalidateCachesInternal`, `resolveServiceId` y `resolveStaffForSlot` **sí tienen consumidores externos** (backend/tests), por lo que NO entran en la lista de retirada; solo los 9 anteriores son cero-referencia.

**H-20 · `horario.web.js` (586 LOC) está HUÉRFANO:** ningún frontend lo consume; `RegistrosHorariosStaff` sigue protegido append-only por hooks de `data.js` (RD 8/2019) y `validation.js` mantiene `assertRegistrosHorariosStaff`. → Candidato a **retirada total** (−586 LOC) salvo requisito funcional de fichajes; en ese caso, mover a rama `feature/timeclock` y restaurar cuando exista ZONA STAFF con UI de fichaje. Nota: `marianAdministrationController.js:102-104` ya tiene comentadas las acciones `staff.web` (módulo que tampoco existe) — coherente con retirada.

### FASE 4 — P1: Duplicados y espejos SSOT

**H-30 · `public/mmUtils.js` — 17 funciones muertas** (0 refs en producción y tests): `cleanGuid`, `isDateYmd`, `buildLocalDateRange`, `toMadridIsoZ`, `toUtcIsoZ`, `getMadridTime`, `getMadridMonthKey`, `madridOffsetMinutes`, `formatUtcOffset`, `toBoolean`, `booleanValue`, `numberOrZero`, `getReferenceIds`, `_maskTaxId`, `isPlainObject`, `CURRENCY_CONFIG`, `SITE` (este último solo 1 ref → evaluar). ≈250 LOC eliminables.
**H-31 · Espejos de config frontend-safe** (`SITE`, `SLOT_SEARCH`, `BOOKINGS_ADDON_CONFIG` en mmUtils duplican `internalConfig.js`): justificado porque páginas no pueden importar backend-no-web, **pero** deben blindarse: añadir test de paridad deep-equal mmUtils ↔ internalConfig (existe precedente: `crons.jobsConfigParity.test.mjs`). Alternativa limpia: mover estos valores a `public/widgetBridge`-style módulo compartido `shared/siteConfig.js` importable por ambos lados.
**H-32 · Helpers duplicados en páginas:** `normalizeAddOnIds` (Calendario 2.q39h6.js:222) y `_safeTrim` inline (ConfirmacionReserva.q5vps.js:140) duplican `public/mmUtils`. → Importar desde mmUtils.
**H-33 · `qrHelper.js`:** `generateVerifactuQrUrl` + alias `buildVerifactuQrUrl` (doble nombre mismo contrato) y `AEAT_VERIFACTU_ENDPOINTS`/`extractVerifactuData` sin consumidores. → Unificar a un único export canónico y retirar los otros.
**H-34 · `internalConfig.js`:** constantes muertas `TIPO_IMPOSITIVO_VALIDOS`, `ROL_BOOKINGS`, `POSITIVE_INVENTORY_MOVEMENT_TYPES`, `NEGATIVE_INVENTORY_MOVEMENT_TYPES` (0 refs incluso en tests) → eliminar.

### FASE 5 — P2: Frontend/páginas

**H-40 · 29 stubs de página** (0–10 líneas, boilerplate Wix "Hello World"): no aportan riesgo pero ensucian el grafo. Opción recomendada: **vaciar contenido y dejar archivo vacío** solo si la página existe en el editor Wix sin código; si la página no existe en el site, eliminar el archivo (requiere volcado del sitemap del editor — verificación manual). Prioridad baja.
**H-41 · Páginas duplicadas funcionales:** `Pagina de servicio 2.xnfr4.js` (383 LOC) vs `Página de servicio.af54v.js` (stub) — confirmar cuál sirve tráfico real desde el editor antes de retirar.
**H-42 · `marianAdministrationController.js`** referencia `"backend/staff.web"` en acciones comentadas (L102-104): limpiar comentarios obsoletos junto con H-20.

### FASE 6 — P2: Higiene profesional

- **H-50 · Changelogs masivos en cabeceras** (≈132 menciones legacy/EVE-xx/CM5-xx/R0-xx): informativos pero inflan LOC. → Migrar a `CHANGELOG.md` por módulo o a notas de commit; cabecera queda con: MODULE/VERSION/RESPONSIBILITY/DEPENDENCIES (plantilla fija).
- **H-51 · `permissions.json` y `jobs.config`**: validar sincronía con `crons.js` (ya hay test de paridad) y con permisos reales de webMethods tras retirar los muertos (Fase 3).
- **H-52 · ESLint**: `npm run lint` existe; asegurar CI lo ejecuta con regla `no-unused-vars` + `import/no-unused-modules` (o equivalente) para que la muerte de código no vuelva a acumularse.
- **H-53 · Convención de nombres:** prefijo `_` inconsistente entre exports públicos de utils (`_safeTrim` exportado vs `makeTraceId`); unificar: público sin `_`, privado con `_`.

---

## 2. PLAN EJECUTIVO (fases con orden de dependencia)

| Fase | Tarea | IDs | Estimación | Criterio de salida |
|---|---|---|---|---|
| **1. Fiabilidad** | Decidir e implementar H-01 (recomendado: eliminar proyección fantasma + ADR) | H-01 | 1 h | `_proyectarAsientoContable` no intenta importar módulo inexistente; log limpio |
| | Ejecutar suite con loader y añadir `npm test` | H-02 | 2 h | `npm test` verde en local/CI |
| | Normalizar dynamic imports | H-03 | 1 h | ≤1 dynamic import justificado y comentado |
| **2. Desexportar muertos** | reservas/cajas/security/responseUtils/logger/securityEngine/inventario | H-10…H-14 | 2 h | Sweep automático: 0 exports con 0 referencias |
| **3. Retirar API muerta** | WebMethods sin consumidor (con verificación manual de widgets/UI externa para confirmPayment/reschedule/giftCards) | FASE 3, H-20 | 3 h | Cada retirada con commit revertible; horario.web.js retirado o aislado |
| **4. Dedupe** | mmUtils −17 funcs; helpers de páginas → mmUtils; qrHelper unificación; internalConfig −4 consts; test de paridad espejos | H-30…H-34 | 3 h | 0 funciones duplicadas entre public/pages; test paridad mmUtils↔internalConfig en suite |
| **5. Frontend** | Stubs y páginas duplicadas | H-40…H-42 | 1 h (+ verificación manual editor Wix) | Grafo de páginas = páginas reales del site |
| **6. Higiene** | Cabeceras → CHANGELOG; lint en CI; convención nombres | H-50…H-53 | 2 h | `npm run lint` sin warnings; plantilla de cabecera única |

**Orden de despliegue sugerido:** internalConfig → responseUtils/logger → security → reservas.web → cajas.web → citasManager → eventLog/crons → pages/public.

## 3. Métricas objetivo (aceptación final)

- Grep de aceptación: 0 coincidencias de `suppressAuth|consistentRead|dataLegacyAdapter` en código ejecutable (ya cumplido hoy).
- 0 exports con 0 referencias (automatizado con script de sweep incluido en `tests/`).
- 0 imports dinámicos a módulos inexistentes.
- LOC backend: 20.356 → ≈17.500 (−14 %) sin pérdida funcional verificada (suite E2E 15 flujos verde).
- Suite ejecutable en CI (`npm test`) + parity tests (jobs.config, espejos de config).

## 4. Riesgos y salvaguardas

1. **confirmPayment / reschedule*** : posibles consumidores externos al repo (widgets HTML, automatizaciones Wix). No retirar sin checklist manual del editor + logs de acceso a webMethods 7 días.
2. **horario.web.js**: cumple RD 8/2019 vía data.js/validation.js aunque esté muerto el front; la retirada del módulo no elimina la protección legal (verificado).
3. Toda retirada se hace en commit atómico por módulo, con el plan de despliegue inverso disponible (git revert).
