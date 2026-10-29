import { EMAIL_DOMAIN, envUsers, kvCommand } from './internal-auth.js';

export const CONTACTS_KEY = 'kb:contacts';
export const GMAIL_TOKENS_KEY = 'kb:gmail-tokens';
export const MAX_CONTACTS_BODY = 2_000_000;

export const TEAM_MEMBERS = [
  { id: 'alex', name: 'Alex Admin' },
  { id: 'sam', name: 'Sam Manager' },
  { id: 'jordan', name: 'Jordan Lee' },
  { id: 'taylor', name: 'Taylor Kim' },
  { id: 'robin', name: 'Robin Park' },
  { id: 'casey', name: 'Casey Lim' },
  { id: 'morgan', name: 'Morgan Reed' }
];

export const DEFAULT_RELEVANCE_VOCABULARY = [
  'partnership',
  'proposal',
  'contract',
  'meeting',
  'grant',
  'funding',
  'sponsorship',
  'project',
  'introduction',
  'follow-up'
];

export const DEFAULT_CATEGORIES = [
  { id: 'donors', name: 'Donors', color: '#d4b36a' },
  { id: 'institutional-funders', name: 'Institutional Funders', color: '#7eb0d4' },
  { id: 'artists', name: 'Artists', color: '#e08aa0' },
  { id: 'curators', name: 'Curators', color: '#b39ddb' },
  { id: 'partner-organizations', name: 'Partner Organizations', color: '#6cbcab' },
  { id: 'embassies', name: 'Embassies / Cultural Attachés', color: '#e09a5a' },
  { id: 'press-media', name: 'Press / Media', color: '#d0d0d0' },
  { id: 'board-advisors', name: 'Board Members / Advisors', color: '#dcc87a' },
  { id: 'venues', name: 'Venues / Institutions', color: '#5eb89a' },
  { id: 'academic', name: 'Academic', color: '#8aa6d4' },
  { id: 'volunteers', name: 'Volunteers / Coordinators', color: '#b5d47a', managersOnly: true },
  { id: 'employees', name: 'Employees / Applicants', color: '#c4788a', managersOnly: true },
  { id: 'sponsors', name: 'Sponsors / Corporate', color: '#d4a574' },
  { id: 'alumni', name: 'Alumni', color: '#c49aaa' },
  { id: 'prospects', name: 'Prospects', color: '#9a9a9a' }
];

const CATEGORY_IDS = new Set(DEFAULT_CATEGORIES.map((item) => item.id));
const MANAGER_CATEGORY_IDS = new Set(
  DEFAULT_CATEGORIES.filter((item) => item.managersOnly).map((item) => item.id)
);

const NEWSLETTER_STATUSES = new Set(['not-asked', 'agreed', 'declined', 'unsubscribed']);
const NEWSLETTER_EVENTS = new Set(['agreed', 'declined', 'removed', 'unsubscribed', 'resubscribed']);

export function emptyContactsState() {
  return {
    categories: DEFAULT_CATEGORIES.map((item) => ({ ...item })),
    groups: [],
    contacts: [],
    sources: { emails: {}, notes: {} },
    suggestions: [],
    proposals: [],
    dismissedInbound: [],
    settings: { relevanceVocabulary: DEFAULT_RELEVANCE_VOCABULARY.slice() },
    lastSyncAt: '',
    lastSummarizeAt: ''
  };
}

export function slugifyCategory(name) {
  const slug = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'category';
}

