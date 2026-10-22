import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sagaSource = readFileSync(join(here, '..', 'booking', 'bookingSaga.js'), 'utf8');

test('SAGA-GAP-01 preserves a configured zero-minute dual gap', () => {
  assert.match(
    sagaSource,
    /const CONFIGURED_MAX_DUAL_GAP_MINUTES = Number\([\s\S]*?SLOT_SEARCH && SLOT_SEARCH\.MINUTOS_MAX_HUECO_DUAL[\s\S]*?\);/,
  );
  assert.match(
    sagaSource,
    /Number\.isFinite\(CONFIGURED_MAX_DUAL_GAP_MINUTES\)[\s\S]*?CONFIGURED_MAX_DUAL_GAP_MINUTES >= 0[\s\S]*?\? CONFIGURED_MAX_DUAL_GAP_MINUTES[\s\S]*?: 120/,
  );
  assert.doesNotMatch(
    sagaSource,
    /Number\(SLOT_SEARCH && SLOT_SEARCH\.MINUTOS_MAX_HUECO_DUAL\)\s*\|\|\s*120/,
    'zero must not be coerced to the fallback',
  );
});
