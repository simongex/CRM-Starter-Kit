import {
  GMAIL_TOKENS_KEY,
  isOwnContact,
  matchContact,
  mergeProposals,
  normalizeSourceEmail,
  normalizeSourceNote,
  parseFromHeader,
  sha256,
  sourceHashFor,
  touchDates
} from './contacts.js';
import { ANTHROPIC_MODEL, anthropicErrorMessage } from './ai.js';
import { classifyInbound, fallbackProposalSummary, nameFromAddress } from './inbound.js';
import { isManager, kvCommand } from './internal-auth.js';
import { NOTE_STYLE_PROMPT, capSentences, replaceEmDashes } from './note-style.js';

const GMAIL_SCOPE = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
].join(' ');

const GRANOLA_BASE = 'https://public-api.granola.ai/v1';
const MAX_GMAIL_PER_CONTACT = 12;
const MAX_INBOX_REVIEW = 30;
const INBOX_QUERY = 'in:inbox newer_than:3d -category:promotions -category:social -category:forums -category:updates';
const MAX_GRANOLA_NOTES = 60;
const MAX_SNIPPETS_FOR_SUMMARY = 8;

export function requestOrigin(request) {
  const url = new URL(request.url);
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || url.host;
  return `${proto}://${host}`;
}

export function gmailRedirectUri(request) {
  return process.env.GMAIL_REDIRECT_URI || `${requestOrigin(request)}/api/gmail`;
}

export function gmailAuthUrl(state, request) {
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID || '',
    redirect_uri: gmailRedirectUri(request),
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function loadGmailTokens(target) {
  if (!target) return {};
  const raw = await kvCommand(target, ['GET', GMAIL_TOKENS_KEY]);
  if (!raw) return {};
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return data && typeof data === 'object' ? data : {};
}

export async function saveGmailTokens(target, map) {
  await kvCommand(target, ['SET', GMAIL_TOKENS_KEY, JSON.stringify(map)]);
}

export function accountForUser(map, user) {
  const record = map?.[user];
  return record && record.refresh_token ? record : null;
}

async function googleToken(body) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || 'Google token exchange failed');
  return data;
}

export async function exchangeGmailCode(code, request) {
  return googleToken({
    code,
    client_id: process.env.GMAIL_CLIENT_ID || '',
    client_secret: process.env.GMAIL_CLIENT_SECRET || '',
    redirect_uri: gmailRedirectUri(request),
    grant_type: 'authorization_code'
  });
}

export async function gmailProfile(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Could not read the Gmail account');
  return data;
}

export async function gmailAccessToken(record) {
  if (record.access_token && record.expiry && record.expiry > Date.now() + 30_000) {
    return record.access_token;
  }
  const data = await googleToken({
    refresh_token: record.refresh_token,
    client_id: process.env.GMAIL_CLIENT_ID || '',
    client_secret: process.env.GMAIL_CLIENT_SECRET || '',
    grant_type: 'refresh_token'
  });
  record.access_token = data.access_token;
  record.expiry = Date.now() + (Number(data.expires_in) || 3500) * 1000;
  if (data.refresh_token) record.refresh_token = data.refresh_token;
  return record.access_token;
}

export async function gmailGet(accessToken, path) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gmail ${response.status}`);
  return data;
}

function headerMap(payload) {
  const map = {};
  for (const header of payload?.headers || []) {
    if (header?.name) map[header.name.toLowerCase()] = header.value || '';
  }
  return map;
}

async function fetchGmailForContact(accessToken, contact, sources) {
  const queries = contact.emails.map((email) => `from:${email} OR to:${email}`);
  if (!queries.length) return { linked: 0 };
  const q = queries.join(' OR ');
  const list = await gmailGet(
    accessToken,
    `messages?maxResults=${MAX_GMAIL_PER_CONTACT}&q=${encodeURIComponent(q)}`
  );
  let linked = 0;
  for (const row of list.messages || []) {
    if (contact.linkedEmails.includes(row.id) && sources.emails[row.id]) {
      linked += 1;
      continue;
    }
    const message = await gmailGet(
      accessToken,
      `messages/${row.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`
    );
    const headers = headerMap(message.payload);
    const date = message.internalDate
      ? new Date(Number(message.internalDate)).toISOString()
      : headers.date;
    sources.emails[row.id] = normalizeSourceEmail({
      id: row.id,
      subject: headers.subject,
      from: headers.from,
      to: headers.to,
      date,
      snippet: message.snippet
    }, row.id);
    if (!contact.linkedEmails.includes(row.id)) contact.linkedEmails.push(row.id);
    touchDates(contact, date);
    linked += 1;
  }
  contact.linkedEmails = contact.linkedEmails.slice(0, 40);
  return { linked };
}

export async function granolaGet(path) {
  const response = await fetch(`${GRANOLA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${process.env.GRANOLA_API_KEY}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `Granola ${response.status}`);
  return data;
}

