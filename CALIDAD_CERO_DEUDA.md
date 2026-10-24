# ESTANDAR DE CALIDAD "CERO DEUDA" (v1.0 — 2026-10-20)

Objective: codigo con **cero alias, cero legacy, cero deprecated, cero muerto, cero obsoleto**.
Definido por el depurador tras analisis estatico del repo (`src/`, ~24.5k lineas JS).
Es un estandar operativo: cada regla tiene detector ejecutable y umbral de aprobado.

---

## 0. REVALIDACION DE HALLAZGOS — 2026-10-24

Verificacion contra el arbol actual de `main` y los cambios de esta rama:

- **H-01/H-02: cerrados**. Los dos archivos legacy ya no existen; `run-all.mjs` descubre suites `.test.mjs` y runners `.runner.mjs`.
- **H-03 a H-07: cerrados**. No se exportan los aliases de colecciones/record type, estados inactivos, numeracion fiscal ni `resolveNativeAddOnIds`.
- **H-08/H-10: cerrados en la superficie publica**. Los helpers retirados y `_normalizeAscii` no forman parte de los exports de `public/mmUtils.js`.
- **H-09: cierre preparado en esta rama**. `SITE` y `CURRENCY_CONFIG` siguen siendo constantes internas de `mmUtils.js`, pero dejan de exportarse al no tener consumidores externos verificados.
- Se añade `src/backend/tests/debt.zero.test.mjs` al runner canonico para impedir la reaparicion de los aliases retirados y de estos exports muertos.
- **H-11 sigue abierto**: condensar cabeceras historicas solo despues de verificar que el comentario no documenta un contrato vigente.
- **H-12: cerrado**. `audit.e2e.runner.mjs` importa directamente `runFullAudit` y ya no usa fallback de exports.
- Esta auditoria de exports no certifica el runtime Wix publicado ni la ausencia de deuda fuera de los simbolos listados.

---

## 1. DEFINICIONES OPERATIVAS (que cuenta como violacion)

### D-1 ALIAS (cero admitido en codigo productivo)
- **A1.1** Constante/enum duplicado que reexpone otro SSOT con nombre distinto
  (`COLLECTIONS = {...BUSINESS, ...OPERATIONAL}`, `RECORDTYPECONFIGSISTEMA`).
- **A1.2** Renombre de compatibilidad (`export const resolveNativeAddOnIds = resolveAddOnIds`).
- **A1.3** Rebinding local de nombres retirados (`const ESTADO_CITA = BOOKING_STATUS`),
  incluso en tests: debe usarse el nombre canonico o eliminarse la bateria antigua.
- **Excepcion documentada (no cuenta como violacion)**: objetos "espejo" frontend-safe
  entre `public/mmUtils.js` y `backend/internalConfig.js`, porque Velo no permite importar
  backend desde pages. Requisito: protocolo de sync declarado + test de paridad.

### D-2 LEGACY (cero rutas silenciosas)
- **L2.1** Lectura/aceptacion de campos o formatos antiguos sin fecha de retiro,
  metrica de consumo o marca de auditoria.
- **Permitido condicionalmente**: fallback de LECTURA sobre datos historicos inmutables
  (p. ej. `legacy-read` en fiscalAggregator) SIEMPRE QUE emita warn trazable y tenga
  plan de migracion. Un fallback de ESCRITURA o de AUTORIZACION es violacion P0.

### D-3 DEPRECATED (cero API marcada como tal vivas)
- **P3.1** Cualquier `@deprecated`, comentario "se conserva por compatibilidad" o
  parametro "no-op para compatibilidad" en superficie exportada = violacion.
  O se consume, o se elimina. No existe termino medio.

### D-4 CODIGO MUERTO (cero simbolos exportados sin consumidor verificable)
- **M4.1** Export sin referencias externas Y sin uso interno propio => eliminar.
- **M4.2** Rama logica inalcanzable (condicion siempre falsa, variable leida y jamas
  escrita, guard que nunca dispara) => eliminar rama.
- **M4.3** Funcion definida y nunca invocada (incluso privada `_x`) => eliminar.
- **M4.4** Test/archivo runner huerfano: no ejecutado por ningun runner canónico
  (`npm test`) ni referenciado => eliminar o integrar.
- Regla de decision: **solo cuentan consumidores dentro de `src/`**. Wix no resuelve
  imports magicos; un simbolo sin import explicito esta muerto. Si un HTML externo
  podria consumirlo, debe listarse en `README` del modulo; si no esta listado, es muerto.

