# Temporary regression summary

Commit tested: aececd2ac94df087bd6d119ccef4483b2e6fd471
npm test exit: 1

## Failing suites and totals
FAIL booking.core.concurrency.test.mjs          tests=38 pass=37 fail=1 exit=1
FAIL data.provenance.e2e.test.mjs               tests=6 pass=5 fail=1 exit=1
FAIL events.native-booking-sync.test.mjs        tests=15 pass=11 fail=4 exit=1
FAIL reservas.web.test.mjs                      tests=74 pass=73 fail=1 exit=1
FAIL site.flows.e2e.test.mjs                    tests=20 pass=15 fail=5 exit=1
TOTAL: suites=38 pass=309 fail=12 failedSuites=5

## Diagnostics
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
    actual: undefined,
    expected: /CMS lookup unavailable/,
  Error: SCHEMA_VIOLATION: movementType obligatorio y valido
    actual: 'ERROR',
    expected: 'SUCCESS',
  AssertionError [ERR_ASSERTION]: {"code":"LEDGER_FAIL","message":"SCHEMA_VIOLATION: Factura F1 exige recipientTaxId"}
    actual: 'ERROR',
    expected: 'SUCCESS',
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
    actual: 'LEDGER_FAIL',
    expected: 'INVALID_PAYMENT_METHOD',
  AssertionError [ERR_ASSERTION]: solo puede persistirse un movimiento por transactionId
    actual: 0,
    expected: 1,
