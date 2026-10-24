import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(join(here, '..', 'citasManager.web.js'), 'utf8');

test('CM-RL-01 citasManager defines its rate-limit guard before use', () => {
  assert.match(moduleSource, /import\s*\{[^}]*\brateLimiter\b[^}]*\}\s*from\s*["']backend\/security["']/s);
  const declaration = moduleSource.indexOf('function _rateLimitOrThrow(');
  assert.notEqual(declaration, -1, 'rate-limit helper declaration must exist');
  const firstCall = moduleSource.indexOf('_rateLimitOrThrow(', declaration + 1);
  assert.notEqual(firstCall, -1, 'rate-limit helper must be used by public methods');
  assert.match(moduleSource.slice(declaration, declaration + 700), /rateLimiter\(\{\s*surface,\s*key\s*\}\)/);
  assert.match(moduleSource.slice(declaration, declaration + 700), /error\.code\s*=\s*["']RATE_LIMITED["']/);
});

const securitySource = readFileSync(join(here, '..', 'security.js'), 'utf8');

test('SEC-RL-PERSIST-01 shared security module reads active persistent blocks', () => {
  assert.match(securitySource, /export\s+async\s+function\s+checkPersistentRateLimitBlock/);
  assert.match(securitySource, /dalQuery\(RATE_LIMIT_BLOCKS_COL\(\)\)[\s\S]{0,300}\.find\(STRONG_READ\)/);
});

test('SEC-RL-PERSIST-02 protected web modules check persistent blocks before local limiter', () => {
  for (const source of [
    readFileSync(join(here, '..', 'citasManager.web.js'), 'utf8'),
    readFileSync(join(here, '..', 'cajas.web.js'), 'utf8'),
    readFileSync(join(here, '..', 'reservas.web.js'), 'utf8'),
  ]) {
    assert.match(source, /await checkPersistentRateLimitBlock\(surface, key, traceId\)/);
    assert.match(source, /async function _rateLimitOrThrow\(/);
  }
});