### D-5 OBSOLETO (cero contratos zombis)
- **O5.1** Parametro aceptado e ignorado (no-op) en firma publica.
- **O5.2** Estado/valor enum definido pero sin transicion que lo produzca o consuma.
- **O5.3** Cometario/cabecera que describe comportamiento distinto del codigo
  (documentacion mentirosa) — peor que su ausencia.
- **O5.4** Versiones historicas en cabeceras (FASE4, v5010.1, CLEAN-xx...) que ya
  no describen el contrato vigente: condensar a "contrato actual + motivo".

---

## 2. CRITERIO DE APROBADO (Definition of Done)

El objetivo se declara ALCANZADO cuando se cumplen SIMULTANEAMENTE:

| # | Criterio | Detector | Umbral |
|---|----------|----------|--------|
| C1 | Alias A1.1/A1.2 fuera de espejos declarados | grep exports internalConfig sin uso externo | 0 |
| C2 | Deprecated P3.1 | `grep -rn "@deprecated\|por compatibilidad" src/backend src/public --include=*.js` (excl. comentarios historicos) | 0 |
| C3 | Muertos M4.1 | script de conteo de referencias por export | 0 |
| C4 | Runner huerfano M4.4 | todo archivo de test ejecutado por `run-all.mjs` o eliminado | 0 |
| C5 | Sintaxis | `node --check` / import exitoso de todos los modulos | 0 errores |
| C6 | Suite verde | `npm test` | fail=0, pass>=170 |
| C7 | Mojibake/no-ASCII | scan bytes >0x7F en comentarios | 0 |
| C8 | Contratos zombis O5.1/O5.2 | revision manual de firmas publicas | 0 |
| C9 | Legacy L2.1 sin traza | todo fallback lleva warn + ticket/batch job | 0 sin traza |

**Regla de oro anti-regresion**: ninguna eliminacion se ejecuta sin (a) grep de
consumidores en TODO `src/` incluyendo pages y tests, y (b) suite verde despues.
Ninguna regeneracion destructiva de archivo sin diff verificable contra base limpia.

**Caducidad obligatoria**: todo espejo/fallback legacy declarado debe llevar campo
`review-by` (fecha). Sin fecha = violacion automatica.


## 2B. CHECKPOINT FUNCIONAL POR CAPAS (2026-10-20)

Validado en GitHub Actions sobre el estado funcional actual:
- `npm test`: 182 pass / 0 fail (11 suites).
- `npm run test:layer1`: 130 pass / 0 fail (5 suites: reservas, concurrencia y núcleo compartido).
- `npm run test:layer2`: 72 pass / 0 fail (7 suites: ledger, caja, fiscalidad, DTO de recibo, cron y flujo integrado).

Correcciones funcionales verificadas en esta tanda:
- Consumo de token de visualización por eliminación atómica; el CMS ya permite retirar `DISPLAY_TOKEN` y mantiene `WEBHOOK_EVENT` append-only.
- Parser duplicado del caché de días eliminado y DTO público de servicio normalizado.
- `CAJA_KEYS` duplicado eliminado.
- `MovimientosCaja` guarda la huella canónica en `hash`; el DTO de recibo la proyecta como `recordHash`.
- Normalización de hash previa a la validación fiscal y rechazo explícito de campos contables legacy `debit/credit`.
- Hooks de CMS redundantes retirados en reservas/inventario; permanecen las validaciones de integridad del ledger, partida doble, horario y cancelación formal.

El resultado verde confirma las suites offline cubiertas; no equivale a una prueba de aceptación sobre el sitio Wix publicado. Los hallazgos estáticos H-01..H-13 que siguen debajo provienen de la auditoría previa y deben revalidarse sobre el commit actual antes de aplicar limpiezas adicionales.

---

## 3. HALLAZGOS ACTUALES (línea base auditada 2026-10-20)

Estado general: el Bloque A (sintaxis) y el grueso del Bloque B del plan previo YA
estan resueltos en el repo actual (`npm test`: 170 pass / 0 fail). La deuda restante
real detectada por este auditor:

### P0 — Ruptura funcional existente hoy
- **H-01** `src/backend/__tests__/unit.testRunner.js` importa `RESERVED_COLLECTIONS`,
  `ENTRY_STATUS`, `ACCOUNT_NATURE` que **ya no existen** en internalConfig → el modulo
  ni siquiera carga (SyntaxError). Es codigo muerto roto. Su bateria fue sustituida por
  `tests/unit.ssot.v5011.test.mjs` (16 tests equivalentes, verdes).
