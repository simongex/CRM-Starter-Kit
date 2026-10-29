export const config = { runtime: 'edge' };

/* Monday digest of each person's open deadlines, sent as a Slack DM.
   Schedule in vercel.json: 0 6 * * 1 — Monday 06:00 UTC, which is 07:00
   Europe/Zurich in winter and 08:00 in summer.

   Env:
   - SLACK_BOT_TOKEN  bot token (xoxb-...) with chat:write and users:read.email
   - CRON_SECRET      random string; Vercel sends Authorization: Bearer <CRON_SECRET>

   ?dry=1 returns the messages and sends nothing.
   ?only=<username> limits the run to one INTERNAL_USERS account.
   A user who was already sent this Monday is skipped (kb:digest-sent:<Monday>:<user>,
   TTL 8 days), so a retry does not double-message. Failed sends are not marked. */

import {
  MANAGERS,
  envUsers,
  json,
  kvCommand,
  kvStore,
  ownsAction,
  parseIdentity
} from '../../lib/internal-auth.js';
import { SLACK_IDS_KEY, SLACK_ID_TTL_MS, lookupSlackId, sendDm } from '../../lib/slack.js';

const STATE_KEY = 'kb:internal-state';
const PLATFORM_URL = 'https://example.org/internal';
const SENT_TTL_SECONDS = 8 * 24 * 60 * 60;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function canonicalDate(iso) {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(iso || '').trim());
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || month < 1 || month > 12 || day < 1) return '';
  const date = new Date(Date.UTC(year, month - 1, day));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDays(iso, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function mondayOf(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!match) return '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const back = date.getUTCDay() === 0 ? 6 : date.getUTCDay() - 1;
  return shiftDays(iso, -back);
}

export function zurichToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function weekBounds(now = new Date()) {
  const today = zurichToday(now);
  const monday = mondayOf(today);
  return { today, monday, sunday: shiftDays(monday, 6) };
}

/* Mirrors weekDeadline() in internal/scripts/app.js. "Wk of 7 Sep" is the
   Sunday that ends that week. The year comes from the task start, rolling
   into the next year when the label would otherwise land more than 60 days
   before that start. */
export function weekDeadline(label, anchor, fallbackIso) {
  const match = String(label || '').match(/wk of (\d{1,2}) ([a-z]{3})/i);
  if (!match) return '';
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month < 0) return '';
  const ref = canonicalDate(anchor) || canonicalDate(fallbackIso) || zurichToday();
  const refParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ref);
  if (!refParts) return '';
  const year = Number(refParts[1]);
  const day = Number(match[1]);
  let start = canonicalDate(`${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  if (!start) return '';
  if (start < shiftDays(ref, -60)) {
    start = canonicalDate(`${year + 1}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  const weekStart = mondayOf(start);
  return weekStart ? shiftDays(weekStart, 6) : '';
}

function actionIsDone(action) {
  return action?.done === true || /^(done|complete)/i.test(String(action?.status || ''));
}

function actionDue(task, action, todayIso) {
  const explicit = canonicalDate(action?.due);
  if (explicit) return explicit;
  return weekDeadline(action?.week, task?.start, todayIso);
}

export function digestItems(tasks, user, bounds) {
  const week = [];
  const overdue = [];
  for (const task of tasks || []) {
    const actions = Array.isArray(task?.actions) ? task.actions : [];
    for (const action of actions) {
      if (!action || actionIsDone(action)) continue;
      if (!ownsAction(user, task, action)) continue;
      const due = actionDue(task, action, bounds.today);
      if (!due) continue;
      const item = {
        task: String(task?.title || '').trim() || 'Untitled',
        text: String(action?.text || '').trim() || 'Untitled',
        due
      };
      if (due < bounds.monday) overdue.push(item);
      else if (due <= bounds.sunday) week.push(item);
    }
  }
  return { week, overdue };
}

function displayDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!match) return iso || '';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTH_SHORT[date.getUTCMonth()];
  return `${weekday} ${date.getUTCDate()} ${month}`;
}

