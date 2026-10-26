# Estado técnico y continuidad — 2026-10-26

## Estado de código

- Repositorio de referencia: `nachoortegazgz/marianmadridXXXXX`.
- Las correcciones de identidad CMS, el HTML canónico de detalle de servicio, la resolución de `CitasF2.catalogId` y la precedencia de `scheduleId` nativo del slot están integradas en `main`.
- Línea base histórica (commit `8788f44d1c3d4b595d408df8b48c55440186d663`): **36 suites, 315 pruebas aprobadas, 0 fallos**. No representa el estado posterior a las migraciones de octubre 26.
- Estado actual tras PR #205–#207: la ejecución del commit `59a75ab...` reportó 315 aprobadas y 5 fallidas; las fallas se localizaron en el ledger fiscal/caja y en el cierre Z.
- Correcciones candidatas en PR #210 (head `04a5b17...`): la suite general de seguridad/regresión y Layer 2 ya pasan; Layer 1, Booking regression, Validate, Quality diagnostics y Wix Preview siguen pendientes en el corte actual. No declarar cierre hasta que finalicen.
- La comprobación de calidad histórica (lint y `npm audit`) no sustituye una ejecución sobre el head actual.
- Los tests y el smoke test público no equivalen a una reserva real de extremo a extremo.

## Corte de migración y pruebas — 2026-10-26

- PR #204 integró el flujo de pagos de reservas con Cart V2; PR #205 y PR #206 están fusionados; PR #207 está fusionado con correcciones del enum de inventario y del mock SDK.
- PR #210 propone completar el contrato fiscal de los movimientos de caja y el `traceId` del cierre Z. No modificar producción hasta que sus gates estén verdes.
- El fallo de Wix Preview observado en la ejecución anterior fue `PUBLISH_PIPELINE_TASK_NOT_FOUND` con timeout. El siguiente run debe confirmar si el problema persiste; un fallo de la infraestructura de Preview no prueba por sí solo un defecto de código, pero impide acreditar el despliegue de QA.
- La migración no se considera terminada hasta verificar el flujo reserva → Cart V2 → pago → sincronización posterior en un sitio Wix QA aislado.

## Verificación de producción realizada en solo lectura

### Identidad y catálogo

- Los 3 registros de `MapaStaff` consultados concuerdan con los perfiles de personal y recursos nativos de Wix Bookings.
- Los 3 `MapaStaff.scheduleId` coinciden con el `eventsSchedule.id` de sus recursos nativos.
- Los 94 `serviceId` del catálogo de servicios coinciden con 94 servicios nativos de Bookings; no se detectaron IDs sin correspondencia.
- Los 94 servicios con `serviceId` tienen exactamente las tres referencias esperadas de personal en `ServiciosCatalogo.staffMembers`.
- `ServiciosCatalogo`, `ComplementosCatalogo`, `CitasF2` y `MapaStaff` mantienen permisos CMS `ADMIN` para lectura, inserción, actualización y borrado.

### Disponibilidad nativa

- La API de Wix devolvió 10 franjas reservables para una consulta de prueba de solo lectura con `serviceId`, fecha, ubicación y filtro `resourceId`.
- En la respuesta real, el recurso aparece en `availableResources[].resources[].id`; el helper del repositorio lee ese campo.
- El `scheduleId` de una franja es el calendario de la franja devuelta por Bookings. Debe conservarse el `scheduleId` nativo del slot. No debe reemplazarse por el `MapaStaff.scheduleId` del recurso sin un motivo contractual.
- No se creó ninguna reserva, pago ni movimiento de caja para esta comprobación.

### Corrección de `CitasF2.catalogId`

- Se identificaron 3 reservas nativas confirmadas cuyo `catalogId` contenía por error el `serviceId` externo.
- Se corrigió el escritor para resolver `catalogId` como `ServiciosCatalogo._id`, sin fallback a `serviceId`.
- Se actualizaron condicionalmente solo esos 3 campos `catalogId` en CMS; una lectura posterior confirmó los 3 enlaces canónicos y que `serviceId`, `resourceId`, `scheduleId` y `bookingStatus` no cambiaron.
- Un registro con identificador sintético de QA no se modificó.
- Los 3 `scheduleId` de las reservas reales coinciden con el `bookedEntity.slot.scheduleId` de sus reservas nativas. No se realizó ni se propone migración de esos valores.

## Bloqueos que impiden declarar producción validada

1. **Wix CLI Preview pendiente de validación:** el secreto `CLI_API_KEY` está presente y `wix login` confirma la cuenta. El selector interactivo ya funciona en GitHub Actions. Un intento eligió por error `Latest commit from the default branch` y Wix devolvió `UNSUPPORTED_GITHUB_FILES` para `src/pages/#html1.txt`, `#html2.txt` y `#htmlWidgetCustomService.txt` (request ID `1793006801.395614981831462`). Se corrigió la detección para elegir `Local code`; esa selección sí se confirma, pero el CLI permanece en `Creating preview deployment...` sin URL ni error durante 120 s. El workflow amplía ahora la espera a 300 s y conserva un timeout total de 10 minutos. No se acepta Preview hasta obtener una URL `wix.to` verificable; no se publica en producción.
2. **HTML embebido:** el usuario confirma que `#html1`, `#html2` y `#htmlWidgetCustomService` ya están alineados con las fuentes de `/src/pages`. No repetir la tarea de copia ni modificar esos widgets. Tras desbloquear Preview, queda validar visualmente renderizado y handshake en el runtime.
3. **Pruebas de reserva reales:** todavía falta una prueba autorizada de una reserva simple y otra dual en un entorno seguro, incluyendo eventos, ledger, idempotencia, cancelación y checkout. No crear reservas productivas solo para completar una prueba.
4. **Datos legales:** no completar NIF/CIF, domicilio fiscal ni datos legales con valores inventados. Se necesitan datos confirmados del negocio.
5. **Contabilidad PGC:** no declarar el subsistema contable certificado ni activar asientos hasta que la asesoría apruebe cuentas y contrapartidas.

## Siguiente secuencia segura

1. Completar la ejecución del workflow del PR #202 con la selección `Local code` y el nuevo límite de 300 s. Si la creación remota sigue colgada, detener los experimentos de TTY y validar Preview desde un terminal interactivo Wix o escalar el error con el log exacto.
2. Abrir la URL generada y comprobar portada, calendario, detalle de servicio y handshake/renderizado de `#html1`, `#html2` y `#htmlWidgetCustomService`. El usuario confirma que las fuentes HTML ya están alineadas; no repetir su copia.
3. Tras validar Preview, fusionar el cambio de workflow a `main` y ejecutar una publicación Wix controlada solo con confirmación explícita y punto de rollback.
4. Comprobar en navegador real el runtime publicado, incluida portada, calendario y navegación a reserva.
5. Ejecutar QA simple y dual en un entorno/datos autorizados y conciliar cada reserva con `CitasF2` y `ControlOperativo`.
6. Completar datos legales confirmados y aprobar matriz PGC antes de cerrar el proyecto.

**Estado de CI actualizado:** el último commit con resultados completos pasó 317 pruebas de backend/seguridad, regresiones, diagnóstico y smoke test público. La selección de `Local code` está demostrada en logs; el despliegue remoto de Preview aún no ha devuelto URL. La nueva ejecución amplía el plazo a 300 s. **Criterio de cierre:** CI verde y disponibilidad nativa confirmada son necesarios, pero no prueban que el HTML del Editor esté sincronizado ni que la creación de reservas, el checkout y la conciliación funcionen de extremo a extremo en producción.
