# Contrato de integración de widgets HTML de reservas

Este documento fija el contrato entre los widgets HTML del Editor Wix y el frontend Velo del repositorio. Los HTML completos están versionados en `src/pages/#html1.txt` y `src/pages/#html2.txt`; cualquier cambio debe reflejarse en esos archivos y luego aplicarse por separado en el Editor Wix, que no se sincroniza automáticamente con GitHub.

## Calendario: `#html1` ↔ `src/pages/Calendario de reservas 2.q39h6.js`

- Mensajes con `version`, `type`, `messageId`, `bridgeId` y `payload`, compatibles con `public/widgetBridge.js`.
- El widget nunca elige profesional: enviar `resourceId: null`; ignorar cualquier selector de personal.
- Las preferencias del cliente salen del HTML como `preferences`; Velo las normaliza a `appointmentNote` (máximo 200 caracteres).
- La reserva se procesa exclusivamente mediante `processDualBooking`; no sustituir el flujo dual por dos reservas independientes.
- No confirmar ni asignar si el backend devuelve un error de disponibilidad/asignación.
- Velo debe validar el origen lógico, el tipo de mensaje y el payload. No confiar en datos de reserva enviados por el cliente.

## Confirmación: `#lightbox1` / `ConfirmacionReserva` → `#html2`

Velo es responsable de recuperar/normalizar el contexto y enviar al widget una lista permitida de campos. El HTML debe iniciar el intercambio enviando:

```js
window.parent.postMessage({
  version: "1.0",
  type: "MM_CONFIRMATION_READY",
  payload: {}
}, "*");
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

El HTML escucha `message`, comprueba `event.source === window.parent`, valida `type` y `version`, y renderiza datos mediante `textContent` (no interpolar datos dinámicos en `innerHTML`). La descarga ICS omite `DTEND` si no se conoce una duración real, y no añade una dirección postal no verificada. Los mensajes de navegación admitidos son `MM_NAV` con `payload.url` igual a `/` o `/mis-reservas`; Velo valida la lista permitida y ejecuta la navegación.

### Privacidad y exactitud

- No enviar ni mostrar al cliente nombres de profesionales, `resourceName`, `staffName`, identificadores de recursos ni otros datos internos. No incluirlos en ticket TXT ni calendario ICS.
- No incluir dirección postal salvo que proceda de una fuente de configuración verificada. No usar la dirección de Madrid que estaba hardcodeada en la versión previa del widget.
- Mantener descarga de ticket y evento ICS, con los datos de la cita que estén realmente disponibles. No inventar Fase 2, duración, precio ni fecha.
- Escapar los valores para formato ICS (saltos de línea, comas, punto y coma y barras invertidas) antes de construir el archivo.
- El contexto enviado desde Velo es para presentación; el HTML no debe usarlo como autorización para mutar reservas.

## Estado de publicación

Los dos HTML versionados ya incluyen el contrato de `#html1` y el receptor de contexto seguro para `#html2`; el frontend Velo valida la versión del protocolo. **El HTML alojado dentro de Wix no se actualiza automáticamente desde el repositorio**: copiar los cambios al Editor Wix y verificar el handshake en Preview antes de publicar. No iniciar reservas de producción para verificar sincronización hasta que la sincronización de eventos nativos con `CitasF2` esté confirmada.
