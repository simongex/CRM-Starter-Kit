export const config = { runtime: 'edge' };

import { isManager, json, kvCommand, kvStore, readSession } from '../lib/internal-auth.js';
import {
  CONTACTS_KEY,
  contactsStateFor,
  emptyContactsState,
  integrationStatus,
  isManagerOnlyContact,
  normalizeContactsState
} from '../lib/contacts.js';
import { accountForUser, loadGmailTokens, saveGmailTokens } from '../lib/contact-integrations.js';
import { rerunInteraction } from '../lib/contact-notes.js';

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);
  const manager = isManager(identity.user);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: 'Set ANTHROPIC_API_KEY to generate interaction notes.' }, 501);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Bad request' }, 400);
  }
  if (!body.contactId || !body.interactionId) return json({ error: 'Bad request' }, 400);

  try {
    const raw = await kvCommand(target, ['GET', CONTACTS_KEY]);
    const current = raw
      ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
      : { updatedAt: 0, updatedBy: '', state: emptyContactsState() };
    const state = normalizeContactsState(current.state);
    const contact = state.contacts.find((item) => item.id === body.contactId);
    if (!manager && contact && isManagerOnlyContact(contact, state.categories)) {
      return json({ error: 'Contact not found' }, 400);
    }
    const tokens = await loadGmailTokens(target);
    await rerunInteraction(state, tokens, {
      contactId: body.contactId,
      interactionId: body.interactionId
    });
    const doc = {
      updatedAt: Date.now(),
      updatedBy: identity.user,
      state: normalizeContactsState(state)
    };
    await kvCommand(target, ['SET', CONTACTS_KEY, JSON.stringify(doc)]);
    await saveGmailTokens(target, tokens);
    return json({
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      state: contactsStateFor(doc.state, manager),
      integrations: integrationStatus(accountForUser(tokens, identity.user))
    });
  } catch (error) {
    console.error(error);
    const message = String(error?.message || 'Could not rewrite the note. Try again.');
    const known = message === 'Contact not found'
      || message === 'Note not found'
      || message === 'The source could not be read. Try again.'
      || message === 'Granola is not connected.'
      || message === 'Granola has no enhanced summary for this meeting yet.'
      || message === 'The summary was still the source outline. Try again.';
    const hidden = /key|token|secret|authorization/i.test(message);
    const errorText = known || (!hidden && message.length <= 180)
      ? message
      : 'Could not rewrite the note. Try again.';
    return json({ error: errorText }, known ? 400 : 502);
  }
}
