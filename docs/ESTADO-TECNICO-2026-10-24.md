# Estado técnico y continuidad — 2026-10-24

## Estado del repositorio

- Repositorio: `nachoortegazgz/marianmadridXXXXX`.
- HEAD de `main` al redactar esta nota: `db96c2e9d8a188679c66424c6a19b520b6cc5465`.
- Las siguientes PR se integraron después de la línea base documentada el 23-10-2026: #130, #131, #132, #133, #134, #135, #137 y #138.
- Las siete gates de GitHub Actions pasaron en cada HEAD revisado de esas PR: Layer 1, Layer 2, booking regression, backend security/regression, quality diagnostics, public-site smoke test y Validate.
- Los tests son principalmente offline/mocks; el smoke test público valida rutas, no una reserva real de extremo a extremo.

## Cambios funcionales integrados

1. **Seguridad y rate limiting**
   - Los bloqueos persistentes se guardan en `ControlOperativo` con `controlType=RATE_LIMIT`, no en una colección paralela.
   - Los intentos rechazados contribuyen al umbral de escalado.
   - Las claves persistidas se derivan con SHA-256; no se escriben directamente identificadores de visitante en la clave CMS.
   - La limpieza programada elimina registros `RATE_LIMIT` caducados.

2. **Webhooks e idempotencia**
   - Los errores de lectura/proyección en cancelaciones se propagan; el handler no devuelve un falso `OK` cuando la reconciliación falla.
   - La consulta y persistencia de marcadores de webhook usan el mismo límite de normalización de ID.
   - Se añadieron handlers para reservas nativas creadas, actualizadas y reprogramadas.
   - Las reprogramaciones nativas que cambian una sola fase de una reserva dual no mutan unilateralmente el par: generan una tarea `RECONCILIATION`. Antes de crearla, se vuelve a leer `CitasF2` para reducir falsos positivos por carrera con la saga.

3. **Frontend de reservas**
   - El código versionado distingue `requiresPayment=true` de una reserva confirmada.
   - Si falta la URL de checkout, el widget no muestra confirmación ni invita a repetir ciegamente la solicitud.
   - Se añadió una prueba de contrato del widget.

4. **Deuda técnica**
   - `SITE` y `CURRENCY_CONFIG` permanecen como constantes internas de `public/mmUtils.js`, sin exports públicos.
   - `debt.zero.test.mjs` impide que vuelvan varios aliases y exports retirados.
   - La limpieza de cabeceras históricas (H-11 en `CALIDAD_CERO_DEUDA.md`) sigue pendiente.

## Bloqueos de validación en producción

- **No se ha publicado código en Wix durante esta intervención.** El contexto Wix reportaba el sitio como Published, pero no se verificó igualdad byte a byte entre el runtime publicado y el HEAD actual de GitHub.
- **HTML embebido:** `src/pages/#html1.txt` es la fuente versionada, pero el contenido del componente HTML de Wix Editor no se sincroniza automáticamente desde GitHub. La corrección de estado de pago requiere copiar el contenido actualizado a `#html1` y probarlo en Preview/publicación.
- **CMS:** queda por confirmar en el CMS vivo que `ControlOperativo` contiene y tiene indexados los campos usados por el contrato de bloqueos: `controlType`, `dedupeKey`, `status`, `expiresAt`, `payload` y `traceId`. La consulta de esquema mediante la herramienta de sitio fue bloqueada por controles de seguridad; no se intentó eludir esa restricción.
- **Bookings:** todavía no se ha ejecutado una reserva real simple ni dual de extremo a extremo después de estos cambios. No se han creado reservas, ventas, pagos ni movimientos de prueba en ledgers productivos.
- **Contabilidad PGC:** sigue bloqueada hasta que la asesoría apruebe la matriz de cuentas y contrapartidas. No declarar contabilidad certificada.
- **Importe nativo de Bookings:** si el webhook no trae un importe fiable, se mantiene la marca de conciliación; no se inventa un precio.
- **Dependencias:** la auditoría de vulnerabilidades sigue abierta; no se aplicó `--force` ni se actualizaron versiones Wix a ciegas.

## Siguiente secuencia segura

1. Aplicar manualmente el HTML actualizado a `#html1` en Wix Editor y comprobar que el checkout no se presenta como confirmación.
2. Verificar el esquema/índices reales de `ControlOperativo` en Wix sin escribir datos productivos.
3. Desplegar el backend actualizado en Wix y verificar que los handlers nativos quedan activos.
4. Acordar una ventana de QA y usar datos de prueba autorizados para una reserva simple y una dual; verificar evento, `CitasF2`, `ControlOperativo`, idempotencia, cancelación, conciliación y checkout.
5. Revisar los hallazgos PGC con la asesoría antes de activar asientos contables.
6. Continuar la limpieza de cabeceras solo después de confirmar que describen historia y no contratos vigentes.

**Criterio de cierre:** CI verde es condición necesaria, no prueba de aceptación del runtime Wix ni certificación fiscal.
