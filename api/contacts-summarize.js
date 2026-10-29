export const config = { runtime: 'edge' };

import { isManager, json, kvStore, kvCommand, readSession } from '../lib/internal-auth.js';
import {
  CONTACTS_KEY,
  contactsStateFor,
  emptyContactsState,
  integrationStatus,
  isManagerOnlyContact,
  normalizeContactsState
} from '../lib/contacts.js';
import {
  accountForUser,
  loadGmailTokens,
  summarizeContact,
  summarizeStale
} from '../lib/contact-integrations.js';

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || '';
  return Boolean(secret) && (request.headers.get('authorization') || '') === `Bearer ${secret}`;
}

async function loadState(target) {
  const raw = await kvCommand(target, ['GET', CONTACTS_KEY]);
  if (!raw) return { updatedAt: 0, updatedBy: '', state: emptyContactsState() };
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return {
    updatedAt: doc.updatedAt || 0,
    updatedBy: doc.updatedBy || 'cron',
    state: normalizeContactsState(doc.state)
  };
}

export default async function handler(request) {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const identity = await readSession(request);
  const cron = cronAuthorized(request);
  if (!identity && !cron) return json({ error: 'Not signed in' }, 401);
  const manager = cron || isManager(identity.user);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    const current = await loadState(target);
    const state = current.state;
    let body = {};
    if (request.method === 'POST') {
      body = await request.json().catch(() => ({}));
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return json({ error: 'Set ANTHROPIC_API_KEY to generate relationship summaries.' }, 501);
    }

    if (!manager && !body.contactId) {
      return json({ error: 'Choose a contact to summarise.' }, 400);
    }

    const result = body.contactId
      ? await (async () => {
        const contact = state.contacts.find((item) => item.id === body.contactId);
        if (!contact || (!manager && isManagerOnlyContact(contact, state.categories))) {
          return { done: [], errors: [{ id: body.contactId, error: 'Contact not found' }] };
        }
        await summarizeContact(contact, state.sources);
        state.lastSummarizeAt = new Date().toISOString();
        return { done: [contact.id], errors: [] };
      })()
      : await summarizeStale(state, { limit: cron ? 8 : 4 });

    const doc = {
      updatedAt: Date.now(),
      updatedBy: identity?.user || 'cron',
      state
    };
    await kvCommand(target, ['SET', CONTACTS_KEY, JSON.stringify(doc)]);
    const tokens = await loadGmailTokens(target);
    return json({
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      state: contactsStateFor(state, manager),
      result,
      integrations: integrationStatus(accountForUser(tokens, identity?.user || ''))
    });
  } catch (error) {
    console.error(error);
    const message = String(error?.message || '');
    if (message.startsWith('AI model unavailable:')) return json({ error: message }, 502);
    return json({ error: 'Could not update summaries. Try again.' }, 502);
  }
}