async function listGranolaNotes() {
  const notes = [];
  let cursor = '';
  while (notes.length < MAX_GRANOLA_NOTES) {
    const params = new URLSearchParams({ page_size: '30' });
    if (cursor) params.set('cursor', cursor);
    const page = await granolaGet(`/notes?${params}`);
    notes.push(...(page.notes || []));
    if (!page.hasMore || !page.cursor) break;
    cursor = page.cursor;
  }
  return notes.slice(0, MAX_GRANOLA_NOTES);
}

function granolaPeople(note) {
  const people = [];
  const push = (person) => {
    if (!person) return;
    if (typeof person === 'string') {
      people.push({ name: '', email: person.trim().toLowerCase() });
      return;
    }
    people.push({
      name: String(person.name || ''),
      email: String(person.email || '').toLowerCase()
    });
  };
  push(note.owner);
  for (const attendee of note.attendees || []) push(attendee);
  for (const attendee of note.calendar_event?.attendees || []) push(attendee);
  for (const invitee of note.calendar_event?.invitees || []) push(invitee);
  if (note.calendar_event?.organiser) push({ email: note.calendar_event.organiser });
  return people;
}

async function fetchGranola(state) {
  const listed = await listGranolaNotes();
  let matched = 0;
  const unmatched = [];
  for (const summary of listed) {
    const note = await granolaGet(`/notes/${summary.id}`);
    const people = granolaPeople(note);
    const date = note.calendar_event?.scheduled_start_time || note.created_at;
    const record = normalizeSourceNote({
      id: note.id,
      title: note.title,
      date,
      attendees: people.map((person) => person.name || person.email).filter(Boolean),
      summary: note.summary_text || note.summary_markdown || note.summary || ''
    }, note.id);
    state.sources.notes[note.id] = record;

    const hits = new Set();
    for (const person of people) {
      const email = String(person.email || '').trim().toLowerCase();
      if (!email) continue;
      const found = matchContact(state.contacts, { email });
      if (found) hits.add(found.contact.id);
      else unmatched.push({ name: person.name, email, date, title: note.title });
    }
    for (const id of hits) {
      const contact = state.contacts.find((item) => item.id === id);
      if (!contact || isOwnContact(contact)) continue;
      if (!contact.linkedGranolaNotes.includes(note.id)) contact.linkedGranolaNotes.push(note.id);
      contact.linkedGranolaNotes = contact.linkedGranolaNotes.slice(0, 30);
      touchDates(contact, date);
      matched += 1;
    }
  }
  return { matched, unmatched };
}