function uniqueId(base, used) {
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function asPhone(value) {
  return String(value || '').trim().slice(0, 40);
}

export function stripImportedListNote(text) {
  return String(text || '')
    .replace(/[ \t]*\[Imported list:[^\]]*\]/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasImportedListNote(text) {
  return /\[Imported list:/i.test(String(text || ''));
}

export function scrubImportedListNotes(state) {
  let changed = false;
  const clean = (value) => {
    if (!hasImportedListNote(value)) return value;
    changed = true;
    return stripImportedListNote(value);
  };
  for (const contact of state?.contacts || []) {
    if (contact && typeof contact.summary === 'string') contact.summary = clean(contact.summary);
    for (const event of contact?.events || []) {
      if (event && typeof event.notes === 'string') event.notes = clean(event.notes);
    }
    for (const note of contact?.interactions || []) {
      if (note && typeof note.summary === 'string') note.summary = clean(note.summary);
    }
  }
  return changed;
}

const EVENT_CHANNELS = new Set(['gmail', 'granola', 'phone', 'in-person', 'correspondence']);

function normalizeEvent(item) {
  const channel = EVENT_CHANNELS.has(item?.channel) ? item.channel : 'gmail';
  return {
    id: String(item?.id || crypto.randomUUID()),
    title: String(item?.title || '').trim().slice(0, 160),
    channel,
    date: asIsoDate(item?.date),
    person: String(item?.person || '').trim().slice(0, 120),
    followUpDone: Boolean(item?.followUpDone),
    notes: stripImportedListNote(item?.notes).slice(0, 8000)
  };
}

const INTERACTION_SOURCES = new Set(['gmail', 'granola']);
const INTERACTION_STATUS = new Set(['pending', 'written', 'skipped']);

function normalizeTask(item) {
  const text = String(item?.text || (typeof item === 'string' ? item : '')).trim().slice(0, 500);
  const owner = String(item?.owner || '').trim().slice(0, 120);
  if (!text) return null;
  const task = { text, owner };
  const linked = String(item?.programmeTaskId || '').trim().slice(0, 80);
  if (linked) task.programmeTaskId = linked;
  const actionId = String(item?.programmeActionId || '').trim().slice(0, 80);
  if (actionId) task.programmeActionId = actionId;
  const due = String(item?.due || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) task.due = due;
  return task;
}

export function normalizeInteraction(item) {
  const source = INTERACTION_SOURCES.has(item?.source) ? item.source : 'gmail';
  const status = INTERACTION_STATUS.has(item?.status) ? item.status : 'pending';
  const lang = String(item?.sourceLanguage || '').trim().toLowerCase();
  return {
    id: String(item?.id || crypto.randomUUID()),
    source,
    sourceKey: String(item?.sourceKey || '').trim().slice(0, 500),
    date: asIsoDate(item?.date),
    lead: String(item?.lead || '').trim().toLowerCase().slice(0, 64),
    participants: asStringArray(item?.participants).map((email) => email.toLowerCase()).slice(0, 40),
    summary: stripImportedListNote(item?.summary).slice(0, 4000),
    tasks: Array.isArray(item?.tasks) ? item.tasks.map(normalizeTask).filter(Boolean).slice(0, 20) : [],
    status,
    skipReason: String(item?.skipReason || '').trim().slice(0, 200),
    createdAt: String(item?.createdAt || ''),
    sourceLanguage: /^[a-z]{2,3}$/.test(lang) ? lang : '',
    styleWarning: Boolean(item?.styleWarning),
    activityAt: String(item?.activityAt || ''),
    coveredAt: String(item?.coveredAt || ''),
    seenHash: String(item?.seenHash || '').slice(0, 2000),
    sourceHash: String(item?.sourceHash || '').slice(0, 2000),
    threadUser: String(item?.threadUser || '').trim().toLowerCase().slice(0, 64),
    threadId: String(item?.threadId || '').trim().slice(0, 80),
    historyId: String(item?.historyId || '').trim().slice(0, 64),
    sourceField: String(item?.sourceField || '').trim().slice(0, 80),
    title: String(item?.title || '').trim().slice(0, 160),
    followUpDone: Boolean(item?.followUpDone)
  };
}

function normalizeInteractions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeInteraction)
    .filter((item) => item.sourceKey)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(-200);
}

export function normalizeVocabulary(value) {
  if (!Array.isArray(value)) return DEFAULT_RELEVANCE_VOCABULARY.slice();
  const terms = [];
  const seen = new Set();
  for (const item of value) {
    const term = String(item || '').trim().slice(0, 80);
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length >= 80) break;
  }
  return terms;
}

function asIsoDate(value) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  if (!raw) return '';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function normalizeCategory(item, used) {
  const name = String(item?.name || 'Category').trim() || 'Category';
  const id = uniqueId(String(item?.id || slugifyCategory(name)).slice(0, 64), used);
  const color = /^#[0-9a-fA-F]{6}$/.test(item?.color || '') ? item.color : '#9a9a9a';
  const category = { id, name, color };
  if (MANAGER_CATEGORY_IDS.has(id)) category.managersOnly = true;
  return category;
}

