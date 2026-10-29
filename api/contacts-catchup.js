export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

/* Update notes, one saved step at a time. "find" looks at this week's
   Gmail and Granola. "write" fills in one waiting title and summary.
   The page repeats write until the queue is clear, so a slow note cannot
   throw away the ones already finished. */

import { envUsers, isManager, json, kvCommand, kvStore, loadPasswordMap, readSession } from '../lib/internal-auth.js';
import { serve } from '../lib/node-handler.js';
import {
  CONTACTS_KEY,
  contactsStateFor,
  emptyContactsState,
  integrationStatus,
  internalEmailSet,
  internalNameSet,
  isManagerOnlyContact,
  memberDirectory,
  normalizeContactsState
} from '../lib/contacts.js';
import { accountForUser, loadGmailTokens, saveGmailTokens } from '../lib/contact-integrations.js';
import {
  NOTES_CURSOR_KEY,
  findRecentNotes,
  mergeCronNotes,
  skipInternalOnlyThreads,
  snapshotInteractions,
  stripUnwrittenInternalNotes,
  writeNextNote
} from '../lib/contact-notes.js';

function readJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

async function loadDoc(target) {
  const raw = await kvCommand(target, ['GET', CONTACTS_KEY]);
  return readJson(raw) || { updatedAt: 0, updatedBy: '', state: emptyContactsState() };
}

async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);
  const manager = isManager(identity.user);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const step = body.step === 'write' ? 'write' : 'find';
  if (step === 'write' && !process.env.ANTHROPIC_API_KEY) {
    return json({ error: 'Set ANTHROPIC_API_KEY to generate interaction notes.' }, 501);
  }

  try {
    const current = await loadDoc(target);
    const startedAt = String(current.updatedAt || 0);
    let profiles = null;
    try {
      profiles = await kvCommand(target, ['HGETALL', 'kb:profiles']);
    } catch {
      profiles = null;
    }
    const tokens = await loadGmailTokens(target);
    const state = normalizeContactsState(current.state);
    const allowContact = (contact) => manager || !isManagerOnlyContact(contact, state.categories);
    let cursor = {};
    let result;
    if (step === 'find') {
      try {
        cursor = readJson(await kvCommand(target, ['GET', NOTES_CURSOR_KEY])) || {};
      } catch {
        cursor = {};
      }
      result = await findRecentNotes({ state, tokens, cursor, profiles, budgetMs: 20_000 });
    } else {
      const skipIds = Array.isArray(body.skipIds) ? body.skipIds.map(String).slice(0, 80) : [];
      const snapshot = snapshotInteractions(state);
      result = await writeNextNote(state, tokens, { skipIds, allowContact });
      result.snapshot = snapshot;
    }
    const latest = await loadDoc(target);
    let saved = state;
    if (String(latest.updatedAt || 0) !== startedAt) {
      const fresh = normalizeContactsState(latest.state);
      if (step === 'find') {
        mergeCronNotes(fresh, state, result.snapshot);
      } else if (result.snapshot) {
        mergeCronNotes(fresh, state, result.snapshot);
      } else {
        mergeCronNotes(fresh, state, new Map());
      }
      const emails = internalEmailSet(tokens, profiles);
      const names = internalNameSet(profiles);
      stripUnwrittenInternalNotes(fresh, emails, names);
      skipInternalOnlyThreads(fresh, emails);
      saved = fresh;
    }
    const doc = {
      updatedAt: Date.now(),
      updatedBy: identity.user,
      state: normalizeContactsState(saved)
    };
    await kvCommand(target, ['SET', CONTACTS_KEY, JSON.stringify(doc)]);
    if (step === 'find' && result.cursor) {
      await kvCommand(target, ['SET', NOTES_CURSOR_KEY, JSON.stringify(result.cursor)]);
    }
    await saveGmailTokens(target, tokens);
    const accountIds = envUsers().map((entry) => entry.user);
    try {
      accountIds.push(...Object.keys(await loadPasswordMap()));
    } catch {
      /* environment accounts are still included */
    }
    return json({
      updatedAt: doc.updatedAt,
      updatedBy: doc.updatedBy,
      state: contactsStateFor(doc.state, manager),
      step,
      written: Boolean(result.written),
      remaining: Number(result.remaining ?? result.stats?.remaining) || 0,
      id: result.id || '',
      contactId: result.contactId || '',
      found: step === 'find' ? (result.stats?.gmailThreads || 0) + (result.stats?.granolaNotes || 0) : 0,
      error: result.error || '',
      members: memberDirectory(profiles, accountIds),
      integrations: integrationStatus(accountForUser(tokens, identity.user))
    });
  } catch (error) {
    console.error(error);
    const message = String(error?.message || '');
    const known = message === 'Set ANTHROPIC_API_KEY to generate interaction notes.';
    return json({ error: known ? message : 'Could not update the notes. Try again.' }, known ? 501 : 502);
  }
}

export default serve(handler);
