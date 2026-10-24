/**
 * MODULE: pages/Entrada.an12i.js
 * PURPOSE: Temporary functional fallback for the published home page.
 * The Wix Editor home content currently displays a "coming soon" message.
 * Route visitors to the working service catalog until the designed home page
 * is restored and published in Wix Editor.
 */
import wixLocation from "wix-location-frontend";
import { URLS } from "public/mmUtils";

$w.onReady(() => {
    const target = URLS && URLS.SERVICIOS;
    if (typeof target === "string" && target === "/reserva-online") {
        wixLocation.to(target);
    }
});
