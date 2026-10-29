export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

/* Manual pass of the same job as the morning cron: look for new Gmail
   threads and Granola meetings, write the interaction notes that are due,
   and save before the free plan cuts the function off. Nothing new is a
   finished sync, not a failure. */

import { envUsers, isManager, json, kvCommand, kvStore, loadPasswordMap, readSession } from '../lib/internal-auth.js';
import { serve } from '../lib/node-handler.js';
import {
  CONTACTS_KEY,
  contactsStateFor,
  emptyContactsState,
  integrationStatus,
  internalEmailSet,
  internalNameSet,
  memberDirectory,
  normalizeContactsState
} from '../lib/contacts.js';
import { accountForUser, loadGmailTokens, saveGmailTokens } from '../lib/contact-integrations.js';
import {
  NOTES_CURSOR_KEY,
  mergeCronNotes,
  runContactNotes,
  skipInternalOnlyThreads,
  stripUnwrittenInternalNotes,
  syncResultMessage
} from '../lib/contact-notes.js';

function readJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const identity = await readSession(request);
  if (!identity) return json({ error: 'Not signed in' }, 401);
  const manager = isManager(identity.user);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);

  try {
    const raw = await kvCommand(target, ['GET', CONTACTS_KEY]);
    const current = readJson(raw) || { updatedAt: 0, updatedBy: '', state: emptyContactsState() };
    const startedAt = String(current.updatedAt || 0);
    let profiles = null;
    try {
      profiles = await kvCommand(target, ['HGETALL', 'kb:profiles']);
    } catch {
      profiles = null;
    }
    const tokens = await loadGmailTokens(target);
    const state = normalizeContactsState(current.state);
    let cursor = {};
    try {
      cursor = readJson(await kvCommand(target, ['GET', NOTES_CURSOR_KEY])) || {};
    } catch {
      cursor = {};
    }
    const result = await runContactNotes({ state, tokens, cursor, profiles });
    const latestRaw = await kvCommand(target, ['GET', CONTACTS_KEY]);
    const latest = readJson(latestRaw) || current;
    let saved = state;
    if (String(latest.updatedAt || 0) !== startedAt) {
      const fresh = normalizeContactsState(latest.state);
      mergeCronNotes(fresh, state, result.snapshot);
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
    await kvCommand(target, ['SET', NOTES_CURSOR_KEY, JSON.stringify(result.cursor)]);
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
      message: syncResultMessage(result.stats),
      result: result.stats,
      members: memberDirectory(profiles, accountIds),
      integrations: integrationStatus(accountForUser(tokens, identity.user))
    });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not sync contacts. Try again.' }, 502);
  }
}

export default serve(handler);
