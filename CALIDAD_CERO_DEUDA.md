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
- **H-09: cerrado**. `SITE` y `CURRENCY_CONFIG` siguen siendo constantes internas de `mmUtils.js`, pero ya no se exportan; `debt.zero.test.mjs` protege la superficie pública.
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

## 3. ESTADO RECONCILIADO DE HALLAZGOS — 2026-10-25

Esta sección sustituye el inventario histórico del 2026-10-20. Los hallazgos originales se conservan como trazabilidad en Git, pero no deben ejecutarse de nuevo como una lista de cambios pendientes.

### Cerrados y protegidos por regresión

- **H-01/H-02 — runner legado y wrapper huérfano:** cerrados. Ambos archivos ya no existen. La batería se sustituyó por `src/backend/tests/unit.ssot.v5011.test.mjs`; el runner canónico descubre `.test.mjs` y `.runner.mjs`.
- **H-03/H-04/H-05/H-06 — aliases retirados de `internalConfig`:** cerrados. `debt.zero.test.mjs` verifica que `COLLECTIONS`, `RECORDTYPECONFIGSISTEMA`, `INACTIVE_BOOKING_STATUSES` y `buildInvoiceNumber` no reaparezcan.
- **H-07 — alias `resolveNativeAddOnIds` / `resolveAddOnIds`:** cerrado; la prueba de deuda comprueba su ausencia.
- **H-08/H-09/H-10 — exports muertos de `public/mmUtils.js`:** cerrados en la superficie pública. Los helpers sin consumidores se retiraron; `SITE` y `CURRENCY_CONFIG` permanecen privados por su uso interno; `_normalizeAscii` no se exporta. La prueba de deuda protege estos límites.
- **H-12 — fallback de exports en `audit.e2e.runner.mjs`:** cerrado; el runner importa directamente `runFullAudit`.

### Pendiente real

- **H-11 — cabeceras y comentarios históricos:** abierto. El trabajo consiste en inspeccionar y condensar únicamente texto que contradiga el contrato vigente o describa una migración ya completada. No cambiar lógica funcional ni eliminar trazabilidad necesaria; cada archivo requiere diff pequeño y revisión.

### Deuda aceptada, no código muerto

- **H-13 — espejos frontend/backend:** se mantienen por la limitación de imports de Velo y requieren test de paridad.
- **H-13 — lecturas históricas de datos:** los fallbacks `legacy-read` de `fiscalAggregator` y `meta.paymentMethod` en `citasManager` solo se conservan mientras estén respaldados por evidencia, advertencia/traza y plan de retirada. No convertirlos en fallback de escritura ni autorización.

### Verificaciones previas sin acción destructiva

- No se debe retirar `backend/dataAccess.js` ni sus helpers por parecer genéricos: cada consumidor debe rastrearse antes de decidir.
- Las pruebas que bloquean aliases, campos sensibles, colecciones espejo o contratos de seguridad son guardias válidas mientras no exista una protección equivalente demostrada.
- La suite offline no certifica el runtime Wix publicado ni una reserva real de extremo a extremo.

---

## 4. SIGUIENTE PLAN DE AUDITORÍA

1. **Inventario reproducible:** enumerar exports, imports, llamadas, runners, scripts y workflows; distinguir producción, pruebas, diagnóstico y herramientas de una sola ejecución.
2. **Clasificar evidencia:** cada candidato debe incluir ruta, consumidores, prueba de ausencia/duplicación y sustituto verificable si se propone retirar un test o diagnóstico.
3. **Cambios mínimos por tanda:** una familia de símbolos o archivos por commit; nunca borrar módulos completos por una búsqueda textual aislada.
4. **Validación por tanda:** búsqueda global de consumidores, `npm test`, lint y gates aplicables. Si el entorno local o CI no está disponible, declarar la validación pendiente en vez de inferir éxito.
5. **Producción Wix:** solo tras revisar el diff, confirmar CI y validar el comportamiento afectado. No publicar por el mero hecho de que el cambio sea pequeño.

**Criterio de cierre:** cero símbolos sin consumidor y cero redundancias demostradas, manteniendo las protecciones necesarias de seguridad, integridad fiscal, reservas duales, idempotencia y minimización del DTO. La reducción de líneas no es por sí sola una mejora.
