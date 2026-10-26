/*
=============================================================================
MODULE: backend/secretVault.js
RESPONSIBILITY: Backend-only adapter for the current Wix Secrets SDK.
CONTRACT: Return the secret value as a string; never expose it to frontend DTOs.
=============================================================================
*/
import { secrets } from "@wix/secrets";
import { auth } from "@wix/essentials";

export async function getSecretValue(name) {
    const secretName = typeof name === "string" ? name.trim() : "";
    if (!secretName) {
        throw new Error("SECRET_NAME_REQUIRED");
    }

    // Matches Wix's documented elevated-permissions example for Secrets.
    // Keep elevation inside this backend-only operation.
    const elevatedGetSecretValue = auth.elevate(secrets.getSecretValue);
    const response = await elevatedGetSecretValue(secretName);
    const value = response?.value;

    // Wix's SDK contract returns { value: string }. Fail closed rather than
    // silently treating an absent/malformed secret as a valid empty string.
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("SECRET_VALUE_UNAVAILABLE");
    }

    return value;
}
