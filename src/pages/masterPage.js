/**
 * MODULE: pages/masterPage.js
 * PURPOSE: Site-wide fallback for the published root page.
 * The public home page has been observed as a "coming soon" dead end.
 * Only the site root is redirected; every other route is left untouched.
 */
import wixLocation from "wix-location-frontend";
import { URLS } from "public/mmUtils";

$w.onReady(() => {
    const currentUrl = String(wixLocation.url || "");
    const path = currentUrl
        .split("#")[0]
        .split("?")[0]
        .replace(/^https?:\/\/[^/]+/i, "") || "/";

    if (path === "/" && URLS?.SERVICIOS === "/reserva-online") {
        wixLocation.to(URLS.SERVICIOS);
    }
});
