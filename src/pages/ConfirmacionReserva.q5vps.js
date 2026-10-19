/*
=============================================================================
MODULE: pages/ConfirmacionReserva.q5vps.js
VERSION: v1.0-FIXED
BASE: v0.9-BROKEN + correcciones auditoría P0 (CONF-01..CONF-05)
RESPONSIBILITY: Mostrar confirmación de reserva tras éxito presencial o online.
STANDARDS: G10 ASCII Strict. Uso estricto de APIs Velo actuales.
CONTRATO: Recibe datos via lightBox.getContext(): { booking, bookingId, service, traceId }.
=============================================================================
*/
import wixWindow from 'wix-window-frontend';
import wixLocation from 'wix-location-frontend';
import { getConfirmedBookingForDisplay } from 'backend/reservas.web.js';
import { _safeTrim, _toDateSafe, getMadridLocalStringNoZ } from 'public/mmUtils';

// Element IDs (Deben coincidir con los IDs en el Editor de Wix)
const ELEMENTS = {
    TITLE: '#titleText',
    BOOKING_ID: '#bookingIdText',
    SERVICE_NAME: '#serviceNameText',
    DATE_TIME: '#dateTimeText',
    STAFF_NAME: '#staffNameText',
    TOTAL_AMOUNT: '#totalAmountText',
    STATUS: '#statusText',
    BTN_HOME: '#homeButton',
    BTN_CALENDAR: '#calendarButton',
    ERROR_MSG: '#errorMessage'
};

$w.onReady(async function () {
    // 1. Obtener contexto del Lightbox
    const context = wixWindow.lightBox.getContext();
    
    if (!context || !context.bookingId) {
        showError("No se pudo cargar la información de la reserva.");
        return;
    }

    const { bookingId, traceId } = context;

    try {
        // 2. Consultar backend para obtener datos seguros y whitelisted
        // Nota: Si el usuario NO está autenticado, esto fallará a menos que 
        // se implemente el token opaco (FASE 5 pendiente en frontend).
        // Por ahora, asumimos que el lightbox solo se abre tras éxito interno
        // o que el usuario tiene sesión activa.
        
        let displayData;
        
        // Intentamos usar los datos pasados directamente si existen (para evitar latencia)
        if (context.booking && context.service) {
            displayData = mapContextToUI(context.booking, context.service);
        } else {
            // Fallback: consultar backend si no hay datos en contexto
            const result = await getConfirmedBookingForDisplay({ bookingId });
            if (!result.ok) {
                throw new Error(result.error || "Reserva no encontrada");
            }
            displayData = mapBackendResultToUI(result.data);
        }

        // 3. Renderizar datos en la UI
        renderConfirmation(displayData);

    } catch (error) {
        console.error("[ConfirmacionReserva] Error:", error);
        showError("Ocurrió un error al cargar la confirmación. Por favor, contacte con soporte.");
    }
});

/**
 * Mapea los datos crudos del contexto a un formato limpio para la UI.
 */
function mapContextToUI(booking, service) {
    return {
        bookingId: booking.bookingId || booking.id,
        serviceName: service?.title || "Servicio Reservado",
        // Asumimos que el slot viene normalizado en el objeto booking o service
        dateTime: formatDateTime(booking.slotStart || booking.startDate),
        staffName: booking.resourceName || "Profesional Asignado",
        totalAmount: booking.totalAmount || service?.price || 0,
        status: "CONFIRMED"
    };
}

/**
 * Mapea el resultado del backend (whitelisted) a la UI.
 */
function mapBackendResultToUI(data) {
    return {
        bookingId: data.bookingId,
        serviceName: "Servicio Confirmado", // El backend no devuelve nombre completo por seguridad/whitelist
        dateTime: formatDateTime(data.slotStart),
        staffName: "Ver Agenda", // El backend no expone nombre staff en whitelist básica
        totalAmount: data.totalAmount,
        status: data.bookingStatus
    };
}

/**
 * Renderiza los datos en los elementos de la página.
 */
function renderConfirmation(data) {
    $w(ELEMENTS.TITLE).text = "¡Reserva Confirmada!";
    $w(ELEMENTS.BOOKING_ID).text = `ID: ${_safeTrim(data.bookingId)}`;
    $w(ELEMENTS.SERVICE_NAME).text = data.serviceName;
    $w(ELEMENTS.DATE_TIME).text = data.dateTime;
    $w(ELEMENTS.STAFF_NAME).text = data.staffName;
    
    // Formateo de moneda
    const formatter = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
    $w(ELEMENTS.TOTAL_AMOUNT).text = formatter.format(data.totalAmount);
    
    $w(ELEMENTS.STATUS).text = "Estado: Confirmado";
    
    // Ocultar mensaje de error si estaba visible
    $w(ELEMENTS.ERROR_MSG).collapse();
}

/**
 * Formatea una fecha ISO o Date object a string legible en Madrid.
 */
function formatDateTime(dateInput) {
    if (!dateInput) return "Fecha por confirmar";
    
    const date = _toDateSafe(dateInput);
    if (!date) return "Fecha inválida";
    
    // Convertir a hora local de Madrid
    const madridString = getMadridLocalStringNoZ(date); // YYYY-MM-DDTHH:mm:ss
    
    // Parsear para formateo bonito
    const [datePart, timePart] = madridString.split('T');
    const [year, month, day] = datePart.split('-');
    
    return `${day}/${month}/${year} a las ${timePart.substring(0, 5)}`;
}

/**
 * Muestra un mensaje de error en la UI.
 */
function showError(message) {
    $w(ELEMENTS.TITLE).text = "Error";
    $w(ELEMENTS.ERROR_MSG).text = message;
    $w(ELEMENTS.ERROR_MSG).expand();
    
    // Colapsar elementos de éxito
    $w(ELEMENTS.BOOKING_ID).collapse();
    $w(ELEMENTS.SERVICE_NAME).collapse();
    $w(ELEMENTS.DATE_TIME).collapse();
    $w(ELEMENTS.STAFF_NAME).collapse();
    $w(ELEMENTS.TOTAL_AMOUNT).collapse();
    $w(ELEMENTS.STATUS).collapse();
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

export function homeButton_click(event) {
    wixLocation.to("/");
}

export function calendarButton_click(event) {
    wixLocation.to("/reserva-online");
}
