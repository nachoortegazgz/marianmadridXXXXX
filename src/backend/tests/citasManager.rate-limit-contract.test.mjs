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

test('SEC-RL-PERSIST-01 shared security module reads canonical ControlOperativo rate-limit records', () => {
  assert.match(securitySource, /export\s+async\s+function\s+checkPersistentRateLimitBlock/);
  assert.match(securitySource, /dalQuery\(OPERATIONAL_COLLECTIONS\.CONTROL_OPERATIVO\)[\s\S]{0,500}\.find\(STRONG_READ\)/);
  assert.match(securitySource, /\.eq\(["']controlType["'],\s*CONTROL_TYPE\.RATE_LIMIT\)/);
  assert.doesNotMatch(securitySource, /RateLimitBlocks/);
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

test('SEC-RL-PERSIST-03 rejected requests count toward the persistent escalation threshold', () => {
  const limiterStart = securitySource.indexOf('export function rateLimiter(');
  const limiterEnd = securitySource.indexOf('// BLOQUE 4 - BLOQUEO PERSISTENTE', limiterStart);
  assert.notEqual(limiterStart, -1);
  assert.notEqual(limiterEnd, -1);
  const limiter = securitySource.slice(limiterStart, limiterEnd);
  const attempt = limiter.indexOf('entry.timestamps.push(now)');
  const persistentThreshold = limiter.indexOf('if (entry.timestamps.length >= persistentThreshold)');
  const regularThreshold = limiter.indexOf('if (entry.timestamps.length > max)');
  assert.ok(attempt !== -1 && attempt < persistentThreshold, 'attempt must be recorded before persistent threshold check');
  assert.ok(persistentThreshold < regularThreshold, 'persistent escalation must run before ordinary rate-limit rejection');
});
