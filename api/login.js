export const config = { runtime: 'edge' };

import {
  clearLoginFailures,
  clientIp,
  json,
  loginBlocked,
  parseIdentity,
  passwordMatches,
  recordLoginFailure,
  sessionCookies,
  sessionSecret
} from '../lib/internal-auth.js';

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  if (!sessionSecret()) {
    return json({ error: 'Access is not configured yet. Set INTERNAL_SESSION_SECRET in Vercel.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const identity = parseIdentity(body.user || body.email || '');
  const password = String(body.password || '');
  if (!identity.user || !password) {
    return json({ error: 'Enter your email and password.' }, 400);
  }

  const ip = clientIp(request);
  try {
    if (await loginBlocked(identity.user, ip)) {
      return json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
    }
    const ok = await passwordMatches(identity.user, password);
    if (!ok) {
      await recordLoginFailure(identity.user, ip);
      return json({ error: 'That email and password did not match.' }, 401);
    }
    await clearLoginFailures(identity.user);
  } catch (error) {
    console.error(error);
    return json({ error: 'Sign-in is temporarily unavailable. Try again.' }, 503);
  }

  const cookies = await sessionCookies(request, identity);
  return json({ ok: true, user: identity.user, email: identity.email }, 200, cookies);
}