- **H-02** `src/backend/tests/unit.testRunner.runner.mjs` es wrapper huerfano: apunta al
  modulo roto de H-01 y **no se ejecuta** en `run-all.mjs` (no termina en `.test.mjs`).

### P1 — Alias/muertos en superficie exportada (criterios C1/C3)
- **H-03** `internalConfig.COLLECTIONS` (umbrella): 0 consumidores → eliminar.
- **H-04** `internalConfig.RECORDTYPECONFIGSISTEMA`: 0 consumidores → eliminar.
- **H-05** `internalConfig.INACTIVE_BOOKING_STATUSES`: 0 consumidores → eliminar.
- **H-06** `internalConfig.buildInvoiceNumber`: 0 consumidores → eliminar (si la
  numeracion fiscal se reimplementa, renace con su consumidor; no mantener "por si acaso").
- **H-07** `booking/bookingUtils.resolveNativeAddOnIds` (alias UTILS-10): 0 consumidores → eliminar.
- **H-08** mmUtils muertos M4.1 (0 refs externas, 0 usos internos): `getReferenceIds`,
  `cleanGuid`, `booleanValue`, `toBoolean`, `toMadridIsoLocal`, `formatUtcOffset`,
  `isPlainObject`, `buildLocalDateRange`, `getMadridTime`, `getMadridMonthKey` → eliminar.
- **H-09** mmUtils `SITE` y `CURRENCY_CONFIG`: exportados sin consumidor externo pero
  con uso interno → **des-exportar** (mantener como constantes internas del modulo).
- **H-10** mmUtils `_normalizeAscii`: 0 refs externas; usada internamente → des-exportar.

### P2 — Obsoletos/documentacion (criterios C7/C8/O5.4)
- **H-11** Cabeceras con historia de versiones (CLEAN-xx, FASE4, CRON-14, ALN-xx) que
  describen migraciones ya completadas: condensar a contrato vigente.
- **H-12** `audit.e2e.runner.mjs` usa patron `mod.A || mod.B || mod.C` defensivo sobre
  formas de modulo que ya no existen: simplificar al export real (`runFullAudit`).
- **H-13** Legitimos conservados (NO son violacion, registrar como debt con review-by):
  espejos mmUtils↔internalConfig (con test de paridad), fallbacks `legacy-read` de
  fiscalAggregator (warn activo), rama de lectura `meta.paymentMethod` pre-v10.4 en
  citasManager (fallback de lectura con traza).

### Verificaciones que dieron limpio (no accion)
- `suppressAuth:` en codigo: 0 (solo menciones en comentarios STANDARDS).
- `consistentRead` (API retirada): 0 usos reales.
- Mojibake (Ã¡/â€/Â ): 0 ocurrencias.
- MINUTOS_TOLERANCIA public/mmUtils = 120 = internalConfig (divergencia resuelta).
- `MapaStaff` como coleccion queryable: erradicada (solo STAFF.MAPA_STAFF como id).

---

## 4. PLAN DE EJECUCION DEL AUDITOR (orden seguro)

1. **FASE A (P0)**: eliminar H-01/H-02 (runner huérfano + bateria rota sustituida).
   Riesgo nulo: no entran en `npm test`; cobertura equivalente ya verde en v5011.
2. **FASE B (P1)**: eliminar H-03..H-07 (alias internos sin uso), con grep previo
   por simbolo y suite tras cada tanda.
3. **FASE C (P1)**: purga mmUtils H-08..H-10; verificar pages (Calendario, Zona
   Marian, Zona Staff, Confirmacion, Servicio 2) siguen importando solo vivos.
4. **FASE D (P2)**: condensar cabeceras H-11 y simplificar H-12.
5. **FASE E**: anadir test de guardia `debt.zero.test.mjs` que automatice C1-C4
   (exports sin consumidores = fallo) para evitar regresion.
6. **FUERA DE ALCANCE** (requiere decision de producto, no de limpieza): dividir
   reservas.web.js (B-4-6) y ventana de drenaje de pairToken UTC (B-10-1).

Metricas esperadas al cerrar: exports muertos backend+public: 0 · alias: 0 ·
runners huerfanos: 0 · npm test: >=170 pass / 0 fail + suite de guardia nueva.
