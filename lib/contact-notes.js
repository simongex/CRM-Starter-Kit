import { EMAIL_DOMAIN } from './internal-auth.js';
import {
  DEFAULT_RELEVANCE_VOCABULARY,
  TEAM_MEMBERS,
  internalEmailSet,
  internalNameSet,
  isInternalAddress,
  isInternalContact,
  normalizeInteraction,
  touchDates
} from './contacts.js';
import { gmailAccessToken, gmailGet, granolaGet } from './contact-integrations.js';
import { ANTHROPIC_MODEL, anthropicErrorMessage } from './ai.js';
import { meetingTitle, writeNote } from './note-style.js';

export const NOTES_CURSOR_KEY = 'kb:contact-notes-cursor';

const MAX_MESSAGE_CHARS = 6_000;
const MAX_SOURCE_CHARS = 40_000;
const GRANOLA_SOURCE_CHARS = 12_000;
const GMAIL_TAIL_KEEP = 5;
const GMAIL_FULL_PER_RUN = 4;
const GMAIL_EXAMINE_PER_RUN = 30;
const RECENT_FULL_PER_RUN = 8;
const RECENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECENT_OVERLAP_MS = 60 * 60 * 1000;
const GRANOLA_PER_RUN = 5;
const GRANOLA_RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const FIND_MS = 18_000;
const GRANOLA_FIND_MS = 10_000;
/* The free Vercel plan stops a function at 60 seconds. Loading the contacts
   and saving the result sit outside this budget, so the work itself stops
   at 52 seconds and the save still lands. A longer run was being killed
   before any note was stored. */
export const BUDGET_MS = 52_000;
/* Recent mail and meetings are collected first. The rest of the run writes
   titles and summaries, so a new note is not left blank. Older backfill
   runs only when that writing has already finished. */
const WRITE_MIN_REMAINING = 7_000;

function recentPageTokens(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [user, token] of Object.entries(raw)) {
    const id = String(user || '').trim().toLowerCase();
    const value = String(token || '').slice(0, 300);
    if (id && value) out[id] = value;
  }
  return out;
}

export function normalizeCursor(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const recentAt = Date.parse(src.lastRecentScanAt || '');
  return {
    mailboxIndex: Math.max(0, Number(src.mailboxIndex) || 0),
    contactIndex: Math.max(0, Number(src.contactIndex) || 0),
    pageToken: String(src.pageToken || ''),
    seenThreads: Array.isArray(src.seenThreads) ? src.seenThreads.map(String).slice(-400) : [],
    granolaCursor: String(src.granolaCursor || ''),
    seenNotes: Array.isArray(src.seenNotes) ? src.seenNotes.map(String).slice(-200) : [],
    writeIndex: Math.max(0, Number(src.writeIndex) || 0),
    lastRecentScanAt: Number.isNaN(recentAt) ? '' : new Date(recentAt).toISOString(),
    recentPageTokens: recentPageTokens(src.recentPageTokens),
    recentDone: Array.isArray(src.recentDone)
      ? [...new Set(src.recentDone.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))].slice(0, 20)
      : [],
    recentSeen: Array.isArray(src.recentSeen) ? src.recentSeen.map(String).slice(-500) : []
  };
}

/* First run looks back a day. Later runs start from the last pass that finished,
   with an hour of overlap so a thread saved near the boundary is not missed. */
export function recentAfterSeconds(lastRecentScanAt, now) {
  const parsed = Date.parse(lastRecentScanAt || '');
  const anchor = Number.isNaN(parsed) ? now - RECENT_LOOKBACK_MS : parsed;
  return Math.floor((anchor - RECENT_OVERLAP_MS) / 1000);
}

export function teamEmailMap(tokenMap) {
  const map = new Map();
  const add = (email, id) => {
    const address = String(email || '').trim().toLowerCase();
    const user = String(id || '').trim().toLowerCase();
    if (address && user) map.set(address, user);
  };
  for (const member of TEAM_MEMBERS) add(`${member.id}@${EMAIL_DOMAIN}`, member.id);
  for (const [user, record] of Object.entries(tokenMap || {})) {
    add(`${user}@${EMAIL_DOMAIN}`, user);
    add(record?.email, user);
  }
  return map;
}

export function isDue(interaction, now = Date.now(), { includeUpcoming = false } = {}) {
  if (!interaction || interaction.status === 'skipped') return false;
  if (!includeUpcoming && interaction.source === 'granola') {
    const at = Date.parse(interaction.activityAt || '');
    if (!Number.isNaN(at) && at > now) return false;
  }
  if (interaction.status === 'pending') return true;
  if (interaction.status === 'written') return interaction.seenHash !== interaction.sourceHash;
  return false;
}

/* Tie on message count goes to whoever sent the earliest message. */
export function chooseLead(messages, teamEmails) {
  const counts = new Map();
  const firstAt = new Map();
  const ordered = [...(messages || [])].sort((a, b) => a.at - b.at);
  for (const message of ordered) {
    const id = teamEmails.get(String(message.from || '').trim().toLowerCase());
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
    if (!firstAt.has(id)) firstAt.set(id, message.at);
  }
  let best = [];
  let max = 0;
  for (const [id, count] of counts) {
    if (count > max) {
      max = count;
      best = [id];
    } else if (count === max) best.push(id);
  }
  if (!best.length) return '';
  best.sort((a, b) => firstAt.get(a) - firstAt.get(b) || a.localeCompare(b));
  return best[0];
}

function personEmail(person) {
  if (typeof person === 'string') return String(person || '').trim().toLowerCase();
  return String(person?.email || '').trim().toLowerCase();
}

export function granolaLead(note, teamEmails) {
  const ownerId = teamEmails.get(String(note?.owner?.email || '').trim().toLowerCase());
  if (ownerId) return ownerId;
  const lists = [
    note?.attendees || [],
    note?.calendar_event?.attendees || [],
    note?.calendar_event?.invitees || []
  ];
  for (const list of lists) {
    for (const person of list) {
      const id = teamEmails.get(personEmail(person));
      if (id) return id;
    }
  }
  return teamEmails.get(String(note?.calendar_event?.organiser || '').trim().toLowerCase()) || '';
}

export function contactsMatching(contacts, participants, scope = {}) {
  const wanted = new Set(
    (participants || []).map((email) => String(email || '').trim().toLowerCase()).filter(Boolean)
  );
  if (!wanted.size) return [];
  return (contacts || []).filter((contact) => (
    !isInternalContact(contact, scope.internalEmails, scope.internalNames)
    && (contact.emails || []).some((email) => wanted.has(String(email || '').trim().toLowerCase()))
  ));
}

