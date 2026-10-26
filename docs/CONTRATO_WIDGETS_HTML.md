# Contrato de integración de widgets HTML de reservas

Este documento fija el contrato entre los widgets HTML del Editor Wix y el frontend Velo del repositorio. Los HTML completos están versionados en `src/pages/#html1.txt`, `src/pages/#html2.txt` y `src/pages/#htmlWidgetCustomService.txt`; cualquier cambio debe reflejarse en su fuente correspondiente y luego aplicarse por separado en el Editor Wix, que no se sincroniza automáticamente con GitHub.

## Detalle del servicio: `#htmlWidgetCustomService` ↔ `src/pages/#htmlWidgetCustomService.txt`

- Fuente canónica reconstruida el 2026-10-26 a partir del contrato del frontend `src/pages/Pagina de servicio 2.xnfr4.js`; antes no había un HTML versionado con ese nombre.
- Protocolo común: `MM_READY` / `MM_CONTEXT` / `MM_BOOK` / `MM_NAV`, con `version: 1`, `messageId`, `bridgeId` y `payload`, compatible con `src/public/widgetBridge.js`.
- El bridge se registra antes de consultar `getAppPageData()`; el widget puede emitir `MM_READY` nada más cargar y no debe perderse durante una espera de Wix.
- Presupuestos alineados: handshake bridge 55 s; timeout por intento de lectura del servicio 35 s (3 intentos como máximo, pausas de 500/1000 ms); lectura de contexto bridge 155 s; contexto HTML 165 s; aviso de respuesta de `MM_BOOK` 60 s.
- El widget reintenta `MM_READY` hasta 9 intentos con backoff exponencial de 500 ms y tope de 8 s. Las lecturas transitorias del servicio se reintentan hasta 3 veces, con timeout de 35 s por intento y pausas exponenciales de 500/1000 ms. El backend conserva el timeout de vigilancia de 15 s por consulta CMS y expone los timeouts transitorios con un código que el frontend reconoce. En el widget de calendario, las lecturas de disponibilidad tienen un límite de 60 s por intento; el HTML espera 65 s y permite hasta 3 intentos con pausas exponenciales de 500/1000 ms. Las operaciones de creación de reserva no se repiten automáticamente.
- `MM_BOOK` no se reenvía automáticamente: puede iniciar una compra o navegación y un reintento ciego podría duplicar una operación. Ante timeout se informa al cliente que no vuelva a pulsar hasta verificar el estado.
- Si no llega el contexto, se muestra un error recuperable con texto que no afirma que la reserva haya sido confirmada.
- El HTML presenta el servicio o bono, complementos opcionales y recomendaciones usando `textContent`; no inserta textos del CMS con `innerHTML`.
- La acción `MM_BOOK` solo envía `addOnIds`; no selecciona ni transmite `resourceId`, nombre de profesional ni identificadores internos de personal. Velo resuelve la reserva o la compra.
- `catalogEntryType` admite `SERVICE` y `PRICING_PLAN`; la acción principal respeta `primaryActionLabel` cuando se proporciona.
- **Sincronización del Editor:** el usuario confirmó el 2026-10-26 que los tres componentes HTML estaban sincronizados y actualizados. Los cambios posteriores incluidos en el PR #202 deben volver a sincronizarse en Wix solo después de aceptar esa revisión; la confirmación de sincronización no sustituye la validación de handshake y renderizado en Preview.

## Calendario: `#html1` ↔ `src/pages/Calendario de reservas 2.q39h6.js`

- Mensajes con `version`, `type`, `messageId`, `bridgeId` y `payload`, compatibles con `public/widgetBridge.js`.
- El widget nunca elige profesional: enviar `resourceId: null`; ignorar cualquier selector de personal.
- Las preferencias del cliente salen del HTML como `preferences`; Velo las normaliza a `appointmentNote` (máximo 200 caracteres).
- La reserva se procesa exclusivamente mediante `processDualBooking`; no sustituir el flujo dual por dos reservas independientes.
- No confirmar ni asignar si el backend devuelve un error de disponibilidad/asignación.
- Si `requiresPayment === true`, mostrar «Pago pendiente» y seguir al checkout; no presentar la reserva como confirmada ni abrir el lightbox de confirmación. Si falta `checkoutUrl`, impedir reintentos ciegos y pedir contacto con el salón.
- Velo debe validar el origen lógico, el tipo de mensaje y el payload. No confiar en datos de reserva enviados por el cliente.

## Confirmación: `#lightbox1` / `ConfirmacionReserva` → `#html2`

Velo es responsable de recuperar/normalizar el contexto y enviar al widget una lista permitida de campos. El HTML inicia el intercambio mediante un origen padre resuelto y validado; nunca se debe usar el comodín `"*"`:

```js
if (PARENT_ORIGIN && isTrustedOrigin(PARENT_ORIGIN)) {
  window.parent.postMessage({
    version: "1.0",
    type: "MM_CONFIRMATION_READY",
    payload: {}
  }, PARENT_ORIGIN);
}
```

