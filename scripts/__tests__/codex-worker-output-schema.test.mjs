import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

function includesObjectType(schemaNode) {
  if (!schemaNode || typeof schemaNode !== 'object') return false;
  const t = schemaNode.type;
  if (typeof t === 'string') return t === 'object';
  if (Array.isArray(t)) return t.includes('object');
  return Boolean(schemaNode.properties && typeof schemaNode.properties === 'object');
}

test('worker output schema: top-level required contains every property key', async () => {
  const schemaPath = path.join(
    process.cwd(),
    'docs',
    'agentic',
    'agent-bus',
    'CODEX_WORKER_OUTPUT.schema.json',
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const props = Object.keys(schema.properties || {});
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  for (const key of props) {
    assert.equal(
      required.has(key),
      true,
      `missing top-level required key: ${key}`,
    );
  }
});

test('worker output schema: nested object properties are fully covered by required arrays', async () => {
  const schemaPath = path.join(
    process.cwd(),
    'docs',
    'agentic',
    'agent-bus',
    'CODEX_WORKER_OUTPUT.schema.json',
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));

  /**
   * @param {unknown} node
   * @param {string} pathKey
   */
  const visit = (node, pathKey) => {
    if (!node || typeof node !== 'object') return;

    if (includesObjectType(node) && node.properties && typeof node.properties === 'object') {
      const keys = Object.keys(node.properties);
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      const missing = keys.filter((key) => !required.has(key));
      assert.equal(
        missing.length,
        0,
        `object schema missing required coverage at ${pathKey}: ${missing.join(', ')}`,
      );
    }

    if (node.properties && typeof node.properties === 'object') {
      for (const [key, value] of Object.entries(node.properties)) {
        visit(value, `${pathKey}.properties.${key}`);
      }
    }

    if (node.items) {
      visit(node.items, `${pathKey}.items`);
    }

    for (const key of ['allOf', 'anyOf', 'oneOf']) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((value, index) => {
        visit(value, `${pathKey}.${key}[${index}]`);
      });
    }
  };

  visit(schema, '$');
});

test('worker output schema: review field is nullable for non-review tasks', async () => {
  const schemaPath = path.join(
    process.cwd(),
    'docs',
    'agentic',
    'agent-bus',
    'CODEX_WORKER_OUTPUT.schema.json',
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const reviewType = schema?.properties?.review?.type;
  assert.ok(Array.isArray(reviewType), 'review.type must be an array');
  assert.equal(reviewType.includes('object'), true);
  assert.equal(reviewType.includes('null'), true);
});

test('worker output schema: autopilotControl supports null and enforces full object coverage', async () => {
  const schemaPath = path.join(
    process.cwd(),
    'docs',
    'agentic',
    'agent-bus',
    'CODEX_WORKER_OUTPUT.schema.json',
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const control = schema?.properties?.autopilotControl ?? {};
  const typeValues = Array.isArray(control.type) ? control.type : [control.type];
  assert.equal(typeValues.includes('object'), true);
  assert.equal(typeValues.includes('null'), true);

  const expectedKeys = [
    'executionMode',
    'tinyFixJustification',
    'workstream',
    'branchDecision',
    'branchDecisionReason',
  ].sort();
  const required = Array.isArray(control.required) ? [...control.required].sort() : [];
  const propertyKeys = Object.keys(control.properties || {}).sort();
  assert.deepEqual(required, expectedKeys);
  assert.deepEqual(propertyKeys, expectedKeys);
});

test('worker output schema: runtimeGuard remains model-authored null placeholder', async () => {
  const schemaPath = path.join(
    process.cwd(),
    'docs',
    'agentic',
    'agent-bus',
    'CODEX_WORKER_OUTPUT.schema.json',
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'));
  const runtimeGuardType = schema?.properties?.runtimeGuard?.type;
  assert.ok(Array.isArray(runtimeGuardType), 'runtimeGuard.type must be an array');
  assert.deepEqual(runtimeGuardType, ['null']);
});
