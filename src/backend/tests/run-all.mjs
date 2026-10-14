// Runner canónico: ejecuta todas las suites con el loader de mocks (--loader).
// Uso: node --no-warnings --loader ./src/backend/tests/loader.mjs src/backend/tests/run-all.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const suites = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs') && !f.startsWith('_dbg'))
  .sort();

let totalPass = 0, totalFail = 0;
const report = [];
for (const s of suites) {
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      ['--no-warnings', '--loader', join(here, 'loader.mjs'), join(here, s)],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (e) {
    out = (e.stdout || '') + (e.stderr || '');
  }
  const pass = Number(out.match(/^# pass (\d+)/m)?.[1] ?? 0);
  const fail = Number(out.match(/^# fail (\d+)/m)?.[1] ?? 0);
  totalPass += pass; totalFail += fail;
  report.push({ suite: s, pass, fail, status: fail === 0 && pass > 0 ? 'OK' : 'FAIL' });
}
console.log('\n=== RESUMEN SUITES (run-all) ===');
for (const r of report) console.log(`${r.status.padEnd(4)} ${r.suite.padEnd(42)} pass=${r.pass} fail=${r.fail}`);
console.log(`TOTAL: pass=${totalPass} fail=${totalFail}`);
process.exit(totalFail === 0 ? 0 : 1);
