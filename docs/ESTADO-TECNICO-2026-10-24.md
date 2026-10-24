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

- **Publicación Wix:** tras la integración de las correcciones y CI verde, la petición oficial de publicación del sitio se completó correctamente. Esto confirma que Wix aceptó la operación de publicar; no demuestra por sí solo que el navegador ejecute todos los flujos como se espera.
- **HTML embebido:** `src/pages/#html1.txt` es la fuente versionada, pero el contenido del componente HTML de Wix Editor no se sincroniza automáticamente desde GitHub. La corrección de estado de pago requiere copiar el contenido actualizado a `#html1` y probarlo en Preview/publicación.
- **CMS:** lectura de producción completada sin escrituras. `ControlOperativo` contiene los campos `controlType`, `dedupeKey`, `traceId`, `status`, `expiresAt` y `payload`; la existencia de índices específicos todavía no se ha verificado.
- **Bookings:** todavía no se ha ejecutado una reserva real simple ni dual de extremo a extremo después de estos cambios. No se han creado reservas, ventas, pagos ni movimientos de prueba en ledgers productivos.
- **Contabilidad PGC:** sigue bloqueada hasta que la asesoría apruebe la matriz de cuentas y contrapartidas. No declarar contabilidad certificada.
- **Importe nativo de Bookings:** si el webhook no trae un importe fiable, se mantiene la marca de conciliación; no se inventa un precio.
- **Dependencias:** la última ejecución de Quality diagnostics reportó `npm audit: 0 vulnerabilidades` y `ESLint: 0 errores / 0 advertencias`. La higiene de dependencias sigue abierta: la instalación reporta peer dependency conflict de React y paquetes obsoletos (`inflight`, `rimraf@3`, `glob@7`, `eslint@8`). No se aplicó `--force` ni se actualizaron versiones Wix a ciegas.

## Siguiente secuencia segura

1. Reconciliar manualmente el contenido de `#html1` en Wix Editor con la fuente versionada y comprobar que el checkout no se presenta como confirmación.
2. Verificar en un navegador real que el código de `main` se ejecuta y que el fallback de la página Entrada se comporta correctamente; las herramientas de lectura web no ejecutan JS ni garantizan contenido sin caché.
3. Acordar una ventana de QA y usar datos de prueba autorizados para una reserva simple y una dual; verificar evento, `CitasF2`, `ControlOperativo`, idempotencia, cancelación, conciliación y checkout.
4. Revisar los hallazgos PGC con la asesoría antes de activar asientos contables.
5. Completar los campos legales de plantilla con datos confirmados.
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
- El campo schedule.lastSessionEnd de Corte Clásico devuelve 27-10-2026, pero la API de disponibilidad sí devuelve franjas reservables el 28-10-2026 y el 03-11-2026. Ese campo aislado no demuestra un límite efectivo de reservas y no se cambió la configuración. El 02-11 no devuelve franjas; el diagnóstico atribuye la causa a que el personal no trabaja ese lunes. El 03 y 04 sí devuelven franjas, por lo que no se declara un fallo sin confirmar primero el horario comercial previsto.

### Portada y páginas legales

- Las lecturas públicas del inicio no son consistentes: una captura reciente muestra «¡Nos vemos muy pronto!», mientras otra lectura cacheada muestra la portada con catálogo y llamada a reservar. No se da por verificado el estado visual actual hasta comprobarlo en navegador tras sincronizar/publicar.
- Se integró en GitHub un fallback Velo para que la página Entrada redirija a /reserva-online si se necesita evitar una portada vacía. Este código aún no está sincronizado ni publicado en Wix Editor, por lo que no debe considerarse activo en el dominio.
- La página legal pública contiene campos de plantilla sin completar (por ejemplo, NIF/CIF y datos de contacto de las condiciones). No se inventarán datos fiscales ni legales; deben completarse con información confirmada antes de declarar el sitio listo para producción.

### Estado de publicación

- El repositorio main ya contiene las correcciones aprobadas de identidad MapaStaff, validación fail-closed de complementos y fallback de portada.
- No hay un flujo de despliegue configurado en GitHub Actions. El código Velo de un sitio Wix Editor no se publica por el mero hecho de fusionar una PR.
- La siguiente acción técnica imprescindible es sincronizar los archivos Velo y #html1 en Wix Editor, publicar y repetir pruebas de navegador en el dominio real.



## Publicación posterior a CI — 2026-10-24

- La petición oficial de publicación del sitio Wix se ejecutó correctamente después de que las suites de regresión, seguridad, calidad y smoke test de la rama principal aparecieran en verde.
- El smoke test público de GitHub pasó para la portada, el catálogo, una ficha de servicio y la ruta nativa /booking-calendar/rayos-v. El test comprueba respuesta HTTP/HTML, no interacción de navegador ni finalización de una reserva.
- La API de disponibilidad nativa confirma franjas reservables para Rayos V, Corte Clásico y Babylights en ventanas comprobadas. No se creó ninguna reserva real ni se dispararon pagos, notificaciones o movimientos de caja.
- La lectura web del inicio sigue afectada por caché y no ejecuta JavaScript. No se declara validado el comportamiento de redirección de Entrada ni el flujo completo hasta comprobarlo en navegador.
- La publicación no resuelve por sí sola los campos de plantilla legales ni la sincronización manual del contenido del componente HTML embebido.