async function proposalSummary(item) {
  const fallback = fallbackProposalSummary(item);
  const source = [`Subject: ${item.subject || ''}`, item.snippet || ''].filter((line) => line.trim()).join('\n');
  if (!process.env.ANTHROPIC_API_KEY || !source.trim()) return fallback;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 180,
        system: `${NOTE_STYLE_PROMPT}\n\nWrite one or two sentences for a relationship summary. Use only facts from the source. No headings, no list.`,
        messages: [{
          role: 'user',
          content: `Contact: ${item.name || 'Unknown'}\n\nSource:\n${source.slice(0, 2000)}`
        }]
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return fallback;
    const text = (data.content || []).map((part) => part.text || '').join('\n').trim();
    return capSentences(replaceEmDashes(text), 2) || fallback;
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

async function fillProposalSummaries(proposals) {
  let written = 0;
  for (const item of proposals) {
    if (item.summary) continue;
    if (!process.env.ANTHROPIC_API_KEY || written >= 8) {
      item.summary = fallbackProposalSummary(item);
      continue;
    }
    item.summary = await proposalSummary(item);
    written += 1;
  }
}

export async function reviewInboxes(state, tokenMap) {
  const own = new Set();
  const records = [];
  for (const [user, record] of Object.entries(tokenMap || {})) {
    if (!isManager(user) || !record?.refresh_token) continue;
    records.push({ user, record });
    if (record.email) own.add(String(record.email).trim().toLowerCase());
  }
  if (!records.length) {
    return { mailboxes: 0, read: 0, proposed: (state.proposals || []).length, skipped: true };
  }

  const incoming = [];
  let read = 0;
  let errors = 0;
  for (const account of records) {
    const { user, record } = account;
    try {
      const token = await gmailAccessToken(record);
      const list = await gmailGet(
        token,
        `messages?maxResults=${MAX_INBOX_REVIEW}&q=${encodeURIComponent(INBOX_QUERY)}`
      );
      for (const row of (list.messages || []).slice(0, MAX_INBOX_REVIEW)) {
        const message = await gmailGet(
          token,
          `messages/${row.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Id&metadataHeaders=Precedence&metadataHeaders=Auto-Submitted`
        );
        read += 1;
        const headers = headerMap(message.payload);
        const from = parseFromHeader(headers.from);
        if (!classifyInbound({
          email: from.email,
          name: from.name,
          subject: headers.subject,
          headers,
          labelIds: message.labelIds
        }).keep) continue;
        if (own.has(from.email)) continue;
        const date = message.internalDate
          ? new Date(Number(message.internalDate)).toISOString()
          : headers.date;
        incoming.push({
          email: from.email,
          name: nameFromAddress(from.email, from.name),
          subject: headers.subject || '',
          snippet: message.snippet || '',
          date,
          owner: user === 'alex' || user === 'sam' ? user : '',
          messageIds: [row.id],
          count: 1
        });
      }
    } catch (error) {
      errors += 1;
      console.error(error);
    }
  }
  if (errors === records.length) {
    return { mailboxes: records.length, read, proposed: (state.proposals || []).length, skipped: true };
  }

  state.proposals = mergeProposals(state.proposals, incoming, {
    known: state.contacts.flatMap((contact) => contact.emails),
    dismissed: state.dismissedInbound,
    own
  });
  await fillProposalSummaries(state.proposals);
  return { mailboxes: records.length, read, proposed: state.proposals.length, skipped: false };
}

function mergeSuggestions(current, incoming) {
  const map = new Map();
  for (const item of current || []) {
    if (item.email) map.set(item.email, { ...item });
  }
  for (const item of incoming) {
    const email = String(item.email || '').toLowerCase();
    if (!email) continue;
    const prev = map.get(email) || { name: '', email, count: 0, lastDate: '' };
    prev.count += 1;
    if (item.name && !prev.name) prev.name = item.name;
    const day = String(item.date || '').slice(0, 10);
    if (day && (!prev.lastDate || day > prev.lastDate)) prev.lastDate = day;
    map.set(email, prev);
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count || String(b.lastDate).localeCompare(String(a.lastDate)))
    .slice(0, 20);
}

export async function syncSources(state, gmailRecord) {
  const result = {
    gmail: { skipped: !gmailRecord, linked: 0, error: '' },
    granola: { skipped: !process.env.GRANOLA_API_KEY, matched: 0, error: '' }
  };
  const unmatched = [];

  if (gmailRecord) {
    try {
      const token = await gmailAccessToken(gmailRecord);
      for (const contact of state.contacts) {
        if (!contact.emails.length) continue;
        const done = await fetchGmailForContact(token, contact, state.sources);
        result.gmail.linked += done.linked;
      }
    } catch (error) {
      console.error(error);
      result.gmail.error = 'Gmail could not be read.';
    }
  }

  if (process.env.GRANOLA_API_KEY) {
    try {
      const done = await fetchGranola(state);
      result.granola.matched = done.matched;
      unmatched.push(...done.unmatched);
    } catch (error) {
      console.error(error);
      result.granola.error = 'Meeting notes could not be loaded.';
    }
  }

  const known = new Set(state.contacts.flatMap((contact) => contact.emails));
  state.suggestions = mergeSuggestions(
    state.suggestions,
    unmatched.filter((item) => item.email && !known.has(item.email))
  );

  for (const contact of state.contacts) {
    const hash = await sha256(sourceHashFor(contact, state.sources));
    if (contact.summaryHash && hash !== contact.summaryHash) contact.summaryStale = true;
    if (!contact.summary && (contact.linkedEmails.length || contact.linkedGranolaNotes.length)) {
      contact.summaryStale = true;
    }
  }

  state.lastSyncAt = new Date().toISOString();
  return result;
}

function hasSummaryMaterial(contact) {
  const notes = (contact.interactions || []).some((item) => item.status === 'written' && item.summary);
  return notes || (contact.linkedEmails || []).length > 0 || (contact.linkedGranolaNotes || []).length > 0;
}

function interactionBlurb(contact) {
  return (contact.interactions || [])
    .filter((item) => item.status === 'written' && item.summary)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, MAX_SNIPPETS_FOR_SUMMARY)
    .map((item) => {
      const tasks = (item.tasks || [])
        .filter((task) => task.text)
        .map((task) => `- ${task.text}${task.owner ? ` (${task.owner})` : ''}`)
        .join('\n');
      return `Note ${item.date} (${item.source}${item.lead ? `, lead ${item.lead}` : ''}):\n${item.summary}${tasks ? `\n${tasks}` : ''}`;
    })
    .join('\n\n');
}