function withManagerCategories(categories, used) {
  const present = new Set(categories.map((item) => item.id));
  for (const item of DEFAULT_CATEGORIES) {
    if (!MANAGER_CATEGORY_IDS.has(item.id) || present.has(item.id)) continue;
    categories.push(normalizeCategory({ ...item }, used));
  }
  return categories;
}

export function normalizeGroup(item, used) {
  const name = String(item?.name || 'Group').trim().slice(0, 80) || 'Group';
  const slug = String(item?.id || slugifyCategory(name)).slice(0, 64);
  const id = uniqueId(slug || 'group', used);
  return {
    id,
    name,
    createdAt: String(item?.createdAt || '').slice(0, 40),
    createdBy: String(item?.createdBy || '').trim().slice(0, 64)
  };
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const entries = [];
  for (const item of value) {
    const event = NEWSLETTER_EVENTS.has(item?.event) ? item.event : '';
    if (!event) continue;
    const via = String(item?.via || '').trim().slice(0, 40);
    entries.push({
      date: asIsoDate(item?.date),
      event,
      by: String(item?.by || '').trim().slice(0, 64),
      ...(via ? { via } : {})
    });
  }
  return entries.slice(-50);
}

export function normalizeNewsletter(item) {
  const src = item && typeof item === 'object' ? item : {};
  const status = NEWSLETTER_STATUSES.has(src.status) ? src.status : 'not-asked';
  const syncedEmail = String(src.syncedEmail || '').trim().toLowerCase();
  return {
    status,
    date: status === 'not-asked' ? '' : asIsoDate(src.date),
    note: String(src.note || '').trim().slice(0, 200),
    history: normalizeHistory(src.history),
    mailchimpStatus: String(src.mailchimpStatus || '').trim().slice(0, 40),
    syncedAt: String(src.syncedAt || '').slice(0, 40),
    syncedEmail: syncedEmail.includes('@') ? syncedEmail : ''
  };
}

function appendHistory(history, entry) {
  return normalizeHistory([...(history || []), entry]);
}

/* Agreed, pending (not-asked) and removed (declined) are chosen in the CRM.
   Unsubscribed is only written from Mailchimp, and the menu cannot change it. */
export function applyNewsletterChoice(newsletter, choice, { date = '', by = '', note, via = '' } = {}) {
  const current = normalizeNewsletter(newsletter);
  if (current.status === 'unsubscribed') return current;
  if (note !== undefined) current.note = String(note || '').trim().slice(0, 200);
  if (choice !== 'agreed' && choice !== 'declined' && choice !== 'not-asked') return current;
  if (choice === current.status) return current;
  const day = asIsoDate(date);
  const source = String(via || '').trim().slice(0, 40);
  const entry = { date: day, event: choice, by, ...(source ? { via: source } : {}) };
  if (choice === 'not-asked') {
    if (current.status === 'agreed') {
      current.history = appendHistory(current.history, { ...entry, event: 'removed' });
    }
    current.status = 'not-asked';
    current.date = '';
    return current;
  }
  current.status = choice;
  current.date = day;
  current.history = appendHistory(current.history, entry);
  return current;
}

export function markUnsubscribed(newsletter, date) {
  const current = normalizeNewsletter(newsletter);
  if (current.status === 'unsubscribed') return current;
  const day = asIsoDate(date);
  current.status = 'unsubscribed';
  current.date = day;
  current.history = appendHistory(current.history, { date: day, event: 'unsubscribed', by: '', via: 'mailchimp' });
  return current;
}

export function markResubscribed(newsletter, date) {
  const current = normalizeNewsletter(newsletter);
  if (current.status !== 'unsubscribed') return current;
  const day = asIsoDate(date);
  current.status = 'agreed';
  current.date = day;
  current.history = appendHistory(current.history, { date: day, event: 'resubscribed', by: '', via: 'mailchimp' });
  return current;
}