export function normalizeMessageId(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function headerMap(payload) {
  const map = {};
  for (const header of payload?.headers || []) {
    if (header?.name) map[header.name.toLowerCase()] = header.value || '';
  }
  return map;
}

function extractEmails(value) {
  const found = [];
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const match of String(value || '').matchAll(re)) found.push(match[0].toLowerCase());
  return found;
}

function decodeBase64Url(data) {
  const b64 = String(data || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!b64) return '';
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function plainFromPayload(payload) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    const type = String(part.mimeType || '').toLowerCase();
    if (part.body?.data && type.startsWith('text/plain')) plain.push(decodeBase64Url(part.body.data));
    else if (part.body?.data && type.startsWith('text/html')) html.push(decodeBase64Url(part.body.data));
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);
  const text = plain.join('\n').trim() || htmlToText(html.join('\n')).trim();
  return text;
}

export function stripQuotedEmail(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^-- ?$/.test(trimmed)) break;
    if (/^sent from my /i.test(trimmed)) break;
    if (/^von meinem .+ gesendet/i.test(trimmed)) break;
    if (/^get outlook for/i.test(trimmed)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    if (/^on .+ wrote:\s*$/i.test(trimmed)) break;
    if (/^am .+ schrieb/i.test(trimmed)) break;
    if (/^le .+ a écrit/i.test(trimmed)) break;
    if (/^el .+ escribió/i.test(trimmed)) break;
    if (/^>/.test(trimmed)) {
      if (kept.some((item) => item.trim())) break;
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function clip(text, max) {
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max).trim()}...`;
}

function firstLine(text) {
  const line = String(text || '').split('\n').find((item) => item.trim());
  return String(line || '').trim().slice(0, 200);
}

/* Keep the opening message and the latest messages whole. Shorten the middle
   so a long thread still ends on the most recent mail. */
function packGmailMessages(blocks, max = MAX_SOURCE_CHARS) {
  const joined = blocks.map((block) => block.full).join('\n\n');
  if (joined.length <= max || blocks.length <= 1) {
    return joined.length <= max ? joined : clip(joined, max);
  }
  const tailCount = Math.min(GMAIL_TAIL_KEEP, blocks.length - 1);
  const head = blocks[0];
  const tail = blocks.slice(-tailCount);
  const middle = blocks.slice(1, blocks.length - tailCount);
  const tailText = tail.map((block) => block.full).join('\n\n');
  const marker = `[${middle.length} earlier messages shortened]`;
  let lines = middle.map((block) => block.preview).filter(Boolean);
  const assemble = (kept) => [head.full, middle.length ? [marker, ...kept].join('\n') : '', tailText]
    .filter(Boolean)
    .join('\n\n');
  let packed = assemble(lines);
  while (lines.length && packed.length > max) {
    lines = lines.slice(1);
    packed = assemble(lines);
  }
  if (packed.length <= max) return packed;
  const shortened = middle.length ? marker : '';
  const overhead = (shortened ? shortened.length + 2 : 0) + (tailText ? tailText.length + 2 : 0);
  const headBudget = Math.max(0, max - overhead);
  const headText = head.full.length <= headBudget ? head.full : clip(head.full, headBudget);
  return [headText, shortened, tailText].filter(Boolean).join('\n\n');
}

function isoFrom(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function isDraftMessage(message) {
  return (message?.labelIds || []).includes('DRAFT');
}

function threadIsDraftOnly(thread) {
  const messages = thread?.messages || [];
  return messages.length > 0 && messages.every((message) => isDraftMessage(message));
}

/* A draft that was stored before it was sent should disappear, so sending it
   later can create a real note. A note that was already written stays. */
function dropPendingDraftThread(state, user, threadId) {
  if (!threadId) return;
  for (const contact of state.contacts || []) {
    if (!Array.isArray(contact.interactions)) continue;
    contact.interactions = contact.interactions.filter((item) => !(
      item?.source === 'gmail'
      && item.status === 'pending'
      && item.threadUser === user
      && item.threadId === threadId
    ));
  }
}

export function gmailThreadDraft(thread, teamEmails, internalEmails = internalEmailSet()) {
  const messages = [...(thread?.messages || [])]
    .filter((message) => !isDraftMessage(message))
    .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
  if (!messages.length) return null;
  const firstHeaders = headerMap(messages[0].payload);
  const sourceKey = normalizeMessageId(firstHeaders['message-id']);
  if (!sourceKey) return null;
  const participants = new Set();
  const blocks = [];
  const leadMessages = [];
  let lastAt = 0;
  for (const message of messages) {
    const headers = headerMap(message.payload);
    for (const key of ['from', 'to', 'cc', 'reply-to']) {
      for (const email of extractEmails(headers[key])) participants.add(email);
    }
    const at = Number(message.internalDate) || Date.parse(headers.date) || 0;
    if (at > lastAt) lastAt = at;
    leadMessages.push({ from: extractEmails(headers.from)[0] || '', at });
    const text = clip(stripQuotedEmail(plainFromPayload(message.payload)), MAX_MESSAGE_CHARS);
    const full = [
      `Date: ${at ? new Date(at).toISOString() : ''}`,
      `From: ${headers.from || ''}`,
      `To: ${headers.to || ''}`,
      headers.cc ? `Cc: ${headers.cc}` : '',
      `Subject: ${headers.subject || ''}`,
      text
    ].filter(Boolean).join('\n');
    blocks.push({ full, preview: firstLine(text) || firstLine(full) });
  }
  const people = [...participants];
  if (people.length && people.every((email) => isInternalAddress(email, internalEmails))) return null;
  const activityAt = lastAt ? new Date(lastAt).toISOString() : '';
  return {
    source: 'gmail',
    sourceKey,
    date: activityAt.slice(0, 10),
    lead: chooseLead(leadMessages, teamEmails),
    participants: [...participants],
    activityAt,
    seenHash: messages.map((message) => message.id).filter(Boolean).sort().join(','),
    threadId: String(thread.id || ''),
    historyId: String(thread.historyId || ''),
    sourceText: packGmailMessages(blocks)
  };
}

function granolaPeople(note) {
  const people = [];
  const push = (person) => {
    if (!person || typeof person !== 'object') return;
    people.push({
      name: String(person.name || '').trim(),
      email: String(person.email || '').trim().toLowerCase()
    });
  };
  const pushEmail = (email) => {
    const address = String(email || '').trim().toLowerCase();
    if (address) people.push({ name: '', email: address });
  };
  push(note?.owner);
  for (const attendee of note?.attendees || []) push(attendee);
  for (const attendee of note?.calendar_event?.attendees || []) push(attendee);
  for (const invitee of note?.calendar_event?.invitees || []) {
    if (typeof invitee === 'string') pushEmail(invitee);
    else push(invitee);
  }
  pushEmail(note?.calendar_event?.organiser);
  return people;
}

function fieldText(value) {
  return String(value || '').trim();
}

export function formatTranscript(items) {
  if (!Array.isArray(items)) return '';
  return items.map((item) => {
    const speaker = item?.speaker || {};
    const name = String(speaker.name || speaker.diarization_label || speaker.attribution || speaker.source || 'Speaker').trim();
    const text = String(item?.text || '').trim();
    return text ? `${name}: ${text}` : '';
  }).filter(Boolean).join('\n');
}

/* summary_markdown is Granola's enhanced note. Private notes are the owner's
   typed notes and are merged in. Plain summary, then the transcript, are fallbacks. */
function mergeNotes(typed, summary) {
  const parts = [];
  if (typed && typed !== summary && !summary.includes(typed)) parts.push(typed);
  if (summary) parts.push(summary);
  else if (typed) parts.push(typed);
  return parts;
}

export function granolaContent(note) {
  const privateMd = fieldText(note?.private_notes_markdown);
  const summaryMd = fieldText(note?.summary_markdown)
    || fieldText(note?.enhanced_notes)
    || fieldText(note?.notes_markdown);
  const pack = (sourceField, body) => ({ sourceField, body });
  if (summaryMd) {
    const parts = mergeNotes(privateMd, summaryMd);
    return pack(
      parts.length > 1 ? 'private_notes_markdown+summary_markdown' : 'summary_markdown',
      parts.join('\n\n')
    );
  }
  const privateText = fieldText(note?.private_notes_text);
  const summaryText = fieldText(note?.summary_text) || fieldText(note?.summary);
  const typed = privateMd || privateText;
  if (summaryText || typed) {
    const parts = mergeNotes(typed, summaryText);
    let sourceField = 'summary_text';
    if (!summaryText) sourceField = privateMd ? 'private_notes_markdown' : 'private_notes_text';
    else if (parts.length > 1) sourceField = `${privateMd ? 'private_notes_markdown' : 'private_notes_text'}+summary_text`;
    return pack(sourceField, parts.join('\n\n'));
  }
  const transcript = formatTranscript(note?.transcript);
  if (transcript) return pack('transcript', transcript);
  return { sourceField: '', body: '' };
}

/* Keep the opening and the outcome. A long enhanced summary is cut in the middle. */
function fitGranolaSource(header, body, max = GRANOLA_SOURCE_CHARS) {
  const head = String(header || '').trim();
  const text = String(body || '').trim();
  if (!text) return '';
  const room = Math.max(0, max - (head ? head.length + 1 : 0));
  let bodyCut = text;
  if (text.length > room) {
    const tail = Math.min(2500, Math.floor(room / 3));
    const start = Math.max(0, room - tail - 5);
    bodyCut = `${text.slice(0, start).trim()}\n...\n${text.slice(-tail).trim()}`;
  }
  return head ? `${head}\n${bodyCut}` : bodyCut;
}

function granolaSeenHash(sourceField, body) {
  const text = String(body || '');
  const tail = text.length > 400 ? text.slice(-400) : '';
  return `${sourceField}\n${text.slice(0, 700)}\n${tail}`.slice(0, 1500);
}

export function granolaDraft(note, teamEmails) {
  const id = String(note?.id || '').trim();
  if (!id) return null;
  const people = granolaPeople(note);
  const participants = [...new Set(people.map((person) => person.email).filter(Boolean))];
  const { sourceField, body } = granolaContent(note);
  const when = note?.calendar_event?.scheduled_start_time || note?.created_at || '';
  const activityAt = isoFrom(when);
  const heading = note?.title || note?.calendar_event?.event_title || '';
  const header = [
    `Title: ${heading}`,
    `Date: ${when || ''}`,
    `Participants: ${people.map((person) => person.name || person.email).filter(Boolean).join(', ')}`
  ].join('\n');
  return {
    source: 'granola',
    sourceKey: id,
    sourceField,
    date: activityAt ? activityAt.slice(0, 10) : '',
    lead: granolaLead(note, teamEmails),
    participants,
    activityAt,
    seenHash: granolaSeenHash(sourceField, body),
    meetingTitle: meetingTitle(heading, { min: 2, max: 5 }),
    sourceText: body ? fitGranolaSource(header, `Enhanced summary:\n${body}`) : ''
  };
}

function assignMeta(interaction, draft) {
  if (draft.date) interaction.date = draft.date;
  if (draft.lead) interaction.lead = draft.lead;
  if (draft.participants) interaction.participants = draft.participants;
  if (draft.activityAt) interaction.activityAt = draft.activityAt;
  if (draft.seenHash) interaction.seenHash = draft.seenHash;
  if (draft.threadUser) interaction.threadUser = draft.threadUser;
  if (draft.threadId) interaction.threadId = draft.threadId;
  if (draft.historyId) interaction.historyId = draft.historyId;
  if (draft.sourceField) interaction.sourceField = draft.sourceField;
}

export function applyDraft(state, draft, scope = {}) {
  if (!draft?.sourceKey) return { matched: 0, created: 0, ids: [] };
  const matches = contactsMatching(state.contacts, draft.participants, scope);
  let created = 0;
  const ids = [];
  for (const contact of matches) {
    if ((contact.dismissedKeys || []).includes(draft.sourceKey)) continue;
    if (!Array.isArray(contact.interactions)) contact.interactions = [];
    const existing = contact.interactions.find((item) => item.source === draft.source && item.sourceKey === draft.sourceKey);
    if (!existing) {
      const note = normalizeInteraction({
        source: draft.source,
        sourceKey: draft.sourceKey,
        date: draft.date,
        lead: draft.lead,
        participants: draft.participants,
        status: 'pending',
        createdAt: new Date().toISOString(),
        activityAt: draft.activityAt,
        seenHash: draft.seenHash,
        threadUser: draft.threadUser || '',
        threadId: draft.threadId || '',
        historyId: draft.historyId || '',
        sourceField: draft.sourceField || '',
        title: ''
      });
      contact.interactions.push(note);
      if (isDue(note)) ids.push(note.id);
      touchDates(contact, draft.date || draft.activityAt);
      created += 1;
      continue;
    }
    if (existing.status === 'skipped') continue;
    assignMeta(existing, draft);
    if (isDue(existing)) ids.push(existing.id);
    touchDates(contact, draft.date || draft.activityAt);
  }
  return { matched: matches.length, created, ids };
}

export function listDue(state, now = Date.now(), options = {}) {
  const due = [];
  for (const contact of state.contacts || []) {
    for (const interaction of contact.interactions || []) {
      if (isDue(interaction, now, options)) due.push({ contact, interaction });
    }
  }
  due.sort((a, b) => {
    const rank = (item) => (item.interaction.source === 'granola' ? 0 : 1);
    return rank(a) - rank(b)
      || String(a.interaction.activityAt).localeCompare(String(b.interaction.activityAt))
      || String(a.interaction.id).localeCompare(String(b.interaction.id));
  });
  return due;
}

/* Pending mail that never left the platform is not a contact note. */
export function skipInternalOnlyThreads(state, internalEmails = internalEmailSet()) {
  let skipped = 0;
  for (const contact of state?.contacts || []) {
    for (const item of contact?.interactions || []) {
      if (item?.source !== 'gmail' || item.status !== 'pending') continue;
      const people = (item.participants || [])
        .map((email) => String(email || '').trim().toLowerCase())
        .filter(Boolean);
      if (!people.length || !people.every((email) => isInternalAddress(email, internalEmails))) continue;
      item.status = 'skipped';
      item.skipReason = 'internal only';
      skipped += 1;
    }
  }
  return skipped;
}

/* Drop notes that were never written from the team's own profiles. Written notes stay for review. */
export function stripUnwrittenInternalNotes(state, internalEmails, internalNames) {
  let removed = 0;
  for (const contact of state?.contacts || []) {
    if (!isInternalContact(contact, internalEmails, internalNames)) continue;
    const notes = Array.isArray(contact.interactions) ? contact.interactions : [];
    const kept = notes.filter((item) => item?.status === 'written');
    removed += notes.length - kept.length;
    contact.interactions = kept;
  }
  return removed;
}

function actionKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sameAction(left, right) {
  const a = actionKey(left);
  const b = actionKey(right);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const leftTokens = new Set(a.split(' ').filter(Boolean));
  const rightTokens = new Set(b.split(' ').filter(Boolean));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const denom = Math.min(leftTokens.size, rightTokens.size);
  return denom > 0 && shared / denom >= 0.7;
}

function copyValidatedTask(task) {
  const next = { text: task.text, owner: task.owner };
  if (task.programmeTaskId) next.programmeTaskId = task.programmeTaskId;
  if (task.programmeActionId) next.programmeActionId = task.programmeActionId;
  if (task.due) next.due = task.due;
  return next;
}

/* Validated actions stay first, unchanged. A rewrite replaces only the suggestions. */
export function mergeTasks(existingTasks, newTasks) {
  const existing = Array.isArray(existingTasks) ? existingTasks : [];
  const validated = existing.filter((task) => task?.programmeTaskId).map(copyValidatedTask);
  if (validated.length >= 20) return validated;
  const fresh = [];
  for (const task of newTasks || []) {
    const text = String(task?.text || '').trim();
    if (!text) continue;
    if (validated.some((kept) => sameAction(text, kept.text))) continue;
    fresh.push({
      text: text.slice(0, 500),
      owner: String(task?.owner || '').trim().slice(0, 120)
    });
    if (validated.length + fresh.length >= 20) break;
  }
  return [...validated, ...fresh];
}

const CRON_NOTE_FIELDS = [
  'summary',
  'status',
  'skipReason',
  'sourceHash',
  'seenHash',
  'coveredAt',
  'activityAt',
  'sourceLanguage',
  'styleWarning'
];

export function snapshotInteractions(state) {
  const byContact = new Map();
  for (const contact of state?.contacts || []) {
    const notes = new Map();
    for (const item of contact.interactions || []) {
      if (item?.id) notes.set(item.id, JSON.stringify(item));
    }
    byContact.set(contact.id, notes);
  }
  return byContact;
}

/* After a cron run, keep edits made while it was working.
   Validated actions always come from the newer copy. */
export function mergeCronNotes(freshState, cronState, snapshot) {
  const freshById = new Map((freshState?.contacts || []).map((contact) => [contact.id, contact]));
  for (const cronContact of cronState?.contacts || []) {
    const fresh = freshById.get(cronContact.id);
    if (!fresh) continue;
    if (!Array.isArray(fresh.interactions)) fresh.interactions = [];
    const prior = snapshot?.get(cronContact.id) || new Map();
    const freshNotes = new Map(fresh.interactions.filter((item) => item?.id).map((item) => [item.id, item]));
    for (const cronNote of cronContact.interactions || []) {
      if (!cronNote?.id) continue;
      const beforeJson = prior.get(cronNote.id);
      if (!beforeJson) {
        const key = `${cronNote.source}:${cronNote.sourceKey}`;
        const already = fresh.interactions.some((item) => (
          item.id === cronNote.id || `${item.source}:${item.sourceKey}` === key
        ));
        if (!already) {
          fresh.interactions.push(cronNote);
          fresh.summaryStale = true;
        }
        continue;
      }
      if (beforeJson === JSON.stringify(cronNote)) continue;
      const current = freshNotes.get(cronNote.id);
      if (!current) continue;
      const before = JSON.parse(beforeJson);
      for (const field of CRON_NOTE_FIELDS) {
        if (cronNote[field] !== before[field]) current[field] = cronNote[field];
      }
      const titleEdited = String(current.title || '') !== String(before.title || '');
      if (!titleEdited && String(cronNote.title || '').trim()) current.title = cronNote.title;
      const extracted = (cronNote.tasks || []).filter((task) => !task?.programmeTaskId);
      current.tasks = mergeTasks(current.tasks, extracted);
      fresh.summaryStale = true;
    }
  }
  return freshState;
}

function shortError(error) {
  const detail = String(error?.message || error || 'Unknown error');
  return detail.length > 180 ? `${detail.slice(0, 177)}...` : detail;
}

function modelText(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const block = blocks.find((part) => part?.type === 'text' && typeof part.text === 'string');
  return block ? block.text : '';
}

function logModelFailure(data) {
  const output = (modelText(data) || String(data?.error?.message || '')).slice(0, 500);
  console.error(`stop_reason=${String(data?.stop_reason || '')} ${output}`);
}

async function anthropicMessages({ system, user, maxTokens, output_config }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      ...(output_config ? { output_config } : {})
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    logModelFailure(data);
    throw new Error(anthropicErrorMessage(data, response.status));
  }
  return data;
}

async function anthropicComplete({ system, user, maxTokens = 4000, output_config }, allowRetry = true) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY to generate interaction notes.');
  }
  const data = await anthropicMessages({ system, user, maxTokens, output_config });
  if (allowRetry && data.stop_reason === 'max_tokens') {
    return anthropicComplete({ system, user, maxTokens: 8000, output_config }, false);
  }
  const text = modelText(data).trim();
  if (!text || data.stop_reason === 'max_tokens') {
    logModelFailure(data);
    throw new Error(text ? 'Model did not return JSON' : 'Anthropic returned an empty response.');
  }
  try {
    return JSON.parse(text);
  } catch {
    logModelFailure(data);
    throw new Error('Model did not return JSON');
  }
}

const RELEVANCE_OUTPUT_CONFIG = {
  format: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { relevant: { type: 'boolean' } },
      required: ['relevant'],
      additionalProperties: false
    }
  }
};

async function classifyRelevance(sourceText, vocabulary) {
  const list = Array.isArray(vocabulary) ? vocabulary : DEFAULT_RELEVANCE_VOCABULARY;
  const terms = list.join(', ');
  const data = await anthropicComplete({
    system: [
      'You classify whether a message or meeting is relevant to YourOrg.',
      'YourOrg is a small organisation (describe what you do here).',
      'It works with partners, funders, clients and collaborators. (Describe who you work with here.)',
      'Judge by meaning, not by English keywords. A message in any language about a project, deal, grant, or partnership is relevant even when none of the English vocabulary words appear literally.',
      `Vocabulary (English, illustrative): ${terms}.`,
      'Return JSON with relevant set to true or false.'
    ].join('\n'),
    user: `Source:\n${String(sourceText || '').slice(0, MAX_SOURCE_CHARS)}`,
    maxTokens: 200,
    output_config: RELEVANCE_OUTPUT_CONFIG
  });
  if (typeof data?.relevant !== 'boolean') throw new Error('Relevance JSON was missing relevant');
  return data.relevant;
}

function readyToWrite(interaction, now) {
  if (interaction.source === 'gmail') return true;
  const at = Date.parse(interaction.activityAt || '');
  if (Number.isNaN(at)) return true;
  return at <= now;
}

async function loadGmailDraft(interaction, tokens, teamEmails) {
  const record = tokens?.[interaction.threadUser];
  if (!record?.refresh_token || !interaction.threadId) return null;
  const access = await gmailAccessToken(record);
  const thread = await gmailGet(access, `threads/${encodeURIComponent(interaction.threadId)}?format=full`);
  if (threadIsDraftOnly(thread)) return { draftOnly: true };
  const draft = gmailThreadDraft(thread, teamEmails);
  if (!draft) return null;
  draft.threadUser = interaction.threadUser;
  return draft;
}

function transcriptTooLarge(error) {
  return /413|transcript_too_large|too large/i.test(String(error?.message || ''));
}

async function loadGranolaTranscript(id) {
  const items = [];
  let cursor = '';
  for (let page = 0; page < 30; page += 1) {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('cursor', cursor);
    const data = await granolaGet(`/notes/${encodeURIComponent(id)}/transcript?${params}`);
    items.push(...(data.transcript || []));
    if (formatTranscript(items).length >= GRANOLA_SOURCE_CHARS) break;
    if (!data.hasMore || !data.cursor) break;
    cursor = data.cursor;
  }
  return items;
}

async function loadGranolaNote(id) {
  const note = await granolaGet(`/notes/${encodeURIComponent(id)}`);
  if (granolaContent(note).body) return note;
  try {
    const withTranscript = await granolaGet(`/notes/${encodeURIComponent(id)}?include=transcript`);
    return withTranscript || note;
  } catch (error) {
    if (!transcriptTooLarge(error)) throw error;
    return { ...note, transcript: await loadGranolaTranscript(id) };
  }
}

async function loadGranolaDraft(interaction, teamEmails) {
  if (!process.env.GRANOLA_API_KEY || !interaction.sourceKey) return null;
  const note = await loadGranolaNote(interaction.sourceKey);
  return granolaDraft(note, teamEmails);
}

export async function writeInteraction(state, contact, interaction, options) {
  const { tokens, teamEmails, now = Date.now(), ignoreQuiet = false, skipRelevance = false } = options;
  if (interaction.source === 'granola' && ignoreQuiet && !process.env.GRANOLA_API_KEY) {
    throw new Error('Granola is not connected.');
  }
  const draft = interaction.source === 'granola'
    ? await loadGranolaDraft(interaction, teamEmails)
    : await loadGmailDraft(interaction, tokens, teamEmails);
  if (draft?.draftOnly && interaction.status !== 'written') {
    contact.interactions = (contact.interactions || []).filter((item) => item.id !== interaction.id);
    return 'skipped';
  }
  if (!draft?.sourceText?.trim()) {
    if (interaction.source === 'granola' && ignoreQuiet) {
      throw new Error('Granola has no enhanced summary for this meeting yet.');
    }
    return 'waiting';
  }
  assignMeta(interaction, draft);
  if (!ignoreQuiet && !readyToWrite(interaction, now)) return 'waiting';
  if (!skipRelevance && interaction.status !== 'written') {
    let relevant = true;
    try {
      relevant = await classifyRelevance(draft.sourceText, state.settings?.relevanceVocabulary);
    } catch {
      relevant = true;
    }
    if (!relevant) {
      interaction.status = 'skipped';
      interaction.skipReason = 'not YourOrg';
      interaction.sourceHash = interaction.seenHash;
      interaction.coveredAt = interaction.activityAt;
      return 'skipped';
    }
  }
  const note = await writeNote({
    sourceText: draft.sourceText,
    context: {
      contactName: contact.name,
      company: contact.company,
      lead: interaction.lead,
      meeting: interaction.source === 'granola'
    },
    complete: anthropicComplete
  });
  interaction.summary = note.summary;
  interaction.sourceLanguage = note.sourceLanguage;
  interaction.styleWarning = Boolean(note.styleWarning);
  interaction.status = 'written';
  interaction.skipReason = '';
  interaction.sourceHash = interaction.seenHash;
  interaction.coveredAt = interaction.activityAt;
  interaction.tasks = mergeTasks(interaction.tasks, note.tasks);
  if (note.title) interaction.title = note.title;
  contact.summaryStale = true;
  return 'written';
}

function storedHistory(state, user, threadId) {
  for (const contact of state.contacts || []) {
    for (const item of contact.interactions || []) {
      if (item.source === 'gmail' && item.threadUser === user && item.threadId === threadId && item.historyId) {
        return item.historyId;
      }
    }
  }
  return '';
}

function queryEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(clean) ? clean : '';
}

function connectedUsers(tokens) {
  return Object.keys(tokens || {})
    .filter((id) => tokens[id]?.refresh_token)
    .sort();
}

function recentQuery(lastRecentScanAt, now) {
  return `after:${recentAfterSeconds(lastRecentScanAt, now)} -in:spam -in:trash -in:drafts -category:promotions -category:social`;
}

function rememberFresh(stats, applied) {
  if (applied?.ids?.length) stats.freshIds.push(...applied.ids);
}

/* Search new mail in every mailbox before the contact-by-contact walk.
   A thread already stored with the same historyId is not fetched again.
   recentSeen remembers threads fetched while this pass is still unfinished,
   including mail that matches no contact, so the next run does not spend
   its fetch cap on the same page. */
async function scanRecentGmail(state, tokens, teamEmails, cursor, deadline, stats, now, scope) {
  const users = connectedUsers(tokens);
  if (!users.length) return;
  const q = recentQuery(cursor.lastRecentScanAt, now);
  const seen = new Set(cursor.recentSeen);
  let fetched = 0;
  let finished = 0;
  for (const user of users) {
    if (cursor.recentDone.includes(user)) {
      finished += 1;
      continue;
    }
    if (fetched >= RECENT_FULL_PER_RUN || Date.now() >= deadline) break;
    const access = await gmailAccessToken(tokens[user]);
    let token = cursor.recentPageTokens[user] || '';
    let done = false;
    while (Date.now() < deadline && fetched < RECENT_FULL_PER_RUN) {
      const params = new URLSearchParams({ maxResults: '20', q });
      if (token) params.set('pageToken', token);
      const list = await gmailGet(access, `threads?${params}`);
      let halt = false;
      for (const row of list.threads || []) {
        if (!row?.id) continue;
        const key = `${user}:${row.id}`;
        if (seen.has(key)) continue;
        const known = storedHistory(state, user, row.id);
        if (row.historyId && known && String(row.historyId) === known) continue;
        if (fetched >= RECENT_FULL_PER_RUN || Date.now() >= deadline) {
          halt = true;
          break;
        }
        const thread = await gmailGet(access, `threads/${encodeURIComponent(row.id)}?format=full`);
        fetched += 1;
        seen.add(key);
        if (threadIsDraftOnly(thread)) {
          dropPendingDraftThread(state, user, row.id);
          continue;
        }
        const draft = gmailThreadDraft(thread, teamEmails);
        if (!draft) continue;
        draft.threadUser = user;
        rememberFresh(stats, applyDraft(state, draft, scope));
      }
      if (halt) {
        if (token) cursor.recentPageTokens[user] = token;
        else delete cursor.recentPageTokens[user];
        break;
      }
      if (list.nextPageToken) {
        token = list.nextPageToken;
        cursor.recentPageTokens[user] = token;
        if (fetched >= RECENT_FULL_PER_RUN || Date.now() >= deadline) break;
        continue;
      }
      delete cursor.recentPageTokens[user];
      done = true;
      break;
    }
    if (done) {
      if (!cursor.recentDone.includes(user)) cursor.recentDone.push(user);
      finished += 1;
    }
  }
  cursor.recentSeen = [...seen].slice(-500);
  if (finished === users.length) {
    cursor.lastRecentScanAt = new Date(now).toISOString();
    cursor.recentPageTokens = {};
    cursor.recentDone = [];
    cursor.recentSeen = [];
  }
  stats.gmailThreads += fetched;
}

async function scanGmail(state, tokens, teamEmails, cursor, deadline, stats, scope) {
  const users = connectedUsers(tokens);
  if (!users.length) return;
  if (cursor.mailboxIndex >= users.length) cursor.mailboxIndex = 0;
  const user = users[cursor.mailboxIndex];
  const withEmail = (state.contacts || []).filter((contact) => (contact.emails || []).length);
  if (!withEmail.length) return;
  const access = await gmailAccessToken(tokens[user]);
  let fetched = 0;
  let examined = 0;
  while (fetched < GMAIL_FULL_PER_RUN && examined < GMAIL_EXAMINE_PER_RUN && Date.now() < deadline) {
    if (cursor.contactIndex >= withEmail.length) {
      cursor.mailboxIndex = (cursor.mailboxIndex + 1) % users.length;
      cursor.contactIndex = 0;
      cursor.pageToken = '';
      cursor.seenThreads = [];
      break;
    }
    const slice = withEmail.slice(cursor.contactIndex, cursor.contactIndex + 5);
    const emails = [...new Set(slice.flatMap((contact) => contact.emails.map(queryEmail).filter(Boolean)))].slice(0, 12);
    if (!emails.length) {
      cursor.contactIndex += slice.length;
      cursor.pageToken = '';
      cursor.seenThreads = [];
      continue;
    }
    const q = `${emails.map((email) => `(from:${email} OR to:${email} OR cc:${email})`).join(' OR ')} -in:spam -in:trash -in:drafts`;
    const params = new URLSearchParams({ maxResults: '10', q });
    if (cursor.pageToken) params.set('pageToken', cursor.pageToken);
    const list = await gmailGet(access, `threads?${params}`);
    const seen = new Set(cursor.seenThreads);
    for (const row of list.threads || []) {
      if (!row?.id || seen.has(row.id)) continue;
      if (examined >= GMAIL_EXAMINE_PER_RUN || fetched >= GMAIL_FULL_PER_RUN || Date.now() >= deadline) break;
      examined += 1;
      seen.add(row.id);
      const known = storedHistory(state, user, row.id);
      if (row.historyId && known && String(row.historyId) === known) continue;
      const thread = await gmailGet(access, `threads/${encodeURIComponent(row.id)}?format=full`);
      fetched += 1;
      if (threadIsDraftOnly(thread)) {
        dropPendingDraftThread(state, user, row.id);
        continue;
      }
      const draft = gmailThreadDraft(thread, teamEmails);
      if (!draft) continue;
      draft.threadUser = user;
      rememberFresh(stats, applyDraft(state, draft, scope));
    }
    cursor.seenThreads = [...seen].slice(-400);
    const pageIds = (list.threads || []).map((row) => row.id).filter(Boolean);
    const pageDone = pageIds.length === 0 || pageIds.every((id) => seen.has(id));
    if (!pageDone) break;
    cursor.seenThreads = [];
    if (list.nextPageToken) {
      cursor.pageToken = list.nextPageToken;
      continue;
    }
    cursor.pageToken = '';
    cursor.contactIndex += slice.length;
  }
  stats.gmailThreads += fetched;
}

function knownGranola(state, id) {
  for (const contact of state?.contacts || []) {
    for (const item of contact?.interactions || []) {
      if (item?.source === 'granola' && item.sourceKey === id) return true;
    }
  }
  return false;
}

/* Yesterday's meeting lives at the front of Granola. The backfill cursor
   walks older pages, so this pass always asks for the last week by date
   and does not touch that cursor. */
async function scanRecentGranola(state, teamEmails, deadline, stats, scope, now) {
  if (!process.env.GRANOLA_API_KEY) return;
  const after = new Date(now - GRANOLA_RECENT_MS).toISOString();
  let cursor = '';
  let fetched = 0;
  for (let pageNo = 0; pageNo < 4 && fetched < GRANOLA_PER_RUN && Date.now() < deadline; pageNo += 1) {
    const params = new URLSearchParams({ page_size: '10', created_after: after });
    if (cursor) params.set('cursor', cursor);
    const page = await granolaGet(`/notes?${params}`);
    let pageHadNew = false;
    for (const summary of page.notes || []) {
      if (!summary?.id || knownGranola(state, summary.id)) continue;
      if (fetched >= GRANOLA_PER_RUN || Date.now() >= deadline) break;
      pageHadNew = true;
      const note = await loadGranolaNote(summary.id);
      fetched += 1;
      const draft = granolaDraft(note, teamEmails);
      if (draft?.sourceText?.trim()) {
        rememberFresh(stats, applyDraft(state, draft, scope));
        if (draft.sourceField) stats.granolaFields.push(draft.sourceField);
      }
    }
    if (!pageHadNew && page.hasMore && page.cursor) {
      cursor = page.cursor;
      continue;
    }
    if (fetched < GRANOLA_PER_RUN && page.hasMore && page.cursor && Date.now() < deadline) {
      cursor = page.cursor;
      continue;
    }
    break;
  }
  stats.granolaNotes += fetched;
}

async function scanGranola(state, teamEmails, cursor, deadline, stats, scope) {
  if (!process.env.GRANOLA_API_KEY) return;
  let fetched = 0;
  while (fetched < GRANOLA_PER_RUN && Date.now() < deadline) {
    const params = new URLSearchParams({ page_size: '10' });
    if (cursor.granolaCursor) params.set('cursor', cursor.granolaCursor);
    const page = await granolaGet(`/notes?${params}`);
    const seen = new Set(cursor.seenNotes);
    for (const summary of page.notes || []) {
      if (!summary?.id || seen.has(summary.id)) continue;
      if (fetched >= GRANOLA_PER_RUN || Date.now() >= deadline) break;
      seen.add(summary.id);
      const note = await loadGranolaNote(summary.id);
      fetched += 1;
      const draft = granolaDraft(note, teamEmails);
      if (draft?.sourceText?.trim()) {
        rememberFresh(stats, applyDraft(state, draft, scope));
        if (draft.sourceField) stats.granolaFields.push(draft.sourceField);
      }
    }
    cursor.seenNotes = [...seen].slice(-200);
    const pageIds = (page.notes || []).map((note) => note.id).filter(Boolean);
    const pageDone = pageIds.length === 0 || pageIds.every((id) => seen.has(id));
    if (!pageDone) break;
    cursor.seenNotes = [];
    if (page.hasMore && page.cursor) {
      cursor.granolaCursor = page.cursor;
      continue;
    }
    cursor.granolaCursor = '';
    break;
  }
  stats.granolaNotes += fetched;
}

async function dropUnsentDrafts(state, tokens, teamEmails) {
  let checked = 0;
  for (const contact of state.contacts || []) {
    for (const interaction of [...(contact.interactions || [])]) {
      if (checked >= 8) return;
      if (interaction?.source !== 'gmail' || interaction.status === 'written' || interaction.status === 'skipped') continue;
      if (!interaction.threadId) continue;
      checked += 1;
      const draft = await loadGmailDraft(interaction, tokens, teamEmails);
      if (draft?.draftOnly) {
        contact.interactions = (contact.interactions || []).filter((item) => item.id !== interaction.id);
      }
    }
  }
}

async function writeSome(state, tokens, teamEmails, cursor, deadline, stats) {
  const attempted = new Set();
  const fresh = new Set(stats.freshIds || []);
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      await dropUnsentDrafts(state, tokens, teamEmails);
    } catch (error) {
      stats.errors.push(shortError(error));
    }
    while (deadline - Date.now() > WRITE_MIN_REMAINING) {
      const due = listDue(state, Date.now()).filter(({ interaction }) => !attempted.has(interaction.id));
      if (!due.length) break;
      const freshDue = due.filter(({ interaction }) => fresh.has(interaction.id));
      const rest = due.filter(({ interaction }) => !fresh.has(interaction.id));
      let chosen;
      if (freshDue.length) chosen = freshDue[0];
      else {
        chosen = rest[cursor.writeIndex % rest.length];
        cursor.writeIndex += 1;
      }
      const { contact, interaction } = chosen;
      attempted.add(interaction.id);
      try {
        const outcome = await writeInteraction(state, contact, interaction, {
          tokens,
          teamEmails,
          now: Date.now()
        });
        if (interaction.source === 'granola' && interaction.sourceField) {
          stats.granolaFields.push(interaction.sourceField);
        }
        if (outcome === 'written') stats.written += 1;
        else if (outcome === 'skipped') stats.skipped += 1;
        else stats.waiting += 1;
      } catch (error) {
        stats.errors.push(shortError(error));
      }
    }
  }
  stats.remaining = listDue(state, Date.now()).length;
}

export async function runContactNotes({ state, tokens, cursor, now = Date.now(), profiles } = {}) {
  const started = Date.now();
  const deadline = started + BUDGET_MS;
  const next = normalizeCursor(cursor);
  const teamEmails = teamEmailMap(tokens);
  const scope = {
    internalEmails: internalEmailSet(tokens, profiles),
    internalNames: internalNameSet(profiles)
  };
  const stats = {
    gmailThreads: 0,
    granolaNotes: 0,
    written: 0,
    skipped: 0,
    waiting: 0,
    remaining: 0,
    removedInternal: 0,
    errors: [],
    granolaFields: [],
    freshIds: []
  };
  stats.removedInternal = stripUnwrittenInternalNotes(state, scope.internalEmails, scope.internalNames);
  skipInternalOnlyThreads(state, scope.internalEmails);
  const snapshot = snapshotInteractions(state);
  if (!process.env.ANTHROPIC_API_KEY) stats.errors.push('ANTHROPIC_API_KEY is not set');
  const findEnd = Math.min(deadline, started + FIND_MS);
  const granolaEnd = Math.min(findEnd, started + GRANOLA_FIND_MS);
  try {
    await scanRecentGranola(state, teamEmails, granolaEnd, stats, scope, now);
  } catch (error) {
    stats.errors.push(`granola recent: ${shortError(error)}`);
  }
  try {
    if (Date.now() < findEnd) {
      await scanRecentGmail(state, tokens, teamEmails, next, findEnd, stats, now, scope);
    }
  } catch (error) {
    stats.errors.push(`gmail recent: ${shortError(error)}`);
  }

  try {
    await writeSome(state, tokens, teamEmails, next, deadline, stats);
  } catch (error) {
    stats.errors.push(shortError(error));
  }

  if (deadline - Date.now() > WRITE_MIN_REMAINING + 8_000) {
    try {
      await scanGmail(state, tokens, teamEmails, next, deadline, stats, scope);
    } catch (error) {
      stats.errors.push(`gmail: ${shortError(error)}`);
      const users = connectedUsers(tokens);
      if (users.length) {
        next.mailboxIndex = (next.mailboxIndex + 1) % users.length;
        next.contactIndex = 0;
        next.pageToken = '';
        next.seenThreads = [];
      }
    }
    try {
      if (Date.now() < deadline) await scanGranola(state, teamEmails, next, deadline, stats, scope);
    } catch (error) {
      stats.errors.push(`granola: ${shortError(error)}`);
    }
  }

  stats.errors = stats.errors.slice(0, 8);
  return { cursor: next, stats, now, snapshot };
}

/* The Update notes button looks for this week's mail and meetings, then
   writes one waiting note per request so each title is saved on its own. */
export async function findRecentNotes({ state, tokens, cursor, now = Date.now(), profiles, budgetMs = 20_000 } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const next = normalizeCursor(cursor);
  const teamEmails = teamEmailMap(tokens);
  const scope = {
    internalEmails: internalEmailSet(tokens, profiles),
    internalNames: internalNameSet(profiles)
  };
  const stats = {
    gmailThreads: 0,
    granolaNotes: 0,
    written: 0,
    skipped: 0,
    waiting: 0,
    remaining: 0,
    removedInternal: 0,
    errors: [],
    granolaFields: [],
    freshIds: []
  };
  stats.removedInternal = stripUnwrittenInternalNotes(state, scope.internalEmails, scope.internalNames);
  skipInternalOnlyThreads(state, scope.internalEmails);
  const snapshot = snapshotInteractions(state);
  const granolaEnd = Math.min(deadline, started + GRANOLA_FIND_MS);
  try {
    await scanRecentGranola(state, teamEmails, granolaEnd, stats, scope, now);
  } catch (error) {
    stats.errors.push(`granola recent: ${shortError(error)}`);
  }
  try {
    if (Date.now() < deadline) {
      await scanRecentGmail(state, tokens, teamEmails, next, deadline, stats, now, scope);
    }
  } catch (error) {
    stats.errors.push(`gmail recent: ${shortError(error)}`);
  }
  stats.remaining = listDue(state, Date.now()).length;
  stats.errors = stats.errors.slice(0, 8);
  return { cursor: next, stats, snapshot };
}

function dueFor(state, now, { skipIds = [], allowContact, includeUpcoming = false } = {}) {
  const skip = new Set(skipIds);
  return listDue(state, now, { includeUpcoming })
    .filter(({ contact, interaction }) => !skip.has(interaction.id) && (!allowContact || allowContact(contact)))
    .sort((a, b) => String(b.interaction.activityAt).localeCompare(String(a.interaction.activityAt))
      || String(a.interaction.id).localeCompare(String(b.interaction.id)));
}

export async function writeNextNote(state, tokens, { skipIds = [], now = Date.now(), allowContact } = {}) {
  const queue = { skipIds, allowContact, includeUpcoming: true };
  const due = dueFor(state, now, queue);
  if (!due.length) return { written: false, remaining: 0, id: '' };
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY to generate interaction notes.');
  }
  const { contact, interaction } = due[0];
  let outcome = 'waiting';
  try {
    outcome = await writeInteraction(state, contact, interaction, {
      tokens,
      teamEmails: teamEmailMap(tokens),
      now,
      ignoreQuiet: true,
      skipRelevance: true
    });
  } catch (error) {
    return {
      written: false,
      remaining: dueFor(state, now, queue).length,
      id: interaction.id,
      contactId: contact.id,
      error: shortError(error)
    };
  }
  const remaining = dueFor(state, now, queue).length;
  if (outcome !== 'written' && outcome !== 'skipped') {
    return {
      written: false,
      outcome,
      id: interaction.id,
      contactId: contact.id,
      remaining,
      error: 'The source could not be read. Try again.'
    };
  }
  return {
    written: outcome === 'written',
    outcome,
    id: interaction.id,
    contactId: contact.id,
    remaining
  };
}

export function syncResultMessage(stats) {
  const written = Number(stats?.written) || 0;
  const errors = Array.isArray(stats?.errors) ? stats.errors.filter(Boolean) : [];
  if (written) {
    const label = written === 1 ? '1 interaction note' : `${written} interaction notes`;
    return errors.length ? `${label} · ${errors[0]}` : label;
  }
  if (errors.length) return errors[0];
  return 'Sync finished — no new matches';
}

export async function rerunInteraction(state, tokens, { contactId, interactionId, now = Date.now() } = {}) {
  const contact = (state.contacts || []).find((item) => item.id === contactId);
  if (!contact) throw new Error('Contact not found');
  const interaction = (contact.interactions || []).find((item) => item.id === interactionId);
  if (!interaction) throw new Error('Note not found');
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY to generate interaction notes.');
  }
  const outcome = await writeInteraction(state, contact, interaction, {
    tokens,
    teamEmails: teamEmailMap(tokens),
    now,
    ignoreQuiet: true,
    skipRelevance: true
  });
  if (outcome !== 'written') throw new Error('The source could not be read. Try again.');
  return interaction;
}