function sourceBlurb(contact, sources) {
  const fromNotes = interactionBlurb(contact);
  if (fromNotes.trim()) return fromNotes.slice(0, 12000);
  const emails = (contact.linkedEmails || [])
    .map((id) => sources.emails[id])
    .filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, MAX_SNIPPETS_FOR_SUMMARY)
    .map((item) => `Email (${String(item.date).slice(0, 10)}): ${item.subject}\nFrom: ${item.from}\n${item.snippet}`);
  const notes = (contact.linkedGranolaNotes || [])
    .map((id) => sources.notes[id])
    .filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, MAX_SNIPPETS_FOR_SUMMARY)
    .map((item) => `Meeting (${String(item.date).slice(0, 10)}): ${item.title}\nAttendees: ${(item.attendees || []).join(', ')}\n${item.summary}`);
  return [...emails, ...notes].join('\n\n').slice(0, 12000);
}

export async function summarizeContact(contact, sources) {
  const material = sourceBlurb(contact, sources);
  if (!material.trim()) {
    throw new Error('No interaction notes or linked correspondence to summarise yet.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Set ANTHROPIC_API_KEY to generate relationship summaries.');
  }
  const hash = await sha256(sourceHashFor(contact, sources));
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 280,
      system: 'You write concise relationship briefs for YourOrg, a small organisation (describe what you do here). Be factual, specific, and useful to the team member who owns the relationship. Do not invent facts. Avoid greetings and headings.',
      messages: [{
        role: 'user',
        content: `Write 80–120 words summarising the relationship and recent interactions with this contact.\n\nName: ${contact.name}\nCompany: ${contact.company || '—'}\nPosition: ${contact.position || '—'}\nYourOrg owner: ${contact.mainContactPerson || '—'}\nCategories: ${(contact.categories || []).join(', ') || '—'}\n\nSource material:\n${material}`
      }]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(anthropicErrorMessage(data, response.status));
  const text = (data.content || []).map((part) => part.text || '').join('\n').trim();
  if (!text) throw new Error('Anthropic returned an empty summary.');
  contact.summary = text;
  contact.summaryUpdatedAt = new Date().toISOString();
  contact.summaryHash = hash;
  contact.summaryStale = false;
  return contact;
}

export async function summarizeStale(state, { contactId, limit = 4 } = {}) {
  const targets = contactId
    ? state.contacts.filter((item) => item.id === contactId)
    : state.contacts.filter((item) => item.summaryStale || (!item.summary && hasSummaryMaterial(item)));
  const done = [];
  const errors = [];
  for (const contact of targets.slice(0, limit)) {
    try {
      await summarizeContact(contact, state.sources);
      done.push(contact.id);
    } catch (error) {
      console.error(error);
      const message = error?.message === 'No interaction notes or linked correspondence to summarise yet.'
        || String(error?.message || '').startsWith('AI model unavailable:')
        ? error.message
        : 'Could not generate a summary.';
      errors.push({ id: contact.id, error: message });
    }
  }
  if (done.length) state.lastSummarizeAt = new Date().toISOString();
  return { done, errors };
}

export { GMAIL_SCOPE };
