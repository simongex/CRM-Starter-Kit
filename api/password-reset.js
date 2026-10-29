export const config = { runtime: 'edge' };

import { json, kvStore, readSession } from '../lib/internal-auth.js';
import {
  claimResetSlot,
  createResetToken,
  emailConfigured,
  sendResetEmail,
  siteOrigin
} from '../lib/password-reset.js';

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);

  if (!kvStore()) {
    return json({ error: 'Password changes are not available until shared storage is configured.' }, 501);
  }
  if (!emailConfigured()) {
    return json({ error: 'Email sending is not set up yet. Add RESEND_API_KEY in Vercel.' }, 501);
  }

  try {
    if (!(await claimResetSlot(identity.user))) {
      return json({ error: 'A link was just sent. Check your inbox, or try again in a minute.' }, 429);
    }
    const token = await createResetToken(identity.user);
    const link = `${siteOrigin(request)}/internal/reset?token=${encodeURIComponent(token)}`;
    await sendResetEmail(identity.email, link);
    return json({ ok: true, email: identity.email }, 200);
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not send the email. Try again later.' }, 502);
  }
}
