export const config = { runtime: 'edge' };

import {
  expiredCookies,
  hashPassword,
  json,
  kvStore,
  loadPasswordMap,
  revokeSessions,
  savePasswordMap
} from '../lib/internal-auth.js';
import { consumeResetToken } from '../lib/password-reset.js';

export default async function handler(request) {
  if (request.method !== 'POST' && request.method !== 'PUT') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!kvStore()) {
    return json({ error: 'Password changes are not available until shared storage is configured.' }, 501);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const token = String(body.token || '');
  const next = String(body.next || '');
  if (!token) return json({ error: 'This link is missing its code. Request a new one from your profile.' }, 400);
  if (next.length < 8) return json({ error: 'Use at least 8 characters for the new password.' }, 400);

  const user = await consumeResetToken(token);
  if (!user) {
    return json({ error: 'This link has expired or was already used. Request a new one from your profile.' }, 400);
  }

  const map = await loadPasswordMap();
  map[user] = await hashPassword(next);
  await savePasswordMap(map);
  try {
    await revokeSessions(user);
  } catch (error) {
    console.error(error);
  }
  return json({ ok: true }, 200, expiredCookies(request));
}
