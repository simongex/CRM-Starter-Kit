export const config = { runtime: 'edge' };

/* Daily review of mail Alex and Sam received. People who are not
   contacts yet, and whose message looks like a real correspondence, are
   added to the Review list. No-reply, shared mailboxes, and advertisements
   are left out. Dismissed addresses are not suggested again. The Gmail
   query looks back 3 days and skips addresses already proposed or
   dismissed, so a daily run catches everything since the last one.

   Schedule in vercel.json: 15 8 * * * (08:15 UTC, 15 minutes after contact
   notes). The Hobby plan allows one run a day. The London-hours check still
   refuses a run before 08:00 or after 19:59 Europe/London.
   Auth: Authorization: Bearer CRON_SECRET. */

import { json, kvStore } from '../../lib/internal-auth.js';
import { withinLondonWorkHours } from '../../lib/cron-hours.js';
import { updateContactsDoc } from '../../lib/contacts.js';
import { loadGmailTokens, reviewInboxes, saveGmailTokens } from '../../lib/contact-integrations.js';

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || '';
  return Boolean(secret) && (request.headers.get('authorization') || '') === `Bearer ${secret}`;
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  if (!withinLondonWorkHours()) return json({ ok: true, skipped: 'outside hours' });

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    const tokens = await loadGmailTokens(target);
    let result = { mailboxes: 0, read: 0, proposed: 0, skipped: true };
    await updateContactsDoc(target, async (state) => {
      result = await reviewInboxes(state, tokens);
      if (result.skipped) return { skip: true };
      return { updatedBy: 'cron' };
    });
    await saveGmailTokens(target, tokens);
    console.log(`inbox review: ${result.mailboxes} mailboxes, ${result.read} messages, ${result.proposed} waiting`);
    return json({ ok: true, ...result });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not review the inbox. Try again.' }, 502);
  }
}
