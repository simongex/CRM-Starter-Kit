export const config = { runtime: 'edge' };

import { envUsers, isManager, json, kvStore, kvCommand, loadPasswordMap, readSession } from '../lib/internal-auth.js';
import {
  CONTACTS_KEY,
  MAX_CONTACTS_BODY,
  contactsStateFor,
  emptyContactsState,
  integrationStatus,
  memberDirectory,
  mergeTeamContactsEdit,
  normalizeContactsState,
  scrubImportedListNotes
} from '../lib/contacts.js';
import { accountForUser, loadGmailTokens } from '../lib/contact-integrations.js';

async function readMembers(target) {
  let profiles = null;
  try {
    profiles = await kvCommand(target, ['HGETALL', 'kb:profiles']);
  } catch {
    profiles = null;
  }
  const ids = envUsers().map((entry) => entry.user);
  try {
    const passwords = await loadPasswordMap();
    ids.push(...Object.keys(passwords || {}));
  } catch {
    /* environment accounts are still included */
  }
  return memberDirectory(profiles, ids);
}

async function readDoc(target) {
  const raw = await kvCommand(target, ['GET', CONTACTS_KEY]);
  if (!raw) return { updatedAt: 0, updatedBy: '', state: emptyContactsState() };
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (doc?.state && scrubImportedListNotes(doc.state)) {
    await kvCommand(target, ['SET', CONTACTS_KEY, JSON.stringify(doc)]);
  }
  return {
    updatedAt: doc.updatedAt || 0,
    updatedBy: doc.updatedBy || '',
    state: normalizeContactsState(doc.state)
  };
}

export default async function handler(request) {
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);
  const manager = isManager(identity.user);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    if (request.method === 'GET') {
      const doc = await readDoc(target);
      const tokens = await loadGmailTokens(target);
      return json({
        updatedAt: doc.updatedAt,
        updatedBy: doc.updatedBy,
        state: contactsStateFor(doc.state, manager),
        members: await readMembers(target),
        integrations: integrationStatus(accountForUser(tokens, identity.user))
      });
    }

    if (request.method !== 'PUT' && request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const text = await request.text();
    if (text.length > MAX_CONTACTS_BODY) return json({ error: 'Contacts are too large to save' }, 413);

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'Bad request' }, 400);
    }
    if (!body.state || !Array.isArray(body.state.contacts) || !Array.isArray(body.state.categories)) {
      return json({ error: 'Bad request' }, 400);
    }

    const current = await readDoc(target);
    if (String(current.updatedAt || 0) !== String(body.base || 0)) {
      const tokens = await loadGmailTokens(target);
      return json({
        ...current,
        state: contactsStateFor(current.state, manager),
        members: await readMembers(target),
        integrations: integrationStatus(accountForUser(tokens, identity.user))
      }, 409);
    }

    const next = manager ? body.state : mergeTeamContactsEdit(current.state, body.state);
    const doc = {
      updatedAt: Date.now(),
      updatedBy: identity.user,
      state: normalizeContactsState(next)
    };
    await kvCommand(target, ['SET', CONTACTS_KEY, JSON.stringify(doc)]);
    return json({ updatedAt: doc.updatedAt, updatedBy: doc.updatedBy }, 200);
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not update contacts. Try again.' }, 502);
  }
}
