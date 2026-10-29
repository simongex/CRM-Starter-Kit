export const config = { runtime: 'edge' };

/* Sync stays quiet until the Mailchimp env vars exist. A missing key
   returns configured: false and does not write. Only Agreed contacts
   are sent. */

import { isManager, json, kvStore, readSession } from '../lib/internal-auth.js';
import { isManagerOnlyContact, updateContactsDoc } from '../lib/contacts.js';
import {
  deleteGroupSegment,
  mailchimpConfigured,
  pullAudienceStatuses,
  renameGroupTag,
  syncContact
} from '../lib/mailchimp.js';

export default async function handler(request) {
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);
  const manager = isManager(identity.user);
  if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);
  if (!mailchimpConfigured()) return json({ ok: true, configured: false });

  try {
    let body = {};
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Bad request' }, 400);
      }
    }

    if (request.method === 'GET') {
      if (!manager) return json({ error: 'Only Alex and Sam can pull Mailchimp statuses.' }, 403);
      let result = { updated: 0, seen: 0 };
      const saved = await updateContactsDoc(target, async (state) => {
        result = await pullAudienceStatuses(state);
        if (!result.updated) return { skip: true };
        return { updatedBy: identity.user };
      });
      return json({ ok: true, configured: true, updatedAt: saved.updatedAt, updated: result.updated });
    }

    if (body.action === 'sync-contact' || body.action === 'sync-contacts') {
      const ids = new Set(
        body.action === 'sync-contact'
          ? [String(body.id || '')]
          : (Array.isArray(body.ids) ? body.ids.map(String) : [])
      );
      ids.delete('');
      let missing = body.action === 'sync-contact';
      const results = [];
      const saved = await updateContactsDoc(target, async (state) => {
        for (const contact of state.contacts) {
          if (!ids.has(contact.id)) continue;
          if (!manager && isManagerOnlyContact(contact, state.categories)) continue;
          missing = false;
          results.push(await syncContact(state, contact));
        }
        if (missing) {
          const error = new Error('Contact not found');
          error.status = 404;
          throw error;
        }
        if (!results.length) return { skip: true };
        return { updatedBy: identity.user };
      });
      return json({
        ok: true,
        configured: true,
        updatedAt: saved.updatedAt,
        results
      });
    }

    if (!manager && (body.action === 'rename-group' || body.action === 'delete-group')) {
      return json({ error: 'Only Alex and Sam can change Mailchimp groups.' }, 403);
    }

    if (body.action === 'rename-group') {
      const result = await renameGroupTag(body.oldName, body.name);
      return json({ ok: true, configured: true, ...result });
    }

    if (body.action === 'delete-group') {
      const result = await deleteGroupSegment(body.name);
      return json({ ok: true, configured: true, ...result });
    }

    return json({ error: 'Bad request' }, 400);
  } catch (error) {
    if (error.status === 404) return json({ error: 'Contact not found' }, 404);
    console.error(error);
    return json({ error: 'Could not sync with Mailchimp. Try again.' }, 502);
  }
}
