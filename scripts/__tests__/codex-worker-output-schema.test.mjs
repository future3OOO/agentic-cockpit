import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { getPreflightOutputSchema } from '../lib/worker-preflight-prompt.mjs';

async function loadSchema() {
  const schemaPath = path.join(
    process.cwd(),
    'docs',
    'agentic',
    'agent-bus',
    'CODEX_WORKER_OUTPUT.schema.json',
  );
  return JSON.parse(await fs.readFile(schemaPath, 'utf8'));
}

function includesObjectType(schemaNode) {
  if (!schemaNode || typeof schemaNode !== 'object') return false;
  const t = schemaNode.type;
  if (typeof t === 'string') return t === 'object';
  if (Array.isArray(t)) return t.includes('object');
  return Boolean(schemaNode.properties && typeof schemaNode.properties === 'object');
}

test('worker output schema: top-level required contains every property key', async () => {
  const schema = await loadSchema();
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
  const schema = await loadSchema();

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
  const schema = await loadSchema();
  const reviewType = schema?.properties?.review?.type;
  assert.ok(Array.isArray(reviewType), 'review.type must be an array');
  assert.equal(reviewType.includes('object'), true);
  assert.equal(reviewType.includes('null'), true);
});

test('worker output schema: autopilotControl supports null and enforces full object coverage', async () => {
  const schema = await loadSchema();
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
  const schema = await loadSchema();
  const runtimeGuardType = schema?.properties?.runtimeGuard?.type;
  assert.ok(Array.isArray(runtimeGuardType), 'runtimeGuard.type must be an array');
  assert.deepEqual(runtimeGuardType, ['null']);
});

test('worker output schema: preflightPlan is required and covers the writer preflight contract', async () => {
  const schema = await loadSchema();
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  assert.equal(required.has('preflightPlan'), true);

  const preflightPlan = schema?.properties?.preflightPlan ?? {};
  const typeValues = Array.isArray(preflightPlan.type) ? preflightPlan.type : [preflightPlan.type];
  assert.equal(typeValues.includes('object'), true);
  assert.equal(typeValues.includes('null'), true);

  const expectedKeys = [
    'goal',
    'reusePath',
    'modularityPlan',
    'chosenApproach',
    'rejectedApproaches',
    'touchpoints',
    'coupledSurfaces',
    'riskChecks',
    'openQuestions',
  ].sort();
  const propertyKeys = Object.keys(preflightPlan.properties || {}).sort();
  const nestedRequired = Array.isArray(preflightPlan.required) ? [...preflightPlan.required].sort() : [];
  assert.deepEqual(propertyKeys, expectedKeys);
  assert.deepEqual(nestedRequired, expectedKeys);
});

test('worker output schema: preflight prompt schema matches the persisted preflightPlan contract', async () => {
  const schema = await loadSchema();
  const preflightPromptSchema = getPreflightOutputSchema();
  assert.deepEqual(
    preflightPromptSchema?.properties?.preflightPlan,
    schema?.properties?.preflightPlan,
  );
});