function legacyNewsletter(item) {
  if (item?.newsletter && NEWSLETTER_STATUSES.has(item.newsletter.status)) {
    return normalizeNewsletter(item.newsletter);
  }
  const mailing = item?.mailing && typeof item.mailing === 'object' ? item.mailing : null;
  if (!mailing) return normalizeNewsletter(null);
  const lists = asStringArray(mailing.lists);
  const blocked = mailing.status === 'unsubscribed' || mailing.status === 'cleaned';
  const syncedEmail = mailing.syncedEmail;
  const syncedAt = mailing.syncedAt;
  if (blocked) {
    return normalizeNewsletter({
      status: 'unsubscribed',
      mailchimpStatus: mailing.status,
      syncedAt,
      syncedEmail,
      history: [{ date: '', event: 'unsubscribed', by: '' }]
    });
  }
  if (lists.includes('newsletter') && mailing.consent) {
    const date = asIsoDate(mailing.consentDate);
    return normalizeNewsletter({
      status: 'agreed',
      date,
      syncedAt,
      syncedEmail,
      mailchimpStatus: mailing.status || '',
      history: [{ date, event: 'agreed', by: '' }]
    });
  }
  return normalizeNewsletter({ status: 'not-asked', syncedAt, syncedEmail, mailchimpStatus: mailing.status || '' });
}

function legacyGroups(item, knownGroupIds) {
  const source = Array.isArray(item?.groups)
    ? item.groups
    : (Array.isArray(item?.mailing?.lists) ? item.mailing.lists : []);
  let ids = asStringArray(source);
  if (knownGroupIds) ids = ids.filter((id) => knownGroupIds.has(id));
  return ids;
}

export function normalizeContact(item, knownGroupIds) {
  const emails = asStringArray(item?.emails).map((email) => email.toLowerCase());
  const categories = asStringArray(item?.categories).filter((id) => id);
  return {
    id: String(item?.id || crypto.randomUUID()),
    name: String(item?.name || '').trim(),
    company: String(item?.company || '').trim(),
    position: String(item?.position || '').trim(),
    emails,
    phone: asPhone(item?.phone),
    mainContactPerson: String(item?.mainContactPerson || '').trim(),
    categories,
    groups: legacyGroups(item, knownGroupIds),
    newsletter: legacyNewsletter(item),
    firstContactDate: asIsoDate(item?.firstContactDate),
    lastContactDate: asIsoDate(item?.lastContactDate),
    summary: stripImportedListNote(item?.summary),
    summaryUpdatedAt: String(item?.summaryUpdatedAt || ''),
    summaryHash: String(item?.summaryHash || ''),
    summaryStale: Boolean(item?.summaryStale),
    linkedEmails: asStringArray(item?.linkedEmails),
    linkedGranolaNotes: asStringArray(item?.linkedGranolaNotes),
    events: Array.isArray(item?.events) ? item.events.slice(0, 80).map(normalizeEvent) : [],
    interactions: interactionsForContact(item, emails),
    dismissedKeys: asStringArray(item?.dismissedKeys).slice(0, 200)
  };
}

/* The address a list actually mails is the first one on the contact. */
export function mailingAddress(contact) {
  return String(contact?.emails?.[0] || '').trim().toLowerCase();
}

export function splitPersonName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts.shift() || '',
    lastName: parts.join(' ')
  };
}

/* Anyone can be in a group. The preview only says who is new and who is already in it. */
export function previewGroupChange(contacts, group) {
  const addIds = [];
  const removeIds = [];
  let already = 0;
  for (const contact of contacts || []) {
    const member = Boolean(group?.id) && (contact?.groups || []).includes(group.id);
    if (member) {
      already += 1;
      removeIds.push(contact.id);
    } else if (contact?.id) {
      addIds.push(contact.id);
    }
  }
  return { add: addIds.length, already, addIds, removeIds };
}

export function formatGroupPreview(preview) {
  return `${preview.add} will be added · ${preview.already} already in it`;
}

