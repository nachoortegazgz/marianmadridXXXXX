/**
 * controlOperativo.hooks.test.mjs
 * FASE 3 SSOT v7.0 (BIBLIA 12 / ADR-05): validacion condicional de hooks
 * ControlOperativo: WEBHOOK_EVENT append-only, resto purgable.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ControlOperativo_beforeInsert,
  ControlOperativo_beforeUpdate,
  ControlOperativo_beforeRemove,
} from "../data.js";
import { CONTROL_TYPE, CONTROL_STATUS } from "../internalConfig.js";

function _base(controlType) {
  return {
    controlType,
    dedupeKey: `${controlType}:unit-test-key`,
    status: CONTROL_STATUS.ACTIVE,
    traceId: "trace-unit-001",
  };
}

describe("ControlOperativo hooks (ADR-05)", () => {
  it("beforeInsert exige controlType valido del enum", () => {
    /* FIXTURE-FIX: la validacion condicional (validation.js) exige expiresAt
       en SLOT_LOCK/RATE_LIMIT ANTES de comprobar el resto; se completa la
       fixture con el campo requerido sin debilitar la intencion del test. */
    assert.doesNotThrow(() => ControlOperativo_beforeInsert({
      ..._base(CONTROL_TYPE.SLOT_LOCK),
      expiresAt: new Date(Date.now() + 60000),
    }));
    assert.throws(
      () => ControlOperativo_beforeInsert({ ..._base("NOT_A_TYPE"), controlType: "NOT_A_TYPE" }),
      /SCHEMA_VIOLATION.*controlType/,
    );
  });

  it("beforeInsert exige dedupeKey no vacio", () => {
    const bad = _base(CONTROL_TYPE.ALERT);
    bad.dedupeKey = "   ";
    assert.throws(() => ControlOperativo_beforeInsert(bad), /dedupeKey/);
  });

  it("beforeInsert rechaza status fuera de CONTROL_STATUS", () => {
    const bad = _base(CONTROL_TYPE.RATE_LIMIT);
    bad.status = "WHATEVER";
    assert.throws(() => ControlOperativo_beforeInsert(bad), /status/);
  });

  it("WEBHOOK_EVENT es append-only: update prohibido", () => {
    const rec = _base(CONTROL_TYPE.WEBHOOK_EVENT);
    assert.throws(
      () => ControlOperativo_beforeUpdate(rec, { original: rec }),
      /append-only/,
    );
  });

  it("WEBHOOK_EVENT es append-only: remove prohibido", () => {
    const rec = _base(CONTROL_TYPE.WEBHOOK_EVENT);
    /* ASSERT-FIX: mensaje canonico del hook (data.js) es "deletion forbidden". */
    assert.throws(() => ControlOperativo_beforeRemove(rec), /deletion forbidden/);
  });

  it("Subtipos purgables (SLOT_LOCK/DUAL_CACHE) permiten update/remove", () => {
    for (const t of [CONTROL_TYPE.SLOT_LOCK, CONTROL_TYPE.DUAL_CACHE, CONTROL_TYPE.DAYS_CACHE]) {
      /* FIXTURE-FIX: SLOT_LOCK exige expiresAt en la validacion condicional. */
      const rec = { ..._base(t), expiresAt: new Date(Date.now() + 60000) };
      assert.doesNotThrow(() => ControlOperativo_beforeUpdate(rec, { original: rec }));
      assert.doesNotThrow(() => ControlOperativo_beforeRemove(rec));
    }
  });

  it("CONTROL_TYPE cubre los subtipos del esquema objetivo", () => {
    /* SSOT-FIX (2026-10-13): el enum canónico de internalConfig es la fuente
       de verdad. BOOKING_TX quedo retirado (crons.js linea 509 confirma que
       no tiene productores ni consumidores activos). Se verifican ademas los
       tres subtipos con productores reales en codigo activo: IDEMPOTENCY
       (bookingCore v5013), SYSTEM_FLAG (bookingSaga v5013) y DEDUPE_KEY. */
    const expected = [
      "SLOT_LOCK", "WEBHOOK_EVENT", "RATE_LIMIT", "IDEMPOTENCY",
      "SYSTEM_FLAG", "DEDUPE_KEY",
      "COMPENSATION", "ALERT", "DAYS_CACHE", "DUAL_CACHE",
    ];
    const values = Object.values(CONTROL_TYPE).sort();
    assert.deepEqual(values, expected.sort());
  });
});
