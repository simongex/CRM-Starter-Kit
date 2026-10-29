export const config = { runtime: 'edge' };

import { expiredCookies, json, readSession, revokeSessions } from '../lib/internal-auth.js';

export default async function handler(request) {
  const identity = await readSession(request);
  if (identity?.user) {
    try {
      await revokeSessions(identity.user);
    } catch (error) {
      console.error(error);
      return json({ error: 'Could not sign out completely. Try again.' }, 502, expiredCookies(request));
    }
  }
  return json({ ok: true }, 200, expiredCookies(request));
}
