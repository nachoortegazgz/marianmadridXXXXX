import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PERMISSIONS_PATH = path.join(BACKEND_DIR, 'permissions.json');

const EXPECTED = {
  Anyone: { siteOwner: true, siteMember: true, anonymous: true },
  SiteMember: { siteOwner: true, siteMember: true, anonymous: false },
  Admin: { siteOwner: true, siteMember: false, anonymous: false },
};

function listBackendJavaScript(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'tests' || entry.name === 'node_modules') return [];
      return listBackendJavaScript(fullPath);
    }
    return /\.m?js$/.test(entry.name) && !entry.name.endsWith('.test.mjs') ? [fullPath] : [];
  });
}

function readWebMethods(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  const methods = [];
  const declaration = /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*webMethod\s*\(/g;
  let match;

  while ((match = declaration.exec(source))) {
    const prefix = source.slice(declaration.lastIndex, declaration.lastIndex + 500);
    const permissionMatch = prefix.match(/^\s*Permissions\.(Anyone|SiteMember|Admin)\b/);
    const relativePath = path.relative(BACKEND_DIR, filePath).split(path.sep).join('/');
    assert.ok(
      permissionMatch,
      `Cannot statically classify webMethod backend/${relativePath}:${match[1]}; review permission expression manually.`,
    );
    methods.push({
      file: `backend/${relativePath}`,
      name: match[1],
      permission: permissionMatch[1],
    });
  }
  return methods;
}

function normalizedPolicy(policy) {
  return {
    siteOwner: policy?.siteOwner?.invoke,
    siteMember: policy?.siteMember?.invoke,
    anonymous: policy?.anonymous?.invoke,
  };
}

test('SEC-PERM-01 wildcard defaults deny members and anonymous callers', () => {
  const config = JSON.parse(fs.readFileSync(PERMISSIONS_PATH, 'utf8'));
  const wildcard = config['web-methods']?.['*']?.['*'];
  assert.deepEqual(normalizedPolicy(wildcard), {
    siteOwner: true,
    siteMember: false,
    anonymous: false,
  });
});

test('SEC-PERM-02 every exported webMethod has an explicit matching policy', () => {
  const config = JSON.parse(fs.readFileSync(PERMISSIONS_PATH, 'utf8'));
  const matrix = config['web-methods'];
  const methods = listBackendJavaScript(BACKEND_DIR).flatMap(readWebMethods);
  const failures = [];

  for (const method of methods) {
    const actual = matrix?.[method.file]?.[method.name];
    const expected = EXPECTED[method.permission];
    if (!actual) {
      failures.push(`Missing explicit policy: ${method.file}:${method.name}`);
      continue;
    }
    if (JSON.stringify(normalizedPolicy(actual)) !== JSON.stringify(expected)) {
      failures.push(
        `Policy mismatch: ${method.file}:${method.name}; declared Permissions.${method.permission}, expected ${JSON.stringify(expected)}, got ${JSON.stringify(normalizedPolicy(actual))}`,
      );
    }
  }

  for (const [file, entries] of Object.entries(matrix || {})) {
    if (file === '*') continue;
    for (const methodName of Object.keys(entries || {})) {
      if (!methods.some((method) => method.file === file && method.name === methodName)) {
        failures.push(`Stale policy with no exported webMethod: ${file}:${methodName}`);
      }
    }
  }

  assert.deepEqual(
    failures,
    [],
    `Permission matrix parity failed across ${methods.length} exported webMethods:\n${failures.join('\n')}`,
  );
});
