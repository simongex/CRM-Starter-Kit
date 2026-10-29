import assert from 'node:assert/strict';
import test from 'node:test';
import { ANTHROPIC_MODEL, anthropicErrorMessage } from './ai.js';

test('a missing Anthropic model is reported by name', () => {
  const message = anthropicErrorMessage({
    error: { type: 'not_found_error', message: 'model: claude-sonnet-4-5' }
  }, 404);
  assert.equal(message, `AI model unavailable: ${ANTHROPIC_MODEL}`);
  assert.doesNotMatch(message, /^model:/);
});

test('other Anthropic errors keep their message', () => {
  assert.equal(
    anthropicErrorMessage({ error: { message: 'Rate limited' } }, 429),
    'Rate limited'
  );
  assert.equal(anthropicErrorMessage({}, 500), 'Anthropic 500');
});
