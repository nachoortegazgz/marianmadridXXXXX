# Quality gates and Wix synchronization

## Source of truth

- GitHub repository: `nachoortegazgz/marianmadridXXXXX`.
- Canonical branch: `main`.
- Wix Git Integration follows the repository's configured default branch. A commit pushed to that branch updates the site's code in the regular Wix Editor; it does **not** by itself publish the site.
- Never treat a successful merge or offline test run as proof that the published website works.

## Verified snapshot — 2026-10-28

- PR #263 is merged into `main` (merge commit `d83aa65145950435df5f4fd569e0586902ae9c6e`). The quality workflow now uses Node.js `24.22.1`.
- PR #263 CI completed successfully: dependency installation, full regression, Layer 1, Layer 2, `git diff --check`, and ESLint with zero warnings.
- Live Wix read-only audit: Bookings returned 94 native services; `ServiciosCatalogo` returned 95 CMS rows, including 24 dual-phase entries. All 24 dual mappings matched native F1/F2 IDs, visibility expectations, and phase durations; no mismatches were found.
- Live slot probes confirmed same-resource F1/F2 combinations with exact exposure gaps of 25, 35, 40, and 45 minutes for sampled dual services. These are availability checks, not completed test bookings.
- Wix CLI Preview remains unverified. The latest observed failure for the SDK-location fix was `PUBLISH_PIPELINE_TASK_NOT_FOUND` (PR #223 Preview workflow run 246). No Wix publish was performed.

## Reproducible checks

Run from the repository root with Node.js 24.22.1 and the committed lockfile:

```bash
npm ci --ignore-scripts
npm test
npm run test:layer1
npm run test:layer2
npm run lint -- --max-warnings=0
```

`--ignore-scripts` deliberately prevents the Wix CLI `postinstall` command (`wix sync-types`) from running in generic CI. The quality workflow is not intended to authenticate to Wix, mutate the site, preview, or publish it.

### What the suites cover

- `npm test`: canonical runner for `*.test.mjs` and `*.runner.mjs` suites under `src/backend/tests`, using the repository test loader.
- `npm run test:layer1`: shared data-access and SDK contracts, rate limiting, booking availability/saga and concurrency, reservation web methods, and selected site/SSOT contracts.
- `npm run test:layer2`: cash-close schemas, CMS/event hooks, cron configuration parity, DTO allowlists, fiscal aggregation, and integrated site/data provenance flows.
- ESLint: static analysis of the repository.

Offline tests and mocks validate only the code paths they exercise. They do not prove Wix CMS permissions, deployed secrets, live slot availability, actual booking creation/cancellation, Wix Editor synchronization, or production acceptance.

## Wix validation and deployment gate

1. Confirm the local working tree and branch before syncing:
   ```bash
   git status --short
   git branch --show-current
   git pull --ff-only origin main
   npx wix --version
   npx wix status
   ```
2. Confirm the new commit is on `main` and allow Wix Git Integration to sync it to the regular Editor.
3. Validate the affected backend and frontend in Wix Local Editor/Preview, including simple bookings, dual-phase bookings with the exposure gap, professional/resource selection, cancellation/compensation after Phase 2 failure, CMS permissions, and relevant logs.
4. Publish only after the Preview/build succeeds and the affected behavior is validated. Do not publish automatically from this quality workflow.

## Known Wix Preview blocker

A prior Wix CLI Preview run failed with `PUBLISH_PIPELINE_TASK_NOT_FOUND` / `Failed to get deployment pipeline details`. This is a deployment-platform blocker, not a passing test. The quality workflow intentionally does not mask this failure, skip validation, or publish as a workaround. Re-enable a separate Preview workflow only after the Wix pipeline/authentication issue has been resolved and a successful Preview is observed.

## Evidence ledger

- Historical successful offline baseline recorded in the project's development notes: `npm test` 182 passed / 0 failed; layer 1 130 passed / 0 failed; layer 2 72 passed / 0 failed. These figures describe an earlier tested revision only.
- The current branch must produce a new green GitHub Actions run before its tests can be labelled verified.
- Wix Preview and production acceptance remain separate gates.


## Addendum — limpieza y estado posterior (2026-10-28)

- PR #268 corrigió la declaración ausente de `@wix/site-pricing-plans` en `package.json`; PR #269 eliminó dos alias de catálogo del widget; PR #270 minimizó el view-model local de complementos.
- CI de PR #270 completó con éxito instalación, pruebas completas, Layer 1, Layer 2, chequeo de diff y ESLint sin avisos.
- La consulta en vivo de permisos CMS devolvió `ServiciosCatalogo`/`ComplementosCatalogo`: `itemRead=CMS_EDITOR`, escrituras `PRIVILEGED`; `MapaStaff`: operaciones `CMS_EDITOR`. No equivale a una prueba de acceso anónimo a través de páginas/datasets.
- No se ha publicado en Wix ni se han alterado datos CMS. `PUBLISH_PIPELINE_TASK_NOT_FOUND` continúa siendo bloqueo de plataforma, confirmado en las pruebas previas incluso con CLI 1.2.2 (PR #255). Mantener Preview y E2E como puertas independientes.


## Addendum — resolver primario (2026-10-28)

- PR #272 renombra el método público `resolveServiceId` a `resolvePrimaryServiceId`, actualiza el mapa de permisos y las pruebas; conserva `_resolveServiceIdInternal` para uso interno de `bookingSaga`.
- CI de PR #272 pasó en todas las puertas offline. Esto no elimina el bloqueo de Preview ni certifica la ejecución en Wix.