Velo responde con:

```js
{
  version: "1.0",
  type: "MM_CONFIRMATION_CONTEXT",
  payload: {
    bookingIdF1, bookingIdF2, serviceId, tituloServicio,
    fecha, hora, horaF2, duracion, extras, total,
    appointmentNote, isCombined, serviceName, dateTime, status
  }
}
```

El HTML escucha `message`, comprueba `event.source === window.parent`, exige `event.origin === PARENT_ORIGIN` y un origen HTTPS de la allowlist, valida `type` y `version`, y renderiza datos mediante `textContent` (no interpolar datos dinámicos en `innerHTML`). Los mensajes de salida usan `PARENT_ORIGIN` exacto, nunca `"*"`. La descarga ICS omite `DTEND` si no se conoce una duración real, y no añade una dirección postal no verificada. Los mensajes de navegación admitidos son `MM_NAV` con `payload.url` igual a `/` o `/mis-reservas`; Velo valida la lista permitida y ejecuta la navegación.

### Privacidad y exactitud

- No enviar ni mostrar al cliente nombres de profesionales, `resourceName`, `staffName`, identificadores de recursos ni otros datos internos. No incluirlos en ticket TXT ni calendario ICS.
- No incluir dirección postal salvo que proceda de una fuente de configuración verificada. No usar la dirección de Madrid que estaba hardcodeada en la versión previa del widget.
- Mantener descarga de ticket y evento ICS, con los datos de la cita que estén realmente disponibles. No inventar Fase 2, duración, precio ni fecha.
- Escapar los valores para formato ICS (saltos de línea, comas, punto y coma y barras invertidas) antes de construir el archivo.
- El contexto enviado desde Velo es para presentación; el HTML no debe usarlo como autorización para mutar reservas.

## Estado de publicación

Los tres HTML versionados cubren el calendario (`#html1`), la confirmación (`#html2`) y el detalle del servicio (`#htmlWidgetCustomService`). El usuario confirmó la sincronización de los componentes con las fuentes existentes el 2026-10-26. **Los cambios nuevos del PR #202 aún no están validados en runtime** y deberán sincronizarse en Wix tras su aceptación. La validación de Preview sigue siendo obligatoria antes de publicar; no iniciar reservas de producción para verificar sincronización hasta que la sincronización de eventos nativos con `CitasF2` esté confirmada.

## Auditoría de referencias externas de widgets — 2026-10-23

### Hallazgos en el repositorio canónico

- Se inspeccionaron `src/pages/#html1.txt` y `src/pages/#html2.txt`: no contienen `tu-dominio.com` ni referencias a `/assets/widget.css` o `/assets/widget.js`.
- Ambos widgets contienen CSS y JavaScript integrados. `#html2` carga Google Fonts; esa dependencia es independiente de los assets de widget y no debe eliminarse como parte de esta corrección sin una decisión de diseño.
- Las rutas internas canónicas están en `src/public/widgetBridge.js`: `/reserva-online`, `/booking-calendar/calendario-2` y `/politica-de-privacidad`.
- El calendario usa el protocolo común `MM_READY` / `MM_CONTEXT`. La confirmación utiliza su contrato específico `MM_CONFIRMATION_READY` / `MM_CONFIRMATION_CONTEXT`; no intercambiar estos nombres.
- La búsqueda de texto en la rama `main` no encontró el dominio de ejemplo ni las rutas de assets indicadas. Esto verifica el repositorio, no el HTML guardado dentro del Editor Wix ni las peticiones del navegador en producción.

### Corrección y verificación obligatoria en Wix Editor

1. En los componentes HTML publicados, buscar `tu-dominio.com`, `assets/widget.css` y `assets/widget.js`.
2. Si aparecen en `#html1` o `#html2`, guardar copia del contenido actual y aplicar el archivo canónico correspondiente de este repositorio. No pegar el HTML de calendario en el widget de confirmación ni a la inversa.
3. El usuario confirmó el 2026-10-26 que `#html1`, `#html2` y `#htmlWidgetCustomService` están sincronizados con las fuentes canónicas. Si se acepta el PR #202, sincronizar sus cambios posteriores y volver a comprobar el handshake en Preview.
4. En Preview, verificar el handshake y la carga del contexto; probar navegación, disponibilidad y una reserva de prueba en un entorno seguro. No iniciar reservas reales únicamente para probar la sincronización.
5. En el sitio publicado, inspeccionar la pestaña Network y confirmar que las peticiones a los placeholders ya no se producen. Registrar resultado, fecha y URL probada.

**Límite de esta auditoría:** GitHub no sincroniza automáticamente el contenido de los componentes HTML del Editor Wix. La corrección del repositorio y sus pruebas no demuestran que el Editor esté actualizado; no marcar la incidencia de producción como resuelta hasta completar los pasos 1–5.

