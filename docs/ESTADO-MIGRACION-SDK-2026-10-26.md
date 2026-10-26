# SDK migration status — Marian Madrid

Cut-off: 2026-10-26
Branch: migrate/wix-ecom-cart-v2
PR: https://github.com/nachoortegazgz/marianmadridXXXXX/pull/204

## Verified source changes

- **eCommerce:** booking saga now calls Cart V2 (`cartV2.createCart` and `cartV2.getCheckoutUrl`) from `@wix/ecom`. Checkout V1 calls were removed from the online booking payment step. Two focused Cart V2 contract tests pass.
- **Bookings reader:** `extendedBookings.queryExtendedBookings` is imported from `@wix/bookings`; the offline test mock uses the same SDK namespace.
- **Members:** six backend modules use `members.getCurrentMember()` from `@wix/members` instead of `currentMember.getMember()` from `wix-members-backend`: `security.web.js`, `security.js`, `horario.web.js`, `cajas.web.js`, `citasManager.web.js`, and `reservas.web.js`.
- **Test harness:** removed the obsolete `currentMember` legacy mock and updated the static cash-close actor contract test to assert the recommended SDK method.
- **Catalog:** Catalog V1 is retained temporarily; Catalog V3 work is explicitly deferred in `DECISION-OPERATIVA-MIGRACIONES-SDK-2026-10-26.md`.

## Validation observed

- Focused Cart V2 contract: 2/2 passing in the earlier completed CI run.
- Backend regression after member migration: 307 passing, 12 failing across 5 suites. This matches the previous baseline; the additional static contract failure caused by changing the member SDK was updated and no longer adds a regression.
- Public-site HTTPS smoke test: passing.
- ESLint diagnostics: 58 files, 0 errors, 0 warnings; npm audit reported 0 vulnerabilities in the last diagnostics run.
- Wix Preview is not yet verified. A prior attempt failed in Wix's deployment service with `PUBLISH_PIPELINE_TASK_NOT_FOUND`; a newer run is pending/in progress.

## Remaining blockers before calling this 100% migrated

1. Regenerate the lockfile with npm for the recommended `@wix/ecom` package version (the repository currently pins `1.0.2539`; the Wix docs checked during this work referenced `1.0.2542`). Do not edit integrity hashes manually.
2. Remove unused direct dependencies only in the same package-manager-generated lockfile change. Repository source search did not find imports of `@wix/auto_sdk_bookings_extended-bookings` or `@wix/user-management`, but lockfile removal must be generated and validated by npm.
3. Complete the legacy import/dependency inventory across the branch and check SDK method contracts, not just module names.
4. Resolve or prove pre-existing the 12 backend test failures: booking concurrency, data provenance, native booking sync, reservas.web and site flows.
5. Obtain a successful Wix Preview build and verify booking → Cart V2 checkout URL → payment → post-payment sync before merge.

## Safety

No changes have been merged to main or published to Wix production. Do not weaken ledger, fiscal, booking or security tests to force green CI.