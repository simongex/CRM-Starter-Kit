export const config = { runtime: 'edge' };

import { json, readSession, sessionCookies } from '../lib/internal-auth.js';

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);
  const cookies = await sessionCookies(request, identity);
  return json({ ok: true, user: identity.user, email: identity.email }, 200, cookies);
}
