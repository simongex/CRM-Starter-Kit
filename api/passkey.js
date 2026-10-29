export const config = { runtime: 'edge' };

import {
  clearLoginFailures,
  clientIp,
  json,
  loginBlocked,
  readSession,
  recordLoginFailure,
  sessionCookies,
  sessionSecret
} from '../lib/internal-auth.js';
import {
  PasskeyError,
  loginOptions,
  passkeyCount,
  registerOptions,
  verifyLogin,
  verifyRegistration
} from '../lib/passkeys.js';

function failureBucket(ip) {
  return `passkey:${ip || 'unknown'}`;
}

export default async function handler(request) {
  if (!sessionSecret()) {
    return json({ error: 'Access is not configured yet. Set INTERNAL_SESSION_SECRET in Vercel.' }, 503);
  }

  if (request.method === 'GET') {
    const session = await readSession(request);
    if (!session) return json({ error: 'Not signed in' }, 401);
    try {
      return json({ count: await passkeyCount(session.user) });
    } catch (error) {
      if (error instanceof PasskeyError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Passkeys are temporarily unavailable.' }, 503);
    }
  }

  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }

  const step = body?.step;
  const ip = clientIp(request);
  const bucket = failureBucket(ip);

  try {
    if (step === 'register-options' || step === 'register') {
      const session = await readSession(request);
      if (!session) return json({ error: 'Not signed in' }, 401);
      if (step === 'register-options') return json(await registerOptions(request, session.user));
      await verifyRegistration(request, session.user, body);
      return json({ ok: true });
    }

    if (step === 'login-options') {
      if (await loginBlocked(bucket, ip)) {
        return json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
      }
      return json(await loginOptions(request));
    }

    if (step === 'login') {
      if (await loginBlocked(bucket, ip)) {
        return json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429);
      }
      let identity;
      try {
        identity = await verifyLogin(request, body);
      } catch (error) {
        if (error instanceof PasskeyError && error.status === 401) await recordLoginFailure(bucket, ip);
        throw error;
      }
      await clearLoginFailures(bucket);
      await clearLoginFailures(identity.user);
      const cookies = await sessionCookies(request, identity);
      return json({ ok: true, user: identity.user, email: identity.email }, 200, cookies);
    }

    return json({ error: 'Bad request' }, 400);
  } catch (error) {
    if (error instanceof PasskeyError) return json({ error: error.message }, error.status);
    console.error(error);
    return json({ error: 'Passkeys are temporarily unavailable. Try again.' }, 503);
  }
}
