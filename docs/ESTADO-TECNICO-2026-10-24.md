# Estado técnico y continuidad — 2026-10-24

## Estado del repositorio

- Repositorio: `nachoortegazgz/marianmadridXXXXX`.
- HEAD de `main` al actualizar esta nota: `1ad8bfb09bc1cb1a05deefac4c7144174794a220`.
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

- **Publicación Wix:** la API REST aceptó la publicación del estado guardado del Editor, pero la prueba de navegador no detectó el fallback de masterPage.js. La publicación REST no demuestra que el código de GitHub se haya transferido al runtime. Para publicar código del repositorio se requiere Wix CLI for Sites.
- **HTML embebido:** `src/pages/#html1.txt` es la fuente versionada, pero el contenido del componente HTML de Wix Editor no se sincroniza automáticamente desde GitHub. La corrección de estado de pago requiere copiar el contenido actualizado a `#html1` y probarlo en Preview/publicación.
- **CMS (producción):** verificados por API los esquemas e índices de `ControlOperativo`, `MovimientosCaja`, `CitasF2`, `HistoricoCierresZ`, `RegistrosHorariosStaff` y `MovimientosInventario`. `ControlOperativo` tiene `controlType`, `dedupeKey` y `traceId` obligatorios; `payload` es `OBJECT`; permisos de colección `ADMIN`; tres índices de usuario activos (`controlType+expiresAt`, `controlType+nextRetryAt`, `controlType+status`) y dos índices de sistema. La clave de idempotencia usa `_id` determinista; no hay índice único de `dedupeKey`. En `MovimientosCaja` están activos `transactionId_unique`, `idx_recordTimestamp`, `idx_sequenceNumber` e `idx_fechaExpedicion_sequenceNumber`; la cuota de índices personalizados de esta colección está completa.
- **Cambios CMS aplicados:** en `MovimientosCaja`, `baseImponibleOImporteNoSujeto` era un campo histórico marcado obligatorio pese a que el runtime persiste `taxBase`. Se cambió `required` a `false` mediante la API oficial, conservando campo y valores históricos. Revisión de colección: `60`. Se crearon dos índices no únicos y se verificaron en estado `ACTIVE`. No se alteraron registros.
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

- Las lecturas públicas del inicio no son consistentes y el navegador automatizado devuelve HTTP 200 y título SEO, pero un DOM visible vacío. No se considera validado el renderizado de la portada ni el comportamiento de redirección.
- El fallback está en masterPage.js y redirige solo la raíz a /reserva-online. La prueba real no lo detectó; la ejecución del preview CLI se bloqueó porque falta el secreto de repositorio WIX_CLI_API_KEY. No se considera desplegado en producción.
- La página legal pública contiene campos de plantilla sin completar (por ejemplo, NIF/CIF y datos de contacto de las condiciones). No se inventarán datos fiscales ni legales; deben completarse con información confirmada antes de declarar el sitio listo para producción.

### Estado de publicación

- El repositorio main ya contiene las correcciones aprobadas de identidad MapaStaff, validación fail-closed de complementos y fallback de portada.
- Se prepararon workflows de preview y publicación manual mediante Wix CLI for Sites. El preview omite su ejecución cuando falta WIX_CLI_API_KEY; el workflow de publicación exige esa clave y una confirmación explícita.
- La siguiente acción imprescindible es crear el secreto WIX_CLI_API_KEY con permiso Wix CLI for Sites - Git Integration, ejecutar el preview, verificarlo y luego ejecutar manualmente la publicación. Después hay que comprobar portada/calendario en navegador real, sincronizar #html1 y completar los campos legales.



## Publicación posterior a CI — 2026-10-24

- La petición oficial de publicación del sitio Wix se ejecutó correctamente después de que las suites de regresión, seguridad, calidad y smoke test de la rama principal aparecieran en verde.
- El smoke test público de GitHub pasó para la portada, el catálogo, una ficha de servicio y la ruta nativa /booking-calendar/rayos-v. El test comprueba respuesta HTTP/HTML, no interacción de navegador ni finalización de una reserva.
- La API de disponibilidad nativa confirma franjas reservables para Rayos V, Corte Clásico y Babylights en ventanas comprobadas. No se creó ninguna reserva real ni se dispararon pagos, notificaciones o movimientos de caja.
- La lectura web del inicio sigue afectada por caché y no ejecuta JavaScript. No se declara validado el comportamiento de redirección de Entrada ni el flujo completo hasta comprobarlo en navegador.
- La publicación no resuelve por sí sola los campos de plantilla legales ni la sincronización manual del contenido del componente HTML embebido.



## Bloqueo de sincronización del código Velo — 2026-10-24

- La prueba de preview con Wix CLI no pudo autenticarse porque no existe el secreto de repositorio WIX_CLI_API_KEY. No se intentó eludir esa restricción.
- El workflow de preview queda preparado para saltarse con advertencia cuando falta la clave; el workflow de publicación solo se ejecuta manualmente, después de confirmar PUBLISH y de pasar pruebas de Layer 1, Layer 2, suite completa y lint.
- Para desbloquearlo, crear en Wix API Keys Manager una clave con el permiso Wix CLI for Sites - Git Integration y guardarla en GitHub como secreto WIX_CLI_API_KEY.
- Hasta que el preview del código de GitHub se genere y se valide, no debe afirmarse que masterPage.js o el resto del código de main estén desplegados en el sitio real.
- No se ha creado ninguna reserva de prueba ni se han disparado pagos, notificaciones o movimientos de caja.

