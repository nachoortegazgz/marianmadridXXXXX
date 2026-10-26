/*
=============================================================================
MODULE: backend/secretVault.js
RESPONSIBILITY: Backend-only adapter for the current Wix Secrets SDK.
CONTRACT: Return the secret value as a string; never expose it to frontend DTOs.
=============================================================================
*/
import { secrets } from "@wix/secrets";
import { auth } from "@wix/essentials";

const elevatedGetSecretValue = auth.elevate(secrets.getSecretValue);

export async function getSecretValue(name) {
    const secretName = typeof name === "string" ? name.trim() : "";
    if (!secretName) {
        throw new Error("SECRET_NAME_REQUIRED");
    }

    const response = await elevatedGetSecretValue(secretName);
    const value = response?.value;
    return typeof value === "string" ? value : "";
}
