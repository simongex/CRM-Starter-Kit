import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/contacts-sync.js';

test('a Node-style sync request returns JSON instead of crashing', async () => {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code) { status = code; },
    end(payload) { body = String(payload); }
  };
  const req = {
    method: 'POST',
    url: '/api/contacts-sync',
    headers: { host: 'example.org', 'x-forwarded-proto': 'https' }
  };
  await handler(req, res);
  assert.equal(status, 401);
  assert.equal(JSON.parse(body).error, 'Not signed in');
});