function escapeSlack(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function renderItems(items, { mrkdwn }) {
  const groups = new Map();
  const sorted = [...items].sort((a, b) => (
    a.due.localeCompare(b.due) || a.task.localeCompare(b.task) || a.text.localeCompare(b.text)
  ));
  for (const item of sorted) {
    if (!groups.has(item.task)) groups.set(item.task, []);
    groups.get(item.task).push(item);
  }
  const label = (value) => (mrkdwn ? escapeSlack(singleLine(value)) : singleLine(value));
  return [...groups.entries()].map(([task, actions]) => {
    const lines = [mrkdwn ? `*${label(task)}*` : label(task)];
    for (const action of actions) {
      lines.push(`• ${label(action.text)} — ${displayDate(action.due)}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

function chunkMrkdwn(text) {
  const chunks = [];
  let current = '';
  for (const line of String(text || '').split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 2800 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function sectionBlocks(title, items) {
  return chunkMrkdwn(`*${title}*\n${renderItems(items, { mrkdwn: true })}`).map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text }
  }));
}

function capText(text) {
  if (text.length <= 3900) return text;
  return `${text.slice(0, 3800)}\n…\nOpen internal platform: ${PLATFORM_URL}`;
}

export function buildDigest(items, bounds) {
  if (!items.week.length && !items.overdue.length) return null;
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Your deadlines', emoji: false }
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Week of ${displayDate(bounds.monday)} – ${displayDate(bounds.sunday)}`
      }]
    }
  ];
  if (items.week.length) blocks.push(...sectionBlocks('This week', items.week));
  if (items.overdue.length) blocks.push(...sectionBlocks('Overdue', items.overdue));
  const button = {
    type: 'actions',
    elements: [{
      type: 'button',
      text: { type: 'plain_text', text: 'Open internal platform', emoji: false },
      url: PLATFORM_URL,
      action_id: 'open_internal'
    }]
  };
  if (blocks.length > 48) {
    blocks.length = 47;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_Open the platform for the full list._' }
    });
  }
  blocks.push(button);

  const lines = [
    'Your deadlines',
    `Week of ${displayDate(bounds.monday)} – ${displayDate(bounds.sunday)}`
  ];
  if (items.week.length) lines.push('', 'This week', renderItems(items.week, { mrkdwn: false }));
  if (items.overdue.length) lines.push('', 'Overdue', renderItems(items.overdue, { mrkdwn: false }));
  lines.push('', `Open internal platform: ${PLATFORM_URL}`);
  return { blocks, text: capText(lines.join('\n')) };
}

function cronAuthorized(request) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return false;
  return (request.headers.get('authorization') || '') === `Bearer ${secret}`;
}

function emailFor(user) {
  return parseIdentity(user).email;
}

function sentKey(monday, user) {
  return `kb:digest-sent:${monday}:${user}`;
}

function cachedSlackId(raw) {
  if (!raw) return '';
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return '';
    }
  }
  if (!data || typeof data.id !== 'string' || !data.id) return '';
  if (typeof data.at !== 'number' || Date.now() - data.at >= SLACK_ID_TTL_MS) return '';
  return data.id;
}

function isStoreError(error) {
  return /store responded/.test(String(error?.message || ''));
}

function reasonFrom(error) {
  const code = error?.code || '';
  if (code === 'users_not_found') return error.message;
  if (code === 'ratelimited') return 'Slack rate limit';
  if (code === 'no_token') return 'SLACK_BOT_TOKEN is not set';
  if (code === 'not_dm') return 'Slack id was not a direct message';
  const detail = String(error?.message || 'Unknown error');
  return detail.length > 180 ? `${detail.slice(0, 177)}…` : detail;
}

async function loadTasks(target) {
  const raw = await kvCommand(target, ['GET', STATE_KEY]);
  if (!raw) return [];
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const tasks = doc?.state?.tasks;
  return Array.isArray(tasks) ? tasks : [];
}

async function alreadySent(target, monday, user) {
  const raw = await kvCommand(target, ['GET', sentKey(monday, user)]);
  return raw != null && raw !== '';
}

async function claimSend(target, monday, user) {
  const result = await kvCommand(target, [
    'SET', sentKey(monday, user), String(Date.now()), 'NX', 'EX', String(SENT_TTL_SECONDS)
  ]);
  return result === 'OK';
}

async function releaseSend(target, monday, user) {
  try {
    await kvCommand(target, ['DEL', sentKey(monday, user)]);
  } catch {
    console.error(`weekly digest: could not clear send lock for ${user}`);
  }
}

