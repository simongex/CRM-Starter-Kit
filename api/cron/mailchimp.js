export const config = { runtime: 'edge' };

/* Nightly pull of Mailchimp subscription status.
   Agreed contacts that Mailchimp reports as unsubscribed or cleaned
   become Unsubscribed here. Unsubscribed contacts that Mailchimp now
   reports as subscribed (they used the signup form) become Agreed.

   Schedule in vercel.json: 30 5 * * * (05:30 UTC).
   Does nothing when the Mailchimp env vars are unset.
   Auth: Authorization: Bearer CRON_SECRET. */

import { json, kvStore } from '../../lib/internal-auth.js';
import { updateContactsDoc } from '../../lib/contacts.js';
import { mailchimpConfigured, pullAudienceStatuses } from '../../lib/mailchimp.js';

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || '';
  return Boolean(secret) && (request.headers.get('authorization') || '') === `Bearer ${secret}`;
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  if (!mailchimpConfigured()) return json({ ok: true, configured: false });

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    let result = { updated: 0, seen: 0 };
    await updateContactsDoc(target, async (state) => {
      result = await pullAudienceStatuses(state);
      if (!result.updated) return { skip: true };
      return { updatedBy: 'cron' };
    });
    console.log(`mailchimp status: ${result.updated} contacts updated, ${result.seen} audience members`);
    return json({ ok: true, configured: true, updated: result.updated, seen: result.seen });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not pull Mailchimp status. Try again.' }, 502);
  }
}
