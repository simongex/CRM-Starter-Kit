export const config = {
  runtime: 'nodejs',
  maxDuration: 60
};

/* Daily interaction notes. One Gmail thread or Granola meeting becomes one
   note per contact. Each run checks this week's meetings and recent mail
   first, writes the titles and summaries, then continues the older backfill
   only if time is left. The run stops inside the free plan's 60-second
   limit so the save actually happens. The cursor is stored in KV, so the
   next day's run continues anything still unfinished.

   Schedule in vercel.json: 0 8 * * * (08:00 UTC, which is 08:00 GMT or
   09:00 BST). The Hobby plan allows one run a day. The London-hours check
   still refuses a run before 08:00 or after 19:59 Europe/London.
   Auth: Authorization: Bearer CRON_SECRET. */

import { json, kvCommand, kvStore } from '../../lib/internal-auth.js';
import { serve } from '../../lib/node-handler.js';
import { withinLondonWorkHours } from '../../lib/cron-hours.js';
import {
  CONTACTS_KEY,
  emptyContactsState,
  internalEmailSet,
  internalNameSet,
  normalizeContactsState
} from '../../lib/contacts.js';
import { loadGmailTokens, saveGmailTokens } from '../../lib/contact-integrations.js';
import {
  NOTES_CURSOR_KEY,
  mergeCronNotes,
  runContactNotes,
  skipInternalOnlyThreads,
  stripUnwrittenInternalNotes
} from '../../lib/contact-notes.js';

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || '';
  return Boolean(secret) && (request.headers.get('authorization') || '') === `Bearer ${secret}`;
}

function readJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return JSON.parse(raw);
  return raw;
}

async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  if (!withinLondonWorkHours()) return json({ ok: true, skipped: 'outside hours' });

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
      updatedBy: 'cron',
      state: normalizeContactsState(saved)
    };
    await kvCommand(target, ['SET', CONTACTS_KEY, JSON.stringify(doc)]);
    await kvCommand(target, ['SET', NOTES_CURSOR_KEY, JSON.stringify(result.cursor)]);
    await saveGmailTokens(target, tokens);
    const fields = (result.stats.granolaFields || []).slice(0, 30).join(', ');
    console.log(`contact notes: ${result.stats.written} written, ${result.stats.skipped} skipped, ${result.stats.remaining} remaining, ${result.stats.removedInternal} removed from internal contacts, ${result.stats.gmailThreads} threads, ${result.stats.granolaNotes} meetings${fields ? `, granola sourceField: ${fields}` : ''}`);
    return json({ ok: true, stats: result.stats, cursor: result.cursor });
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not update interaction notes. Try again.' }, 502);
  }
}

export default serve(handler);
