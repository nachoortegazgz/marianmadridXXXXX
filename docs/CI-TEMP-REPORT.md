# Temporary validation report

Commit: 9a68bacf0d6d0454a05519d482496c6c7d01b91c
npm ci exit: 0
npm test exit: 1
ESLint exit: 0

## Test summary
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
  Error: SCHEMA_VIOLATION: movementType obligatorio y valido
  AssertionError [ERR_ASSERTION]: {"code":"LEDGER_FAIL","message":"SCHEMA_VIOLATION: Factura F1 exige recipientTaxId"}
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  AssertionError [ERR_ASSERTION]: solo puede persistirse un movimiento por transactionId
  AssertionError [ERR_ASSERTION]: dataAccess.js should use SDK operation bulkInsert
TOTAL: suites=38 pass=308 fail=13 failedSuites=6

## Lint summary
