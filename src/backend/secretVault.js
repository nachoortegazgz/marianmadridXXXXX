/*
MODULE: src/backend/secretVault.js
RESPONSIBILITY: Centralizes Wix Secrets SDK reads and keeps secret values on the backend.
STATIC DEPENDENCIES: @wix/secrets, @wix/essentials
NAMED EXPORT DECLARATIONS DETECTED: getSecretValue
HISTORY: Current contract only. Historical changes are preserved in Git; unverified version/changelog claims are intentionally omitted.
*/
import { secrets } from "@wix/secrets";
import { auth } from "@wix/essentials";

function getSecretValueElevated(...args) {
    const operation = secrets.getSecretValue;
    if (typeof operation !== "function") {
        const error = new TypeError("Wix Secrets operation is not callable");
        error.code = "WIX_SECRETS_OPERATION_NOT_CALLABLE";
        throw error;
    }

    const elevatedOperation = auth.elevate(function (...runtimeArgs) {
        return operation(...runtimeArgs);
    });
    if (typeof elevatedOperation !== "function") {
        const error = new TypeError("Elevated Wix Secrets operation is not callable");
        error.code = "ELEVATED_WIX_SECRETS_OPERATION_NOT_CALLABLE";
        throw error;
    }
    return elevatedOperation(...args);
}

export async function getSecretValue(name) {
    const secretName = typeof name === "string" ? name.trim() : "";
    if (!secretName) {
        throw new Error("SECRET_NAME_REQUIRED");
    }

    const response = await getSecretValueElevated(secretName);
    const value = response?.value;

    // Wix's SDK contract returns { value: string }. Fail closed rather than
    // silently treating an absent/malformed secret as a valid empty string.
    if (typeof value !== "string" || value.length === 0) {
        throw new Error("SECRET_VALUE_UNAVAILABLE");
    }

    return value;
}