export function csvField(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function groupCsv(contacts, group) {
  const lines = ['Email Address,First Name,Last Name,Tags'];
  for (const contact of contacts || []) {
    if (!group?.id || !(contact?.groups || []).includes(group.id)) continue;
    if (contact?.newsletter?.status !== 'agreed') continue;
    const email = mailingAddress(contact);
    if (!email) continue;
    const { firstName, lastName } = splitPersonName(contact.name);
    lines.push([email, firstName, lastName, group.name || ''].map(csvField).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function normalizeSourceEmail(item, id) {
  return {
    id: String(item?.id || id || ''),
    subject: String(item?.subject || '').trim(),
    from: String(item?.from || '').trim(),
    to: String(item?.to || '').trim(),
    date: String(item?.date || ''),
    snippet: String(item?.snippet || '').slice(0, 600)
  };
}

export function normalizeSourceNote(item, id) {
  return {
    id: String(item?.id || id || ''),
    title: String(item?.title || '').trim(),
    date: String(item?.date || ''),
    attendees: asStringArray(item?.attendees),
    summary: String(item?.summary || '').slice(0, 1600)
  };
}

/* An explicit groups array, even empty, is the new model. Only a document
   that still has mailingLists and no groups key is migrated. */
function groupsFromState(src) {
  const used = new Set();
  if (Array.isArray(src?.groups)) {
    return src.groups.map((item) => normalizeGroup(item, used));
  }
  const lists = Array.isArray(src?.mailingLists) ? src.mailingLists : [];
  return lists
    .filter((item) => item && item.kind === 'internal')
    .map((item) => normalizeGroup({
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      createdBy: item.createdBy
    }, used));
}

export function normalizeContactsState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const used = new Set();
  let categories = Array.isArray(src.categories)
    ? src.categories.map((item) => normalizeCategory(item, used))
    : [];
  if (!categories.length) {
    categories = DEFAULT_CATEGORIES.map((item) => normalizeCategory({ ...item }, used));
  }
  categories = withManagerCategories(categories, used);
  const known = new Set(categories.map((item) => item.id));
  const groups = groupsFromState(src);
  const knownGroups = new Set(groups.map((item) => item.id));
  const contacts = Array.isArray(src.contacts)
    ? src.contacts.map((item) => normalizeContact(item, knownGroups)).map((contact) => {
      contact.categories = contact.categories.filter((id) => known.has(id));
      return contact;
    })
    : [];
  const emails = {};
  const notes = {};
  const emailSrc = src.sources && typeof src.sources === 'object' ? src.sources.emails : {};
  const noteSrc = src.sources && typeof src.sources === 'object' ? src.sources.notes : {};
  if (emailSrc && typeof emailSrc === 'object') {
    for (const [id, item] of Object.entries(emailSrc)) {
      emails[id] = normalizeSourceEmail(item, id);
    }
  }
  if (noteSrc && typeof noteSrc === 'object') {
    for (const [id, item] of Object.entries(noteSrc)) {
      notes[id] = normalizeSourceNote(item, id);
    }
  }
  const suggestions = Array.isArray(src.suggestions)
    ? src.suggestions.slice(0, 30).map((item) => ({
      name: String(item?.name || '').trim(),
      email: String(item?.email || '').trim().toLowerCase(),
      count: Number(item?.count) || 0,
      lastDate: asIsoDate(item?.lastDate)
    })).filter((item) => item.email)
    : [];
  const dismissedInbound = asStringArray(src.dismissedInbound)
    .map((email) => email.toLowerCase())
    .filter((email) => email.includes('@'))
    .slice(0, 400);
  const proposals = mergeProposals(src.proposals, [], {
    known: contacts.flatMap((contact) => contact.emails),
    dismissed: dismissedInbound
  });
  return {
    categories,
    groups,
    contacts,
    sources: { emails, notes },
    suggestions,
    proposals,
    dismissedInbound,
    settings: {
      relevanceVocabulary: normalizeVocabulary(src.settings?.relevanceVocabulary)
    },
    lastSyncAt: String(src.lastSyncAt || ''),
    lastSummarizeAt: String(src.lastSummarizeAt || '')
  };
}

export function defaultCategoryIds() {
  return CATEGORY_IDS;
}

function managerCategoryIds(categories) {
  const ids = new Set(MANAGER_CATEGORY_IDS);
  for (const cat of categories || []) if (cat?.managersOnly) ids.add(cat.id);
  return ids;
}

/* Employees, applicants and volunteers stay with Alex and Sam. */
export function isManagerOnlyContact(contact, categories) {
  const ids = managerCategoryIds(categories);
  return (contact?.categories || []).some((id) => ids.has(id));
}

/* What the rest of the team receives: every other contact, without the
   Review inbox or the raw mail and meeting sources behind it. */
export function contactsStateFor(state, manager) {
  if (manager || !state) return state;
  return {
    ...state,
    contacts: (state.contacts || []).filter((contact) => !isManagerOnlyContact(contact, state.categories)),
    sources: { emails: {}, notes: {} },
    proposals: [],
    dismissedInbound: []
  };
}

/* A team member saves only what they were sent. Restricted contacts and the
   Review inbox come back from the stored copy, and restricted categories stay. */
export function mergeTeamContactsEdit(current, incoming) {
  const stored = current || emptyContactsState();
  const restricted = managerCategoryIds(stored.categories);
  const hidden = (stored.contacts || []).filter((contact) => isManagerOnlyContact(contact, stored.categories));
  const hiddenIds = new Set(hidden.map((contact) => contact.id));
  const sent = (incoming?.contacts || [])
    .filter((contact) => !hiddenIds.has(contact?.id))
    .map((contact) => ({
      ...contact,
      categories: (contact?.categories || []).filter((id) => !restricted.has(id))
    }));
  const categories = [
    ...(incoming?.categories || []).filter((cat) => !restricted.has(cat?.id)),
    ...(stored.categories || []).filter((cat) => restricted.has(cat.id))
  ];
  return {
    ...incoming,
    categories,
    contacts: [...sent, ...hidden],
    sources: stored.sources,
    proposals: stored.proposals,
    dismissedInbound: stored.dismissedInbound
  };
}

const NAME_ALIASES = new Map([
  ['Sam Manager', 'sam manager']
]);

/* An address belongs to the platform when it is on the YourOrg domain,
   or when it is a login, a profile, or a connected mailbox. */
export function isInternalAddress(email, internalEmails) {
  const address = String(email || '').trim().toLowerCase();
  if (!address.includes('@')) return false;
  if (address.endsWith(`@${EMAIL_DOMAIN}`)) return true;
  return Boolean(internalEmails?.has(address));
}

export function internalEmailSet(tokens, profiles) {
  const set = new Set();
  const add = (email) => {
    const address = String(email || '').trim().toLowerCase();
    if (address.includes('@')) set.add(address);
  };
  for (const member of TEAM_MEMBERS) add(`${member.id}@${EMAIL_DOMAIN}`);
  for (const entry of envUsers()) add(`${entry.user}@${EMAIL_DOMAIN}`);
  for (const [user, record] of Object.entries(tokens || {})) {
    add(`${user}@${EMAIL_DOMAIN}`);
    add(record?.email);
  }
  for (const [user, profile] of Object.entries(profilesFromHash(profiles))) {
    add(`${user}@${EMAIL_DOMAIN}`);
    add(profile?.email);
  }
  return set;
}

export function internalNameSet(profiles) {
  const names = new Set();
  const add = (name) => {
    const folded = foldName(name);
    if (folded) names.add(folded);
  };
  for (const member of TEAM_MEMBERS) add(member.name);
  for (const profile of Object.values(profilesFromHash(profiles))) add(profile?.name);
  return names;
}

export function isInternalContact(contact, internalEmails, internalNames) {
  const emails = internalEmails || internalEmailSet();
  const names = internalNames || internalNameSet();
  let folded = foldName(contact?.name);
  if (NAME_ALIASES.has(folded)) folded = NAME_ALIASES.get(folded);
  if (folded && names.has(folded)) return true;
  return (contact?.emails || []).some((email) => isInternalAddress(email, emails));
}

/* Notes belong on the people the team met, not on the team's own profiles. */
export function isOwnContact(contact) {
  return isInternalContact(contact);
}

function interactionsForContact(item, emails) {
  const notes = normalizeInteractions(item?.interactions);
  if (!isInternalContact({ name: item?.name, emails })) return notes;
  return notes.filter((note) => note.status === 'written');
}

export function foldName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeProposal(item) {
  const email = String(item?.email || '').trim().toLowerCase();
  const messageIds = asStringArray(item?.messageIds).slice(0, 30);
  const count = Math.max(messageIds.length, Number(item?.count) || (email ? 1 : 0));
  const owner = item?.owner === 'alex' || item?.owner === 'sam' ? item.owner : '';
  return {
    email,
    name: String(item?.name || '').trim().slice(0, 160),
    subject: String(item?.subject || '').trim().slice(0, 200),
    snippet: String(item?.snippet || '').trim().slice(0, 240),
    summary: String(item?.summary || '').trim().slice(0, 600),
    date: asIsoDate(item?.date),
    owner,
    count,
    messageIds
  };
}

/* The same Gmail message must not raise the count twice if the morning
   review is saved more than once. */
export function mergeProposals(current, incoming, { known, dismissed, own } = {}) {
  const skip = new Set(
    [...(known || []), ...(dismissed || []), ...(own || [])]
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const map = new Map();
  const absorb = (item, fresh) => {
    const next = normalizeProposal(item);
    if (!next.email || skip.has(next.email)) return;
    const prev = map.get(next.email);
    if (!prev) {
      map.set(next.email, next);
      return;
    }
    if (next.name && !prev.name) prev.name = next.name;
    if (!prev.owner && next.owner) prev.owner = next.owner;
    if (!prev.summary && next.summary) prev.summary = next.summary;
    const seen = new Set(prev.messageIds);
    let added = 0;
    for (const id of next.messageIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      prev.messageIds.push(id);
      added += 1;
    }
    prev.messageIds = prev.messageIds.slice(-30);
    if (added) prev.count += added;
    else if (fresh && !next.messageIds.length) prev.count += next.count || 1;
    if (next.date && (!prev.date || next.date >= prev.date)) {
      const newer = !prev.date || next.date > prev.date;
      const changed = (next.subject && next.subject !== prev.subject)
        || (next.snippet && next.snippet !== prev.snippet);
      prev.date = next.date;
      if (next.subject) prev.subject = next.subject;
      if (next.snippet) prev.snippet = next.snippet;
      if (newer && next.owner) prev.owner = next.owner;
      if (changed) prev.summary = next.summary || '';
    }
  };
  for (const item of current || []) absorb(item, false);
  for (const item of incoming || []) absorb(item, true);
  return [...map.values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.count - a.count)
    .slice(0, 40);
}

export function parseFromHeader(value) {
  const raw = String(value || '').trim();
  const angle = raw.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    return {
      name: angle[1].replace(/^"|"$/g, '').trim(),
      email: angle[2].trim().toLowerCase()
    };
  }
  if (raw.includes('@')) return { name: '', email: raw.toLowerCase() };
  return { name: raw, email: '' };
}

export function matchContact(contacts, { email, name }) {
  const address = String(email || '').trim().toLowerCase();
  if (address) {
    const byEmail = contacts.find((contact) => contact.emails.includes(address));
    if (byEmail) return { contact: byEmail, how: 'email' };
  }
  const folded = foldName(name);
  if (!folded) return null;
  const parts = folded.split(' ').filter(Boolean);
  if (parts.length < 2 && folded.length < 8) return null;
  const byName = contacts.find((contact) => {
    const target = foldName(contact.name);
    if (!target) return false;
    if (target === folded) return true;
    const targetParts = target.split(' ').filter(Boolean);
    if (parts.length >= 2 && targetParts.length >= 2) {
      return parts[0] === targetParts[0] && parts[parts.length - 1] === targetParts[targetParts.length - 1];
    }
    return false;
  });
  return byName ? { contact: byName, how: 'name' } : null;
}

export function touchDates(contact, iso) {
  const day = asIsoDate(iso);
  if (!day) return contact;
  if (!contact.firstContactDate || day < contact.firstContactDate) contact.firstContactDate = day;
  if (!contact.lastContactDate || day > contact.lastContactDate) contact.lastContactDate = day;
  return contact;
}

export function sourceHashFor(contact, sources) {
  const written = (contact.interactions || []).filter((item) => item.status === 'written' && item.summary);
  if (written.length) {
    return written
      .map((item) => `${item.sourceKey}|${item.date}|${item.summary}|${(item.tasks || []).map((task) => `${task.owner}:${task.text}`).join(';')}`)
      .join('\n');
  }
  const emails = (contact.linkedEmails || [])
    .map((id) => sources?.emails?.[id])
    .filter(Boolean)
    .map((item) => `${item.id}|${item.date}|${item.subject}|${item.snippet}`);
  const notes = (contact.linkedGranolaNotes || [])
    .map((id) => sources?.notes?.[id])
    .filter(Boolean)
    .map((item) => `${item.id}|${item.date}|${item.title}|${item.summary}`);
  return [...emails, ...notes].join('\n');
}

export async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text || '')));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function integrationStatus(gmailAccount) {
  return {
    gmail: {
      configured: Boolean(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
      connected: Boolean(gmailAccount?.email),
      email: gmailAccount?.email || ''
    },
    granola: {
      configured: Boolean(process.env.GRANOLA_API_KEY)
    },
    anthropic: {
      configured: Boolean(process.env.ANTHROPIC_API_KEY)
    },
    mailchimp: {
      configured: Boolean(
        process.env.MAILCHIMP_API_KEY
        && process.env.MAILCHIMP_SERVER_PREFIX
        && process.env.MAILCHIMP_AUDIENCE_ID
      )
    }
  };
}

function titleFromLogin(id) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function profileRecord(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

/* Upstash HGETALL is an object; some clients return a flat [field, value] list. */
export function profilesFromHash(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const out = {};
    for (let i = 0; i < raw.length; i += 2) {
      const id = String(raw[i] || '').trim().toLowerCase();
      if (id) out[id] = profileRecord(raw[i + 1]);
    }
    return out;
  }
  if (typeof raw !== 'object') return {};
  const out = {};
  for (const [user, value] of Object.entries(raw)) {
    const id = String(user || '').trim().toLowerCase();
    if (id) out[id] = profileRecord(value);
  }
  return out;
}

/* Seed members stay as stored on existing contacts. Anyone new — an account
   or a saved profile — is appended, using the profile name when there is one. */
export function memberDirectory(profiles, extraUserIds = []) {
  const byId = new Map(TEAM_MEMBERS.map((member) => [member.id, { ...member }]));
  for (const [id, profile] of Object.entries(profilesFromHash(profiles))) {
    if (byId.has(id)) continue;
    const name = String(profile?.name || '').trim().slice(0, 120);
    byId.set(id, { id, name: name || titleFromLogin(id) });
  }
  for (const user of extraUserIds) {
    const id = String(user || '').trim().toLowerCase();
    if (id && !byId.has(id)) byId.set(id, { id, name: titleFromLogin(id) });
  }
  const seedIds = new Set(TEAM_MEMBERS.map((member) => member.id));
  const seeded = TEAM_MEMBERS.map((member) => byId.get(member.id)).filter(Boolean);
  const added = [...byId.values()]
    .filter((member) => !seedIds.has(member.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return [...seeded, ...added];
}

export function teamMemberNames() {
  return TEAM_MEMBERS.map((member) => member.name);
}

const CONTACTS_CAS = `
local current = redis.call('GET', KEYS[1])
local function stamp(raw)
  if type(raw) ~= 'string' then return '0' end
  return string.match(raw, '"updatedAt"%s*:%s*"?(%d+)') or '0'
end
if stamp(current) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

/* Read, mutate, then write only if updatedAt is still the value we read.
   Retries when a contact edit lands between the read and the write. */
export async function updateContactsDoc(target, mutate) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await kvCommand(target, ['GET', CONTACTS_KEY]);
    const current = raw
      ? (typeof raw === 'string' ? JSON.parse(raw) : raw)
      : { updatedAt: 0, updatedBy: '', state: emptyContactsState() };
    const expected = String(current.updatedAt || 0);
    const state = normalizeContactsState(current.state);
    const meta = (await mutate(state)) || {};
    if (meta.skip) {
      return { updatedAt: Number(expected) || 0, updatedBy: current.updatedBy || '', state, skipped: true };
    }
    const doc = {
      updatedAt: Date.now(),
      updatedBy: meta.updatedBy || 'mailchimp',
      state: normalizeContactsState(state)
    };
    const wrote = await kvCommand(target, [
      'EVAL',
      CONTACTS_CAS,
      '1',
      CONTACTS_KEY,
      expected,
      JSON.stringify(doc)
    ]);
    if (Number(wrote) === 1) {
      return { updatedAt: doc.updatedAt, updatedBy: doc.updatedBy, state: doc.state };
    }
  }
  const error = new Error('contacts changed while saving');
  error.status = 409;
  throw error;
}
