# Quality gates and Wix synchronization

## Source of truth

- GitHub repository: `nachoortegazgz/marianmadridXXXXX`.
- Canonical branch: `main`.
- Wix Git Integration follows the repository's configured default branch. A commit pushed to that branch updates the site's code in the regular Wix Editor; it does **not** by itself publish the site.
- Never treat a successful merge or offline test run as proof that the published website works.

## Reproducible checks

Run from the repository root with Node.js 20 and the committed lockfile:

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