async function resolveSlackId(target, user, email) {
  const raw = await kvCommand(target, ['HGET', SLACK_IDS_KEY, user]);
  const cached = cachedSlackId(raw);
  if (cached) return cached;
  const id = await lookupSlackId(email);
  /* Hash fields have no per-field TTL, so the value is { id, at } and is
     treated as expired after 7 days. */
  try {
    await kvCommand(target, ['HSET', SLACK_IDS_KEY, user, JSON.stringify({ id, at: Date.now() })]);
  } catch {
    console.error(`weekly digest: could not cache Slack id for ${user}`);
  }
  return id;
}

function managerCopy(missed) {
  const noun = missed.length === 1 ? 'person' : 'people';
  const text = [
    `Weekly digest missed ${missed.length} ${noun}:`,
    ...missed.map((item) => `• ${item.user} — ${item.reason}`)
  ].join('\n');
  const blocks = [{
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: [
        `Weekly digest missed ${missed.length} ${noun}:`,
        ...missed.map((item) => `• ${escapeSlack(item.user)} — ${escapeSlack(item.reason)}`)
      ].join('\n')
    }
  }];
  return { text, blocks };
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  if (!cronAuthorized(request)) return json({ error: 'Unauthorized' }, 401);

  const target = kvStore();
  if (!target) return json({ error: 'Shared storage is not configured' }, 501);
  if (!process.env.SLACK_BOT_TOKEN) return json({ error: 'SLACK_BOT_TOKEN is not set' }, 501);

  const url = new URL(request.url);
  const dry = url.searchParams.get('dry') === '1';
  const only = parseIdentity(url.searchParams.get('only') || '').user;
  const accounts = [...new Set(envUsers().map((entry) => entry.user))];
  if (only && !accounts.includes(only)) {
    return json({ error: `No account named ${only}.` }, 404);
  }

  const bounds = weekBounds();
  const users = only ? [only] : accounts;

  try {
    const tasks = await loadTasks(target);
    const results = [];
    const missed = [];

    for (const user of users) {
      try {
        const items = digestItems(tasks, user, bounds);
        const message = buildDigest(items, bounds);
        if (!message) {
          results.push({ user, send: false, reason: 'Nothing due this week' });
          continue;
        }
        const email = emailFor(user);
        const already = await alreadySent(target, bounds.monday, user);
        if (!dry && already) {
          results.push({ user, send: false, reason: 'Already sent this week' });
          continue;
        }
        const slackId = await resolveSlackId(target, user, email);
        if (dry) {
          const row = {
            user,
            email,
            slackId,
            send: !already,
            text: message.text,
            blocks: message.blocks
          };
          if (already) row.reason = 'Already sent this week';
          results.push(row);
          continue;
        }
        if (!(await claimSend(target, bounds.monday, user))) {
          results.push({ user, send: false, reason: 'Already sent this week' });
          continue;
        }
        try {
          await sendDm(slackId, message.blocks, message.text);
          results.push({ user, email, send: true });
        } catch (error) {
          await releaseSend(target, bounds.monday, user);
          throw error;
        }
      } catch (error) {
        if (isStoreError(error)) throw error;
        const reason = reasonFrom(error);
        missed.push({ user, reason });
        results.push({ user, send: false, reason });
        console.error(`weekly digest: ${user}: ${reason}`);
      }
    }

    let managerAlert = null;
    if (missed.length) {
      const copy = managerCopy(missed);
      if (dry) {
        managerAlert = { text: copy.text, blocks: copy.blocks, sent: [], errors: [] };
      } else {
        const sent = [];
        const errors = [];
        for (const manager of MANAGERS) {
          try {
            const slackId = await resolveSlackId(target, manager, emailFor(manager));
            await sendDm(slackId, copy.blocks, copy.text);
            sent.push(manager);
          } catch (error) {
            if (isStoreError(error)) throw error;
            const reason = reasonFrom(error);
            errors.push({ user: manager, reason });
            console.error(`weekly digest alert: ${manager}: ${reason}`);
          }
        }
        managerAlert = { sent, errors };
      }
    }

    console.log(`weekly digest: ${dry ? 'dry ' : ''}${results.filter((item) => item.send).length} to send, ${missed.length} missed`);
    return json({
      ok: true,
      dry,
      monday: bounds.monday,
      sunday: bounds.sunday,
      results,
      missed,
      managerAlert
    }, 200);
  } catch (error) {
    console.error(error);
    return json({ error: 'Could not build the weekly digest. Try again.' }, 502);
  }
}
