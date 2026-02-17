import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';

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
    assert.equal(required.has(key), true, `missing top-level required key: ${key}`);
  }
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
