export const config = { runtime: 'edge' };

/* Mailchimp calls this the moment someone unsubscribes, is cleaned, or
   rejoins through the signup form. The secret is the ?key= query, checked
   before any store access so a bad key never touches contacts.
   URL: https://example.org/api/mailchimp-webhook?key=… */

import { json, kvStore, sameString } from '../lib/internal-auth.js';
import { updateContactsDoc } from '../lib/contacts.js';
import { applyMailchimpEvent } from '../lib/mailchimp.js';

const HANDLED = new Set(['unsubscribe', 'cleaned', 'subscribe']);

export function webhookKeyOk(request) {
  const secret = process.env.MAILCHIMP_WEBHOOK_SECRET || '';
  if (!secret) return false;
  let key = '';
  try {
    key = new URL(request.url).searchParams.get('key') || '';
  } catch {
    key = '';
  }
  return sameString(secret, key);
}

export default async function handler(request) {
  if (!webhookKeyOk(request)) return json({ error: 'Unauthorized' }, 401);
  if (request.method === 'GET') return json({ ok: true });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const form = new URLSearchParams(await request.text());
  const type = form.get('type') || '';
  const email = form.get('data[email]') || '';
  if (!HANDLED.has(type) || !email) return json({ ok: true, ignored: true });

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    const saved = await updateContactsDoc(target, async (state) => {
      const changed = applyMailchimpEvent(state, { type, email });
      if (!changed) return { skip: true };
      return { updatedBy: 'mailchimp' };
    });
    return json({ ok: true, updatedAt: saved.updatedAt, skipped: Boolean(saved.skipped) });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not apply the Mailchimp update.' }, 502);
  }
}
