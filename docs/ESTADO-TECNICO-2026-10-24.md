# Estado técnico y continuidad — 2026-10-24

## Estado del repositorio

- Repositorio: `nachoortegazgz/marianmadridXXXXX`.
- HEAD de `main` al actualizar esta nota: `4b372b4822192071fe29896f0e3185fe14e3fe0f`.
- Las siguientes PR se integraron después de la línea base documentada el 23-10-2026: #130, #131, #132, #133, #134, #135, #137, #138, #139, #140, #141, #143, #144 y #146.
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
   - Las marcas `LEDGER_IDEMPOTENCY` pasan a `COMMITTED` tras persistir el movimiento fiscal; los reintentos reparan marcas `RESERVED` obsoletas sin duplicar el ledger.
   - El cron de compensaciones despacha también el `kind` de nivel raíz que emite el productor y tiene un procesador específico para reparar claims de idempotencia.
   - La referencia al movimiento asociada a claims/compensaciones se guarda en `ControlOperativo.payload.movementId`, no como campo raíz no documentado.

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
- **CMS:** lectura de producción completada sin escrituras. `ControlOperativo` contiene los campos `controlType`, `dedupeKey`, `traceId`, `status`, `expiresAt` y `payload`; la existencia de índices específicos todavía no se ha verificado.
- **Bookings:** todavía no se ha ejecutado una reserva real simple ni dual de extremo a extremo después de estos cambios. No se han creado reservas, ventas, pagos ni movimientos de prueba en ledgers productivos.
- **Contabilidad PGC:** sigue bloqueada hasta que la asesoría apruebe la matriz de cuentas y contrapartidas. No declarar contabilidad certificada.
- **Importe nativo de Bookings:** si el webhook no trae un importe fiable, se mantiene la marca de conciliación; no se inventa un precio.
- **Dependencias:** la última ejecución de Quality diagnostics reportó `npm audit: 0 vulnerabilidades` y `ESLint: 0 errores / 0 advertencias`. La higiene de dependencias sigue abierta: la instalación reporta peer dependency conflict de React y paquetes obsoletos (`inflight`, `rimraf@3`, `glob@7`, `eslint@8`). No se aplicó `--force` ni se actualizaron versiones Wix a ciegas.

## Siguiente secuencia segura

1. Aplicar manualmente el HTML actualizado a `#html1` en Wix Editor y comprobar que el checkout no se presenta como confirmación.
2. Verificar el esquema/índices reales de `ControlOperativo` en Wix sin escribir datos productivos.
3. Desplegar el backend actualizado en Wix y verificar que los handlers nativos quedan activos.
4. Acordar una ventana de QA y usar datos de prueba autorizados para una reserva simple y una dual; verificar evento, `CitasF2`, `ControlOperativo`, idempotencia, cancelación, conciliación y checkout.
5. Revisar los hallazgos PGC con la asesoría antes de activar asientos contables.
6. Continuar la limpieza de cabeceras solo después de confirmar que describen historia y no contratos vigentes.

**Criterio de cierre:** CI verde es condición necesaria, no prueba de aceptación del runtime Wix ni certificación fiscal.


## Validación adicional de producción — 2026-10-24

### CMS y personal

- MapaStaff está creado en producción y contiene tres registros: Marian, Andrea y Alba.
- Los tres registros tienen resourceId, staffMemberId, wixStaffMemberId, memberId, scheduleId y rolWebsite informados.
- El esquema vivo describe staffMemberId como el identificador nativo canónico de Bookings. wixStaffMemberId también existe y, en los tres registros consultados, tiene el mismo valor. El runtime y la documentación se alinearon con esta evidencia sin borrar campos ni modificar registros.
- ControlOperativo tiene en producción los campos esenciales de bloqueos e idempotencia consultados. No se crearon datos de prueba ni se modificó la colección.

### Bookings real (solo lectura)

- Wix Bookings devuelve franjas marcadas como reservables para Rayos V y Corte Clásico el 26-10-2026 entre las 09:00 y las 10:00, zona Europe/Madrid.
- Ambos servicios están visibles y tienen la reserva online habilitada.
- No se creó una reserva real, pago ni movimiento de caja. Por tanto, esta comprobación valida el catálogo y la disponibilidad nativa, no el flujo completo de confirmación/checkout.
- Corte Clásico declara actualmente una ventana de servicio que termina el 27-10-2026. Hay que confirmar si ese límite es intencional antes de extenderlo; no se cambió la configuración.

### Portada y páginas legales

- Las lecturas públicas del inicio no son consistentes: una captura reciente muestra «¡Nos vemos muy pronto!», mientras otra lectura cacheada muestra la portada con catálogo y llamada a reservar. No se da por verificado el estado visual actual hasta comprobarlo en navegador tras sincronizar/publicar.
- Se integró en GitHub un fallback Velo para que la página Entrada redirija a /reserva-online si se necesita evitar una portada vacía. Este código aún no está sincronizado ni publicado en Wix Editor, por lo que no debe considerarse activo en el dominio.
- La página legal pública contiene campos de plantilla sin completar (por ejemplo, NIF/CIF y datos de contacto de las condiciones). No se inventarán datos fiscales ni legales; deben completarse con información confirmada antes de declarar el sitio listo para producción.

### Estado de publicación

- El repositorio main ya contiene las correcciones aprobadas de identidad MapaStaff, validación fail-closed de complementos y fallback de portada.
- No hay un flujo de despliegue configurado en GitHub Actions. El código Velo de un sitio Wix Editor no se publica por el mero hecho de fusionar una PR.
- La siguiente acción técnica imprescindible es sincronizar los archivos Velo y #html1 en Wix Editor, publicar y repetir pruebas de navegador en el dominio real.

