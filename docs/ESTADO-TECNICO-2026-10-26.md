# Estado técnico y continuidad — 2026-10-26

## Estado de código

- Repositorio de referencia: `nachoortegazgz/marianmadridXXXXX`.
- Las correcciones de identidad CMS, el HTML canónico de detalle de servicio, la resolución de `CitasF2.catalogId` y la precedencia de `scheduleId` nativo del slot están integradas en `main`.
- Última regresión completa revisada en CI sobre `main` (`8788f44d1c3d4b595d408df8b48c55440186d663`): **36 suites, 315 pruebas aprobadas, 0 fallos**.
- Validación de lint: 0 errores / 0 advertencias. `npm audit`: 0 vulnerabilidades en la última ejecución de diagnóstico.
- Los tests y el smoke test público no equivalen a una reserva real de extremo a extremo.

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

1. **Wix CLI Preview pendiente de validación:** el secreto de GitHub `CLI_API_KEY` está presente y la autenticación se había completado correctamente. El fallo reproducido era la selección interactiva de fuente en `wix preview` (`NonInteractiveTerminal` / `Raw mode is not supported`). El PR #198 añade un pseudo-terminal y selecciona explícitamente `Local code`, además de exigir que el CLI termine sin error y emita una URL `wix.to`. La corrección sigue pendiente hasta que el workflow termine con éxito y se inspeccione la URL generada; no se afirma aún que `main` esté desplegado en Wix.
2. **HTML embebido:** el usuario confirma que `#html1`, `#html2` y `#htmlWidgetCustomService` ya están alineados con las fuentes de `/src/pages`. No repetir la tarea de copia ni modificar esos widgets. Tras desbloquear Preview, queda validar visualmente renderizado y handshake en el runtime.
3. **Pruebas de reserva reales:** todavía falta una prueba autorizada de una reserva simple y otra dual en un entorno seguro, incluyendo eventos, ledger, idempotencia, cancelación y checkout. No crear reservas productivas solo para completar una prueba.
4. **Datos legales:** no completar NIF/CIF, domicilio fiscal ni datos legales con valores inventados. Se necesitan datos confirmados del negocio.
5. **Contabilidad PGC:** no declarar el subsistema contable certificado ni activar asientos hasta que la asesoría apruebe cuentas y contrapartidas.

## Siguiente secuencia segura

1. Esperar a que el workflow del PR #198 termine; aceptar la corrección solo si `wix preview` termina correctamente y produce una URL de Preview verificable. Si falla, corregir según los logs antes de fusionar.
2. Abrir la URL generada y comprobar portada, calendario, detalle de servicio y handshake/renderizado de `#html1`, `#html2` y `#htmlWidgetCustomService`. El usuario confirma que las fuentes HTML ya están alineadas; no repetir su copia.
3. Tras validar Preview, fusionar el cambio de workflow a `main` y ejecutar una publicación Wix controlada solo con confirmación explícita y punto de rollback.
4. Comprobar en navegador real el runtime publicado, incluida portada, calendario y navegación a reserva.
5. Ejecutar QA simple y dual en un entorno/datos autorizados y conciliar cada reserva con `CitasF2` y `ControlOperativo`.
6. Completar datos legales confirmados y aprobar matriz PGC antes de cerrar el proyecto.

**Estado de CI actualizado:** los workflows de regresión, seguridad, validación y smoke test público pasaron en el commit `8788f44d1c3d4b595d408df8b48c55440186d663`; Wix CLI Preview sigue fallando por interactividad del CLI. **Criterio de cierre:** CI verde y disponibilidad nativa confirmada son necesarios, pero no prueban que el HTML del Editor esté sincronizado ni que la creación de reservas, el checkout y la conciliación funcionen de extremo a extremo en producción.
