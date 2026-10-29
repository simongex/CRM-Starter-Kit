(function () {
  const STORAGE_KEY = 'yourorg-contacts-v1';
  const API = '/api/contacts';
  const TEAM = [
    { id: 'alex', name: 'Alex Admin' },
    { id: 'sam', name: 'Sam Manager' },
    { id: 'jordan', name: 'Jordan Lee' },
    { id: 'taylor', name: 'Taylor Kim' },
    { id: 'robin', name: 'Robin Park' },
    { id: 'casey', name: 'Casey Lim' },
    { id: 'morgan', name: 'Morgan Reed' }
  ];
  const DEFAULT_VOCABULARY = [
    'partnership', 'proposal', 'contract', 'meeting', 'grant', 'funding',
    'sponsorship', 'project', 'introduction', 'follow-up'
  ];
  const DEFAULT_CATEGORIES = [
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

  const rootEl = document.getElementById('contacts-root');
  const panelEl = document.getElementById('contacts-panel');
  if (!rootEl || !panelEl) return;

  let state = emptyState();
  let serverVersion = 0;
  let syncMode = 'local';
  let integrations = { gmail: {}, granola: {}, anthropic: {}, mailchimp: {} };
  let view = 'list';
  let selectedId = null;
  let listPlace = { wrapTop: 0, wrapLeft: 0, pageTop: 0 };
  let sortKey = 'last';
  let sortDir = 'desc';
  let personFilter = '';
  let categoryFilter = '';
  let groupFilter = '';
  let search = '';
  let newsletterOpen = false;
  let groupMenu = false;
  let groupQuery = '';
  let renamingGroup = '';
  const renameBase = new Map();
  const NEWSLETTER_STATUSES = new Set(['not-asked', 'agreed', 'declined', 'unsubscribed']);
  const NEWSLETTER_EVENTS = new Set(['agreed', 'declined', 'removed', 'unsubscribed', 'resubscribed']);
  let members = TEAM.map((member) => ({ ...member }));
  let statusText = '';
  {
    const gmail = new URLSearchParams(location.search).get('gmail');
    if (gmail === 'connected') statusText = 'Gmail connected';
    if (gmail === 'error') statusText = 'Could not connect Gmail';
  }
  let holdId = '';
  let busy = false;
  let saveTimer = null;
  let dirty = false;
  let eventDraft = null;
  let contactBackup = null;
  let contactIsNew = false;
  let contactLeaveOpen = false;
  let proposalDraft = null;
  const proposalDrafts = new Map();
  let reviewOpen = false;
  const CHANNELS = [
    ['gmail', 'Gmail'],
    ['granola', 'Granola'],
    ['phone', 'Phone Call'],
    ['in-person', 'In Person Meeting'],
    ['correspondence', 'Correspondence']
  ];

  function uid() {
    return crypto.randomUUID();
  }

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function cookieValue(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  function emptyState() {
    return {
      categories: DEFAULT_CATEGORIES.map((item) => ({ ...item })),
      groups: [],
      contacts: [],
      sources: { emails: {}, notes: {} },
      suggestions: [],
      proposals: [],
      dismissedInbound: [],
      settings: { relevanceVocabulary: DEFAULT_VOCABULARY.slice() },
      lastSyncAt: '',
      lastSummarizeAt: ''
    };
  }

  function signedInPerson() {
    const login = cookieValue('kb_user').toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '');
    const match = members.find((member) => member.id === login)
      || (login.includes('sam') ? members.find((member) => member.id === 'sam') : null);
    return match?.name || members[0]?.name || 'Alex Admin';
  }

  function setMembers(list) {
    if (!Array.isArray(list)) return;
    const next = list.map((item) => ({
      id: String(item?.id || '').trim().toLowerCase(),
      name: String(item?.name || '').trim()
    })).filter((item) => item.id && item.name);
    if (next.length) members = next;
  }

  function normalizeCategory(item, used) {
    const name = String(item?.name || 'Category').trim() || 'Category';
    let id = String(item?.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 64);
    if (!id) id = 'category';
    let n = 2;
    const base = id;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    const category = {
      id,
      name,
      color: /^#[0-9a-fA-F]{6}$/.test(item?.color || '') ? item.color : '#9a9a9a'
    };
    if (id === 'volunteers' || id === 'employees') category.managersOnly = true;
    return category;
  }

  function ensureManagerCategories(categories, used) {
    const present = new Set(categories.map((item) => item.id));
    for (const item of DEFAULT_CATEGORIES) {
      if (!item.managersOnly || present.has(item.id)) continue;
      categories.push(normalizeCategory(item, used));
    }
    return categories;
  }

  function categoryVisible(cat) {
    if (!cat?.managersOnly) return true;
    return canReview();
  }

  function contactHidden(contact) {
    return (contact?.categories || []).some((id) => {
      const cat = findCategory(id);
      if (cat) return !categoryVisible(cat);
      return id === 'volunteers' || id === 'employees';
    });
  }

  function slugifyCategory(name) {
    const slug = String(name || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    return slug || 'category';
  }

  function normalizeGroup(item, used) {
    const name = String(item?.name || 'Group').trim().slice(0, 80) || 'Group';
    let id = String(item?.id || slugifyCategory(name)).slice(0, 64) || 'group';
    const base = id;
    let n = 2;
    while (used.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    used.add(id);
    return {
      id,
      name,
      createdAt: String(item?.createdAt || '').slice(0, 40),
      createdBy: String(item?.createdBy || '').trim().slice(0, 64)
    };
  }

  function isoDay(value) {
    const raw = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
  }

  function normalizeHistory(value) {
    if (!Array.isArray(value)) return [];
    const entries = [];
    for (const item of value) {
      const event = NEWSLETTER_EVENTS.has(item?.event) ? item.event : '';
      if (!event) continue;
      const via = String(item?.via || '').trim().slice(0, 40);
      entries.push({
        date: isoDay(item?.date),
        event,
        by: String(item?.by || '').trim().slice(0, 64),
        ...(via ? { via } : {})
      });
    }
    return entries.slice(-50);
  }

  function normalizeNewsletter(item) {
    const src = item && typeof item === 'object' ? item : {};
    const status = NEWSLETTER_STATUSES.has(src.status) ? src.status : 'not-asked';
    const syncedEmail = String(src.syncedEmail || '').trim().toLowerCase();
    return {
      status,
      date: status === 'not-asked' ? '' : isoDay(src.date),
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

  function applyNewsletterChoice(newsletter, choice, { date = '', by = '', note, via = '' } = {}) {
    const current = normalizeNewsletter(newsletter);
    if (current.status === 'unsubscribed') return current;
    if (note !== undefined) current.note = String(note || '').trim().slice(0, 200);
    if (choice !== 'agreed' && choice !== 'declined' && choice !== 'not-asked') return current;
    if (choice === current.status) return current;
    const day = isoDay(date);
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

  function legacyNewsletter(item) {
    if (item?.newsletter && NEWSLETTER_STATUSES.has(item.newsletter.status)) {
      return normalizeNewsletter(item.newsletter);
    }
    const mailing = item?.mailing && typeof item.mailing === 'object' ? item.mailing : null;
    if (!mailing) return normalizeNewsletter(null);
    const lists = Array.isArray(mailing.lists) ? mailing.lists.map((id) => String(id || '').trim()) : [];
    const syncedEmail = mailing.syncedEmail;
    const syncedAt = mailing.syncedAt;
    if (mailing.status === 'unsubscribed' || mailing.status === 'cleaned') {
      return normalizeNewsletter({
        status: 'unsubscribed',
        mailchimpStatus: mailing.status,
        syncedAt,
        syncedEmail,
        history: [{ date: '', event: 'unsubscribed', by: '' }]
      });
    }
    if (lists.includes('newsletter') && mailing.consent) {
      const date = isoDay(mailing.consentDate);
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

  function legacyGroupIds(item, knownGroups) {
    const source = Array.isArray(item?.groups)
      ? item.groups
      : (Array.isArray(item?.mailing?.lists) ? item.mailing.lists : []);
    let ids = [...new Set(source.map((id) => String(id || '').trim()).filter(Boolean))];
    if (knownGroups) ids = ids.filter((id) => knownGroups.has(id));
    return ids;
  }

  function stripImportedListNote(text) {
    return String(text || '')
      .replace(/[ \t]*\[Imported list:[^\]]*\]/gi, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function normalizeContact(item, knownGroups) {
    const emails = Array.isArray(item?.emails) ? [...new Set(item.emails.map((email) => String(email).trim().toLowerCase()).filter(Boolean))] : [];
    return {
      id: String(item?.id || uid()),
      name: String(item?.name || '').trim(),
      company: String(item?.company || '').trim(),
      position: String(item?.position || '').trim(),
      emails,
      phone: String(item?.phone || '').trim().slice(0, 40),
      mainContactPerson: String(item?.mainContactPerson || '').trim(),
      categories: Array.isArray(item?.categories) ? item.categories.map(String) : [],
      groups: legacyGroupIds(item, knownGroups),
      newsletter: legacyNewsletter(item),
      firstContactDate: String(item?.firstContactDate || '').slice(0, 10),
      lastContactDate: String(item?.lastContactDate || '').slice(0, 10),
      summary: stripImportedListNote(item?.summary),
      summaryUpdatedAt: String(item?.summaryUpdatedAt || ''),
      summaryHash: String(item?.summaryHash || ''),
      summaryStale: Boolean(item?.summaryStale),
      linkedEmails: Array.isArray(item?.linkedEmails) ? item.linkedEmails.map(String) : [],
      linkedGranolaNotes: Array.isArray(item?.linkedGranolaNotes) ? item.linkedGranolaNotes.map(String) : [],
      events: Array.isArray(item?.events) ? item.events.slice(0, 80).map(normalizeEvent) : [],
      interactions: keptInteractions(item, emails),
      dismissedKeys: Array.isArray(item?.dismissedKeys) ? item.dismissedKeys.map((key) => String(key || '').trim()).filter(Boolean).slice(0, 200) : []
    };
  }

  function normalizeInteraction(item) {
    const source = item?.source === 'granola' ? 'granola' : 'gmail';
    const status = item?.status === 'written' || item?.status === 'skipped' ? item.status : 'pending';
    const lang = String(item?.sourceLanguage || '').trim().toLowerCase();
    return {
      id: String(item?.id || uid()),
      source,
      sourceKey: String(item?.sourceKey || '').trim().slice(0, 500),
      date: String(item?.date || '').slice(0, 10),
      lead: String(item?.lead || '').trim().toLowerCase().slice(0, 64),
      participants: Array.isArray(item?.participants)
        ? [...new Set(item.participants.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean))].slice(0, 40)
        : [],
      summary: stripImportedListNote(item?.summary).slice(0, 4000),
      tasks: Array.isArray(item?.tasks)
        ? item.tasks.map((task) => {
          const text = String(task?.text || '').trim().slice(0, 500);
          const owner = String(task?.owner || '').trim().slice(0, 120);
          if (!text) return null;
          const next = { text, owner };
          const linked = String(task?.programmeTaskId || '').trim().slice(0, 80);
          if (linked) next.programmeTaskId = linked;
          const actionId = String(task?.programmeActionId || '').trim().slice(0, 80);
          if (actionId) next.programmeActionId = actionId;
          const due = String(task?.due || '').slice(0, 10);
          if (/^\d{4}-\d{2}-\d{2}$/.test(due)) next.due = due;
          return next;
        }).filter(Boolean).slice(0, 20)
        : [],
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
      .slice(-200);
  }

  function foldPerson(value) {
    return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function ownContact(name, emails) {
    const names = new Set(TEAM.map((member) => foldPerson(member.name)));
    names.add('Sam Manager');
    for (const member of members) {
      const folded = foldPerson(member.name);
      if (folded) names.add(folded);
    }
    const folded = foldPerson(name);
    const alias = folded === 'Sam Manager' ? 'sam manager' : folded;
    if (alias && names.has(alias)) return true;
    return (emails || []).some((email) => String(email || '').trim().toLowerCase().endsWith('@example.org'));
  }

  function keptInteractions(item, emails) {
    const notes = normalizeInteractions(item?.interactions);
    if (!ownContact(item?.name, emails)) return notes;
    return notes.filter((note) => note.status === 'written');
  }

  function channelName(id) {
    return CHANNELS.find((item) => item[0] === id)?.[1] || 'Gmail';
  }

  function normalizeEvent(item) {
    const channel = CHANNELS.some((entry) => entry[0] === item?.channel) ? item.channel : 'gmail';
    const date = String(item?.date || '').slice(0, 10);
    return {
      id: String(item?.id || uid()),
      title: String(item?.title || '').trim().slice(0, 160),
      channel,
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
      person: String(item?.person || '').trim().slice(0, 120),
      followUpDone: Boolean(item?.followUpDone),
      notes: stripImportedListNote(item?.notes).slice(0, 8000)
    };
  }

  function normalizeState(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const used = new Set();
    const categories = Array.isArray(src.categories) && src.categories.length
      ? src.categories.map((item) => normalizeCategory(item, used))
      : DEFAULT_CATEGORIES.map((item) => normalizeCategory({ ...item }, used));
    ensureManagerCategories(categories, used);
    const known = new Set(categories.map((item) => item.id));
    const groupUsed = new Set();
    const groups = Array.isArray(src.groups)
      ? src.groups.map((item) => normalizeGroup(item, groupUsed))
      : (Array.isArray(src.mailingLists) ? src.mailingLists : [])
        .filter((item) => item && item.kind === 'internal')
        .map((item) => normalizeGroup(item, groupUsed));
    const knownGroups = new Set(groups.map((item) => item.id));
    return {
      categories,
      groups,
      contacts: Array.isArray(src.contacts)
        ? src.contacts.map((item) => normalizeContact(item, knownGroups)).map((contact) => {
          contact.categories = contact.categories.filter((id) => known.has(id));
          return contact;
        })
        : [],
      sources: {
        emails: src.sources?.emails && typeof src.sources.emails === 'object' ? src.sources.emails : {},
        notes: src.sources?.notes && typeof src.sources.notes === 'object' ? src.sources.notes : {}
      },
      suggestions: Array.isArray(src.suggestions) ? src.suggestions : [],
      proposals: normalizeProposals(src.proposals, Array.isArray(src.contacts) ? src.contacts : [], src.dismissedInbound),
      dismissedInbound: normalizeDismissed(src.dismissedInbound),
      settings: {
        relevanceVocabulary: Array.isArray(src.settings?.relevanceVocabulary)
          ? src.settings.relevanceVocabulary.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 80)
          : DEFAULT_VOCABULARY.slice()
      },
      lastSyncAt: String(src.lastSyncAt || ''),
      lastSummarizeAt: String(src.lastSummarizeAt || '')
    };
  }

  function cache() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function loadLocal() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && Array.isArray(raw.contacts)) return normalizeState(raw);
    } catch {
      /* empty */
    }
    return emptyState();
  }

  function findContact(id) {
    if (proposalDraft && proposalDraft.id === id) return proposalDraft;
    return state.contacts.find((item) => item.id === id) || null;
  }

  function normalizeDismissed(value) {
    const emails = Array.isArray(value) ? value : [];
    return [...new Set(emails.map((email) => String(email || '').trim().toLowerCase()).filter((email) => email.includes('@')))].slice(0, 400);
  }

  function normalizeProposals(list, contacts, dismissed) {
    const skip = new Set([
      ...(Array.isArray(contacts) ? contacts.flatMap((contact) => contact?.emails || []) : []),
      ...normalizeDismissed(dismissed)
    ].map((email) => String(email || '').trim().toLowerCase()));
    const map = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      const email = String(item?.email || '').trim().toLowerCase();
      if (!email.includes('@') || skip.has(email) || map.has(email)) continue;
      const messageIds = Array.isArray(item?.messageIds)
        ? item.messageIds.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 30)
        : [];
      const owner = item?.owner === 'alex' || item?.owner === 'sam' ? item.owner : '';
      map.set(email, {
        email,
        name: String(item?.name || '').trim().slice(0, 160),
        subject: String(item?.subject || '').trim().slice(0, 200),
        snippet: String(item?.snippet || '').trim().slice(0, 240),
        summary: String(item?.summary || '').trim().slice(0, 600),
        date: isoDay(item?.date),
        owner,
        count: Math.max(messageIds.length, Number(item?.count) || 1),
        messageIds
      });
    }
    return [...map.values()]
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.count - a.count)
      .slice(0, 40);
  }

  function canReview() {
    const id = signedInId();
    return id === 'alex' || id === 'sam' || id === 'sam';
  }

  function findCategory(id) {
    return state.categories.find((item) => item.id === id) || null;
  }

  function displayDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return '—';
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }

  function categoryTags(ids) {
    return (ids || []).map((id) => {
      const cat = findCategory(id);
      if (!cat || !categoryVisible(cat)) return '';
      return `<span class="cat-tag" style="--cat:${esc(cat.color)}">${esc(cat.name)}</span>`;
    }).join('');
  }

  function categoryNames(contact) {
    return (contact.categories || [])
      .map((id) => findCategory(id))
      .filter((cat) => cat && categoryVisible(cat))
      .map((cat) => cat.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  function latestInteractionDate(contact) {
    const dates = [];
    for (const item of contact.interactions || []) {
      if ((item.status === 'written' || item.status === 'pending') && item.date) dates.push(String(item.date).slice(0, 10));
    }
    for (const item of contact.events || []) {
      if (item.date) dates.push(String(item.date).slice(0, 10));
    }
    return dates.sort().pop() || '';
  }

  function syncLastContacts() {
    let changed = false;
    for (const contact of state.contacts) {
      const latest = latestInteractionDate(contact);
      if (latest && latest > (contact.lastContactDate || '')) {
        contact.lastContactDate = latest;
        changed = true;
      }
    }
    if (changed) save();
  }

  function sortValue(contact, key) {
    if (key === 'name') return contact.name || '';
    if (key === 'company') return contact.company || '';
    if (key === 'position') return contact.position || '';
    if (key === 'person') return contact.mainContactPerson || '';
    if (key === 'category') return categoryNames(contact).join(', ');
    if (key === 'first') return contact.firstContactDate || '';
    return contact.lastContactDate || '';
  }

  function compareSort(a, b) {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    const aEmpty = !String(av).trim();
    const bEmpty = !String(bv).trim();
    if (aEmpty && bEmpty) return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const n = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true });
    if (n) return sortDir === 'desc' ? -n : n;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  }

  function filteredContacts() {
    const q = search.trim().toLowerCase();
    return state.contacts
      .filter((contact) => {
        if (contactHidden(contact)) return false;
        if (personFilter && contact.mainContactPerson !== personFilter) return false;
        if (categoryFilter && !(contact.categories || []).includes(categoryFilter)) return false;
        if (groupFilter && !(contact.groups || []).includes(groupFilter)) return false;
        if (!q) return true;
        const hay = [contact.name, contact.company, contact.position, contact.phone, contact.mainContactPerson, ...categoryNames(contact), ...(contact.emails || [])]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      })
      .sort(compareSort);
  }

  function rememberListPlace() {
    const wrap = panelEl.querySelector('.contacts-table-wrap');
    if (!wrap) return;
    const page = document.scrollingElement || document.documentElement;
    listPlace = { wrapTop: wrap.scrollTop, wrapLeft: wrap.scrollLeft, pageTop: page.scrollTop };
  }

  function restoreListPlace() {
    const wrap = panelEl.querySelector('.contacts-table-wrap');
    const page = document.scrollingElement || document.documentElement;
    const place = listPlace;
    const apply = () => {
      const current = panelEl.querySelector('.contacts-table-wrap');
      if (current) {
        current.scrollTop = place.wrapTop;
        current.scrollLeft = place.wrapLeft;
      }
      page.scrollTop = place.pageTop;
    };
    apply();
    requestAnimationFrame(apply);
  }

  function render() {
    if (eventDraft?._skipLinkRead) eventDraft._skipLinkRead = false;
    else readActionLink();
    if (rootEl.hidden) return;
    syncLastContacts();
    if ((view === 'detail' || view === 'proposal') && document.getElementById('c-name')) writeDetail();
    const leavingList = (view === 'detail' || view === 'proposal') && !!panelEl.querySelector('.contacts-table-wrap');
    rememberListPlace();
    if (view === 'detail' || view === 'proposal') renderDetail();
    else if (view === 'categories') renderCategories();
    else if (view === 'groups') renderGroups();
    else if (view === 'skipped') renderSkipped();
    else if (view === 'settings') renderSettings();
    else renderList();
    if (leavingList) {
      const page = document.scrollingElement || document.documentElement;
      page.scrollTop = 0;
    }
    publishRoute();
  }

  function contactHref(id) {
    return `/internal/contacts/${encodeURIComponent(id)}`;
  }

  function contactLink(contact) {
    return `<a class="contact-name" href="${esc(contactHref(contact.id))}" data-contacts="open" data-id="${esc(contact.id)}">${esc(contact.name || 'Untitled')}</a>`;
  }

  function contactRoute() {
    if (view === 'proposal' || (view === 'list' && reviewOpen)) return { view: 'contacts', screen: 'review', id: '' };
    if (view === 'detail' && selectedId) return { view: 'contacts', screen: 'detail', id: selectedId };
    return { view: 'contacts', screen: 'list', id: '' };
  }

  function publishRoute() {
    if (rootEl.hidden) return;
    if (holdId && view === 'detail' && selectedId === holdId && !findContact(holdId)) return;
    if (holdId && selectedId === holdId && findContact(holdId)) holdId = '';
    window.KBRoute?.sync(contactRoute());
  }

  function isPlainClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  function dropUnsavedContact() {
    if (contactIsNew && selectedId) {
      const id = selectedId;
      state.contacts = state.contacts.filter((item) => item.id !== id);
      contactBackup = null;
    }
    contactIsNew = false;
  }

  /* A new contact stays only in this window until Save. Leaving asks with the
     same Save / Discard window as a task. Returns true when that window is open. */
  function holdLeave(next) {
    if (!contactIsNew || view !== 'detail') return false;
    if (contactLeaveOpen) return true;
    contactLeaveOpen = true;
    window.KBLeave?.ask((shouldSave) => {
      contactLeaveOpen = false;
      if (shouldSave) saveContactEdits();
      else dropUnsavedContact();
      next?.();
    }, () => {
      contactLeaveOpen = false;
      window.KBRoute?.sync?.(contactRoute());
    });
    return true;
  }

  function applyRoute(route) {
    if (!route || route.view !== 'contacts') {
      if (contactIsNew && view === 'detail') holdLeave(() => {
        view = 'list';
        selectedId = null;
      });
      return;
    }
    if (contactIsNew && view === 'detail' && !(route.screen === 'detail' && route.id === selectedId)) {
      if (holdLeave(() => applyRoute(route))) return;
    }
    if (route.screen === 'detail' && route.id) {
      if (view === 'proposal') {
        writeDetail();
        stashProposal();
      } else if (view === 'detail' && selectedId && selectedId !== route.id) {
        restoreContactDraft();
      }
      reviewOpen = false;
      selectedId = route.id;
      view = 'detail';
      newsletterOpen = false;
      groupMenu = false;
      groupQuery = '';
      panelEl.innerHTML = '';
      return;
    }
    if (view === 'proposal') {
      writeDetail();
      stashProposal();
    } else if (view === 'detail') restoreContactDraft();
    selectedId = null;
    newsletterOpen = false;
    groupMenu = false;
    groupQuery = '';
    view = 'list';
    reviewOpen = route.screen === 'review' && canReview();
    panelEl.innerHTML = '';
  }

  function clearArrivalQuery() {
    const params = new URLSearchParams(location.search);
    if (!params.has('gmail') && !params.has('contacts')) return;
    params.delete('gmail');
    params.delete('contacts');
    const query = params.toString();
    const path = location.pathname.replace(/\/+$/, '') || '/';
    history.replaceState(history.state, '', query ? `${path}?${query}` : path);
  }

  function toolbar(title, extra) {
    const heading = view === 'list'
      ? `<h1 id="contacts-title" class="contacts-heading">${esc(title)}</h1>`
      : `<h2 id="contacts-title">${esc(title)}</h2>`;
    return `
      <div class="contacts-top">
        <div class="contacts-top-left">
          ${view !== 'list' ? '<button type="button" class="text-btn" data-contacts="back">← List</button>' : ''}
          ${heading}
        </div>
        <div class="contacts-top-actions">
          ${extra || ''}
        </div>
      </div>
    `;
  }

  function sourceBar() {
    const gmail = integrations.gmail || {};
    const granola = integrations.granola || {};
    const anthropic = integrations.anthropic || {};
    const mailchimp = integrations.mailchimp || {};
    const gmailLabel = gmail.connected
      ? `Gmail · ${gmail.email}`
      : (gmail.configured ? 'Gmail · not connected' : 'Gmail · not configured');
    const granolaLabel = granola.configured ? 'Granola · ready' : 'Granola · not configured';
    const summaryLabel = anthropic.configured ? 'Summaries · ready' : 'Summaries · not configured';
    const mailchimpLabel = mailchimp.configured ? 'Mailchimp · ready' : 'Mailchimp · not configured';
    const gmailBtn = gmail.configured && !gmail.connected
      ? '<a class="text-btn" href="/api/gmail">Connect Gmail</a>'
      : '';
    return `
      <div class="contacts-sources">
        <span>${esc(gmailLabel)}</span>
        <span>${esc(granolaLabel)}</span>
        <span>${esc(summaryLabel)}</span>
        <span>${esc(mailchimpLabel)}</span>
        ${gmailBtn}
        ${statusText ? `<span class="contacts-status">${esc(statusText)}</span>` : ''}
      </div>
    `;
  }

  function sortHeader(key, label) {
    const on = sortKey === key;
    const mark = on ? (sortDir === 'asc' ? '↑' : '↓') : '';
    const aria = on ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th aria-sort="${aria}">
      <button type="button" class="th-sort${on ? ' is-on' : ''}" data-contacts="sort" data-key="${key}">${esc(label)}${mark ? `<span class="sort-mark">${mark}</span>` : ''}</button>
    </th>`;
  }

  function renderList() {
    const rows = filteredContacts();
    const people = [...members.map((member) => member.name)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    const categories = state.categories.filter(categoryVisible).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const personOptions = ['<option value="">All</option>'].concat(people.map((name) => (
      `<option value="${esc(name)}"${name === personFilter ? ' selected' : ''}>${esc(name)}</option>`
    ))).join('');
    const categoryOptions = ['<option value="">All</option>'].concat(categories.map((cat) => (
      `<option value="${esc(cat.id)}"${cat.id === categoryFilter ? ' selected' : ''}>${esc(cat.name)}</option>`
    ))).join('');
    const body = rows.length
      ? rows.map((contact) => `
              <tr>
                <td>
                  ${contactLink(contact)}
                </td>
                <td>${esc(contact.company || '—')}</td>
                <td>${esc(contact.position || '—')}</td>
                <td class="person-col">${esc(contact.mainContactPerson || '—')}</td>
                <td><div class="cat-row">${categoryTags(contact.categories) || '—'}</div></td>
                <td>${esc(displayDate(contact.firstContactDate))}</td>
                <td>${esc(displayDate(contact.lastContactDate))}</td>
              </tr>
            `).join('')
      : `<tr><td colspan="7" class="contacts-empty">${state.contacts.length ? 'No contacts match.' : 'No contacts yet. Add one, or connect Gmail / Granola to match correspondence.'}</td></tr>`;

    const table = `
      <div class="contacts-table-wrap">
        <table class="contacts-table">
          <thead>
            <tr>
              ${sortHeader('name', 'Name')}
              ${sortHeader('company', 'Company')}
              ${sortHeader('position', 'Position')}
              <th aria-sort="${sortKey === 'person' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">
                <div class="th-head">
                  <button type="button" class="th-sort${sortKey === 'person' ? ' is-on' : ''}" data-contacts="sort" data-key="person">Main contact${sortKey === 'person' ? `<span class="sort-mark">${sortDir === 'asc' ? '↑' : '↓'}</span>` : ''}</button>
                  <select class="th-filter" data-contacts="filter-person" aria-label="Filter by team member">${personOptions}</select>
                </div>
              </th>
              <th aria-sort="${sortKey === 'category' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}">
                <div class="th-head">
                  <button type="button" class="th-sort${sortKey === 'category' ? ' is-on' : ''}" data-contacts="sort" data-key="category">Categories${sortKey === 'category' ? `<span class="sort-mark">${sortDir === 'asc' ? '↑' : '↓'}</span>` : ''}</button>
                  <select class="th-filter" data-contacts="filter-category" aria-label="Filter by category">${categoryOptions}</select>
                </div>
              </th>
              ${sortHeader('first', 'First contact')}
              ${sortHeader('last', 'Last contact')}
            </tr>
          </thead>
          <tbody>
            ${body}
          </tbody>
        </table>
      </div>
    `;

    const suggestions = (state.suggestions || []).filter((item) => {
      const known = new Set(state.contacts.flatMap((contact) => contact.emails));
      return item.email && !known.has(item.email);
    }).slice(0, 8);

    const suggestBlock = suggestions.length ? `
      <div class="contacts-suggest">
        <h3>Suggested from meetings</h3>
        ${suggestions.map((item) => `
          <div class="suggest-row">
            <span>${esc(item.name || item.email)} · ${esc(item.email)}</span>
            <button type="button" class="text-btn" data-contacts="import-suggestion" data-email="${esc(item.email)}" data-name="${esc(item.name || '')}">Add</button>
          </div>
        `).join('')}
      </div>
    ` : '';

    panelEl.innerHTML = `
      ${toolbar('Contacts', `
        <label class="contacts-search">
          <span class="visually-hidden">Search contacts</span>
          <input type="search" id="contacts-search" placeholder="Search" value="${esc(search)}" autocomplete="off">
        </label>
        ${groupChip()}
        <button type="button" class="text-btn" data-contacts="update-notes"${busy ? ' disabled' : ''}>Update notes</button>
        <button type="button" class="text-btn" data-contacts="add">+ Contact</button>
        ${reviewButton()}
        <button type="button" class="text-btn" data-contacts="categories">Categories</button>
        <button type="button" class="text-btn" data-contacts="groups">Groups</button>
      `)}
      ${table}
      ${suggestBlock}
      ${sourceBar()}
    `;
    restoreListPlace();
    const searchEl = document.getElementById('contacts-search');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        search = searchEl.value;
        render();
        const next = document.getElementById('contacts-search');
        if (next) {
          next.focus();
          next.setSelectionRange(search.length, search.length);
        }
      });
    }
  }

  function reviewButton() {
    if (!canReview()) return '';
    const items = state.proposals || [];
    const count = items.length ? ` · ${items.length}` : '';
    const rows = items.length
      ? items.map((item) => `
          <button type="button" class="review-row" data-contacts="open-proposal" data-email="${esc(item.email)}">
            <strong>${esc(item.name || item.email)}</strong>
            <span>${esc(item.email)}${item.subject ? ` · ${esc(item.subject)}` : ''}</span>
          </button>
        `).join('')
      : '<p class="muted-note">No new contact to review.</p>';
    return `
      <div class="review-wrap${reviewOpen ? ' is-open' : ''}">
        <a class="text-btn new-actions-btn" href="/internal/contacts/review" data-contacts="review" aria-haspopup="dialog" aria-expanded="${reviewOpen ? 'true' : 'false'}">${items.length ? '<span class="new-actions-dot" aria-hidden="true"></span>' : ''}Review${count}</a>
        <div class="review-overlay" data-contacts="close-review">
          <div class="review-window" role="dialog" aria-labelledby="review-title">
            <div class="new-actions-head">
              <h2 id="review-title">New contacts</h2>
              <button type="button" class="text-btn" data-contacts="close-review-window">Close</button>
            </div>
            ${rows}
          </div>
        </div>
      </div>
    `;
  }

  function peopleOptions(current) {
    const names = members.map((member) => member.name);
    if (current && !names.includes(current)) names.push(current);
    return names.map((name) => `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}</option>`).join('');
  }

  function categoryOptions(contact) {
    const current = contact.categories[0] || '';
    const blank = `<option value=""${current ? '' : ' selected'}>—</option>`;
    const choices = state.categories.filter((cat) => categoryVisible(cat) || cat.id === current);
    return blank + choices.map((cat) => (
      `<option value="${esc(cat.id)}"${cat.id === current ? ' selected' : ''}>${esc(cat.name)}</option>`
    )).join('');
  }

  function memberName(id) {
    if (!id) return '';
    return members.find((member) => member.id === id)?.name || id;
  }

  function languageLabel(code) {
    const lang = String(code || '').toLowerCase();
    if (!lang || lang === 'en') return '';
    return `Translated from ${lang.toUpperCase()}`;
  }

  function sourceIcon(source) {
    const label = source === 'granola' ? 'Granola' : 'Gmail';
    const svg = source === 'granola'
      ? '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="4" y="5" width="16" height="15" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 3.5v3M16 3.5v3M4 10h16" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="3" y="6" width="18" height="12" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 7l9 7 9-7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
    return `<span class="source-icon" title="${label}">${svg}<span class="visually-hidden">${label}</span></span>`;
  }

  function skippedRows() {
    const rows = [];
    for (const contact of state.contacts) {
      for (const item of contact.interactions || []) {
        if (item.status === 'skipped') rows.push({ contact, item });
      }
    }
    rows.sort((a, b) => String(b.item.date).localeCompare(String(a.item.date)));
    return rows;
  }

  function skippedCount() {
    return skippedRows().length;
  }

  function noteTitle(item) {
    const custom = String(item?.title || '').trim();
    if (custom && custom.toLowerCase() !== 'granola') return custom;
    if (item?.status === 'written') {
      const sentence = String(item.summary || '').split(/(?<=[.!?])\s/)[0].trim();
      if (sentence) return sentence.slice(0, 160);
    }
    return channelName(item?.source);
  }

  function noteText(item) {
    if (item?.status !== 'written') return 'Waiting to write this note.';
    const marks = [];
    const lang = languageLabel(item.sourceLanguage);
    if (lang) marks.push(lang);
    if (item.styleWarning) marks.push('Style check flagged wording');
    return [item.summary, marks.join(' · ')].filter(Boolean).join('\n\n');
  }

  const NOTE_MONTHS = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12
  };

  function isoParts(year, month, day) {
    const y = Number(year);
    const m = Number(month);
    const d = Number(day);
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function inferDeadline(text) {
    const value = String(text || '');
    let match = value.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (match) return isoParts(match[1], match[2], match[3]);
    match = value.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
    if (match) return isoParts(match[3], match[2], match[1]);
    match = value.match(/\b(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\b/);
    if (match && NOTE_MONTHS[match[2].toLowerCase()]) {
      return isoParts(match[3], NOTE_MONTHS[match[2].toLowerCase()], match[1]);
    }
    return '';
  }

  function actionLabel(text) {
    const words = String(text || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5);
    return words.join(' ') || 'Action';
  }

  function noteTasks(item) {
    return (item?.tasks || []).map((task) => ({
      text: String(task?.text || '').trim(),
      owner: String(task?.owner || '').trim(),
      programmeTaskId: String(task?.programmeTaskId || '').trim(),
      programmeActionId: String(task?.programmeActionId || '').trim(),
      due: /^\d{4}-\d{2}-\d{2}$/.test(task?.due || '') ? task.due : ''
    })).filter((task) => task.text);
  }

  function tasksFromNotes(notes) {
    const tasks = [];
    for (const line of String(notes || '').split('\n')) {
      const match = line.match(/^\s*[-*•]\s+(.+)$/);
      if (!match) continue;
      const raw = match[1].trim();
      const ownerMatch = raw.match(/\(([^)]+)\)\s*$/);
      tasks.push({
        text: ownerMatch ? raw.slice(0, ownerMatch.index).trim() : raw,
        owner: ownerMatch ? ownerMatch[1].trim() : '',
        programmeTaskId: ''
      });
    }
    return tasks.filter((task) => task.text);
  }

  function draftActions() {
    if (!eventDraft) return [];
    if (eventDraft.tasks?.length) return eventDraft.tasks;
    return tasksFromNotes(eventDraft.notes);
  }

  function actionDue(task) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(task?.due || '')) return task.due;
    return inferDeadline(`${task?.text || ''}\n${eventDraft?.summary || ''}\n${eventDraft?.notes || ''}`);
  }

  function refreshNoteActions() {
    if (!eventDraft || eventDraft.actionIndex != null) return;
    const notes = document.getElementById('event-notes');
    if (notes) eventDraft.notes = notes.value;
    const host = document.querySelector('.event-sheet .note-actions');
    if (host) host.outerHTML = noteActionsHtml();
  }

  function interactionLog(contact) {
    const rows = [];
    for (const item of contact.events || []) {
      rows.push({
        kind: 'event',
        id: item.id,
        date: String(item.date || ''),
        title: item.title || channelName(item.channel),
        person: item.person || '—'
      });
    }
    for (const item of contact.interactions || []) {
      if (item.status !== 'written' && item.status !== 'pending') continue;
      rows.push({
        kind: 'note',
        id: item.id,
        date: String(item.date || ''),
        title: noteTitle(item),
        person: memberName(item.lead) || '—',
        pending: item.status === 'pending'
      });
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.title).localeCompare(String(b.title)));
    if (!rows.length) {
      return '<p class="muted-note">No interaction notes yet. Add one, or they appear after a Gmail thread or Granola meeting matches an email on this contact.</p>';
    }
    return `<ul class="event-list">${rows.map((row) => `
      <li>
        <button type="button" class="event-row${row.pending ? ' is-pending' : ''}" data-contacts="${row.kind === 'event' ? 'edit-event' : 'open-note'}" data-id="${esc(row.id)}">
          <span class="event-date">${esc(displayDate(row.date))}</span>
          <span class="event-title">${esc(row.title)}</span>
          <span class="event-person">${esc(row.person)}</span>
        </button>
      </li>
    `).join('')}</ul>`;
  }

  function renderDetail() {
    const contact = findContact(selectedId);
    if (contact && view === 'detail' && contactHidden(contact)) {
      view = 'list';
      selectedId = null;
      contactBackup = null;
      window.KBRoute?.replaceNext();
      return renderList();
    }
    if (!contact) {
      if (holdId && selectedId === holdId) {
        panelEl.innerHTML = '';
        return;
      }
      view = 'list';
      selectedId = null;
      window.KBRoute?.replaceNext();
      return renderList();
    }
    if (view === 'detail' && (!contactBackup || contactBackup.id !== contact.id)) {
      contactBackup = JSON.parse(JSON.stringify(contact));
    }
    const emails = contact.emails.map((email) => `
      <span class="email-chip">
        ${esc(email)}
        <button type="button" data-contacts="remove-email" data-email="${esc(email)}" aria-label="Remove ${esc(email)}">×</button>
      </span>
    `).join('');
    const hasNotes = (contact.interactions || []).some((item) => item.status === 'written' && item.summary);
    const waiting = view === 'proposal';
    const proposal = waiting
      ? (state.proposals || []).find((item) => item.email === (contact.emails || [])[0])
      : null;
    const canSummarize = Boolean(integrations.anthropic?.configured) && hasNotes && !waiting;
    const actions = waiting
      ? `<button type="button" class="text-btn" data-contacts="validate">Validate</button>
         <button type="button" class="danger" data-contacts="dismiss">Dismiss</button>`
      : `<button type="button" class="save-btn" data-contacts="save-contact">Save</button>
         <button type="button" class="danger" data-contacts="delete">Delete</button>`;

    panelEl.innerHTML = `
      ${toolbar(contact.name || 'Contact', actions)}
      <div class="contacts-detail">
        ${waiting ? `<p class="proposal-note">Not in the database yet.${proposal?.subject ? ` ${esc(proposal.subject)}` : ''}</p>` : ''}
        <div class="field-row">
          <div class="field">
            <label for="c-name">Name</label>
            <input id="c-name" data-contact-id="${esc(contact.id)}" value="${esc(contact.name)}" readonly autocomplete="off">
          </div>
          <div class="field">
            <label for="c-category">Category</label>
            <select id="c-category" data-shown="${esc(contact.categories[0] || '')}">${categoryOptions(contact)}</select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label for="c-company">Company</label>
            <input id="c-company" value="${esc(contact.company)}">
          </div>
          <div class="field">
            <label for="c-position">Position</label>
            <input id="c-position" value="${esc(contact.position)}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Email addresses</label>
            <div class="email-row">
              ${emails}
              <input id="c-email-add" type="email" placeholder="Add email" autocomplete="off">
            </div>
          </div>
          <div class="field">
            <label for="c-phone">Phone number</label>
            <input id="c-phone" type="tel" inputmode="tel" autocomplete="tel" value="${esc(contact.phone)}">
          </div>
        </div>
        ${newsletterLine(contact)}
        <div class="field-row">
          <div class="field">
            <label for="c-owner">Main contact person</label>
            <select id="c-owner">${peopleOptions(contact.mainContactPerson)}</select>
          </div>
          <div class="field-row nested">
            <div class="field">
              <label for="c-first">First contact</label>
              <input id="c-first" type="date" value="${esc(contact.firstContactDate)}">
            </div>
            <div class="field">
              <label for="c-last">Last contact</label>
              <input id="c-last" type="date" value="${esc(contact.lastContactDate)}">
            </div>
          </div>
        </div>
        <div class="field summary-field">
          <div class="contacts-section-head">
            <label for="c-summary">Relationship summary</label>
            <button type="button" class="text-btn" data-contacts="summarize"${canSummarize && !busy ? '' : ' disabled'}>${contact.summary ? 'Refresh summary' : 'Generate summary'}</button>
          </div>
          <textarea id="c-summary" class="summary-text" maxlength="8000" placeholder="Write the relationship summary, or generate it from the interaction notes.">${esc(contact.summary)}</textarea>
        </div>
        <section class="contacts-log">
          <div class="contacts-section-head">
            <span>Interaction notes</span>
            <div class="contacts-section-actions">
              <button type="button" class="text-btn" data-contacts="update-notes"${busy ? ' disabled' : ''}>Update notes</button>
              <button type="button" class="text-btn" data-contacts="add-event">+ Add</button>
            </div>
          </div>
          ${interactionLog(contact)}
        </section>
      </div>
      ${sourceBar()}
      ${eventOverlay()}
    `;
    const nameEl = document.getElementById('c-name');
    if (nameEl && !contact.name && !eventDraft && !newsletterOpen && !groupMenu) nameEl.focus();
    if (groupMenu) {
      const filter = document.getElementById('group-filter');
      if (filter && document.activeElement !== filter) filter.focus();
    }
  }

  function eventOverlay() {
    if (!eventDraft) return '';
    const draft = eventDraft;
    const channelOptions = CHANNELS.map(([id, name]) => (
      `<option value="${id}"${id === draft.channel ? ' selected' : ''}>${esc(name)}</option>`
    )).join('');
    return `
      <div class="event-overlay" data-contacts="close-event">
        <div class="event-sheet" role="dialog" aria-modal="true" aria-labelledby="event-title">
          <div class="event-title-row">
            <input id="event-title" class="event-title-input" placeholder="Title" maxlength="160" value="${esc(draft.title)}">
            <button type="button" class="drawer-close" data-contacts="close-event" aria-label="Close">×</button>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="event-channel">Contact</label>
              <select id="event-channel">${channelOptions}</select>
            </div>
            <div class="field">
              <label for="event-date">Date</label>
              <input id="event-date" type="date" value="${esc(draft.date)}">
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="event-person">Person of contact</label>
              <select id="event-person">${peopleOptions(draft.person)}</select>
            </div>
            <div class="field">
              <label for="event-follow">Follow-ups</label>
              <select id="event-follow">
                <option value="open"${draft.followUpDone ? '' : ' selected'}>Not done</option>
                <option value="done"${draft.followUpDone ? ' selected' : ''}>Done</option>
              </select>
            </div>
          </div>
          <div class="field event-notes-field">
            <div class="contacts-section-head">
              <label for="event-notes">Notes</label>
              ${draft.automatic
                ? `<div class="contacts-section-actions"><button type="button" class="text-btn" data-contacts="update-notes"${busy ? ' disabled' : ''}>Update notes</button><button type="button" class="text-btn" data-contacts="rerun-note" data-id="${esc(draft.id)}"${busy ? ' disabled' : ''}>Re-run</button></div>`
                : '<button type="button" class="text-btn" data-contacts="draft-event">Draft from interaction notes</button>'}
            </div>
            <textarea id="event-notes" maxlength="8000" placeholder="Type what happened, or draft it from the interaction notes.">${esc(draft.notes)}</textarea>
            <p class="event-draft-status" id="event-draft-status" role="status">${esc(draft.draftStatus || '')}</p>
          </div>
          ${noteActionsHtml()}
          ${draft.existing ? '<button type="button" class="danger" data-contacts="delete-event">Delete</button>' : ''}
          <button type="button" class="save-btn" data-contacts="save-event">Save</button>
        </div>
        ${noteActionPanel()}
      </div>
    `;
  }

  function noteActionsHtml() {
    const actions = draftActions();
    const rows = actions.length
      ? actions.map((task, index) => {
        const due = actionDue(task);
        const name = task.text === 'New action' ? 'New action' : actionLabel(task.text);
        return `
          <button type="button" class="note-action-row${eventDraft.actionIndex === index ? ' is-open' : ''}" data-contacts="open-note-action" data-index="${index}">
            <span class="note-action-name">${esc(name)}</span>
            <span class="note-action-date">${esc(due ? displayDate(due) : 'No date')}</span>
          </button>
        `;
      }).join('')
      : '<p class="muted-note">No actions in this note.</p>';
    return `
      <div class="note-actions">
        <div class="contacts-section-head">
          <span>Actions</span>
          <button type="button" class="text-btn" data-contacts="add-note-action">+ Add</button>
        </div>
        ${rows}
      </div>
    `;
  }

  function noteActionPanel() {
    if (!eventDraft || eventDraft.actionIndex == null) return '';
    const task = draftActions()[eventDraft.actionIndex];
    if (!task) return '';
    const link = eventDraft.link || {};
    const programme = window.KBProgramme;
    const categories = programme?.categories?.() || [];
    const tasks = link.phaseId ? (programme?.tasksIn?.(link.phaseId) || []) : [];
    const categoryOptions = ['<option value="">Choose a category</option>']
      .concat(categories.map((item) => (
        `<option value="${esc(item.id)}"${item.id === link.phaseId ? ' selected' : ''}>${esc(item.name)}</option>`
      ))).join('');
    const taskOptions = ['<option value="">Choose a task</option>']
      .concat(tasks.map((item) => (
        `<option value="${esc(item.id)}"${item.id === link.taskId ? ' selected' : ''}>${esc(item.title)}</option>`
      ))).join('');
    const ownerMenu = programme?.ownerMenu?.(link.owner || task.owner || eventDraft.person) || '';
    const taskOwnerMenu = programme?.ownerMenu?.(link.taskOwner || link.owner || task.owner || eventDraft.person) || '';
    const taskChosen = Boolean(link.taskId);
    const showNew = !taskChosen && Boolean(String(link.newTitle || '').trim());
    return `
      <aside class="note-action-panel" data-contacts="note-action-panel" aria-label="Add action">
        <div class="drawer-top">
          <input id="note-action-name" class="note-action-title" maxlength="160" aria-label="Action name" value="${esc(link.actionName || '')}">
          <button type="button" class="drawer-close" data-contacts="close-note-action" aria-label="Close">×</button>
        </div>
        <div class="field">
          <label for="note-action-category">Category</label>
          <select id="note-action-category">${categoryOptions}</select>
        </div>
        <div class="field">
          <label for="note-action-task">Task</label>
          <select id="note-action-task"${link.phaseId ? '' : ' disabled'}>${taskOptions}</select>
        </div>
        <div class="field">
          <label for="note-action-owner">Owner</label>
          <select id="note-action-owner">${ownerMenu}</select>
        </div>
        <div class="field">
          <label for="note-action-due">Deadline</label>
          <input id="note-action-due" type="date" value="${esc(link.due || '')}">
        </div>
        <div class="field">
          <label for="note-new-task">New task</label>
          <input id="note-new-task" type="text" maxlength="160" autocomplete="off" placeholder="Type a new task if none of these fit" value="${esc(taskChosen ? '' : (link.newTitle || ''))}"${taskChosen ? ' disabled' : ''}>
        </div>
        <div id="note-new-task-fields"${showNew ? '' : ' hidden'}>
          <div class="field-row">
            <div class="field">
              <label for="note-new-status">Status</label>
              <select id="note-new-status">
                <option value="todo"${link.status === 'doing' || link.status === 'done' ? '' : ' selected'}>To do</option>
                <option value="doing"${link.status === 'doing' ? ' selected' : ''}>In progress</option>
                <option value="done"${link.status === 'done' ? ' selected' : ''}>Done</option>
              </select>
            </div>
            <div class="field">
              <label for="note-new-owner">Owner</label>
              <select id="note-new-owner">${taskOwnerMenu}</select>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="note-new-start">Start</label>
              <input id="note-new-start" type="date" value="${esc(link.start || today())}">
            </div>
            <div class="field">
              <label for="note-new-end">End</label>
              <input id="note-new-end" type="date" value="${esc(link.end || link.due || today())}">
            </div>
          </div>
          <div class="field">
            <label for="note-new-notes">Notes</label>
            <textarea id="note-new-notes" rows="4">${esc(link.taskNotes || '')}</textarea>
          </div>
        </div>
        <div class="field">
          <label for="note-action-summary">Details</label>
          <textarea id="note-action-summary" rows="5">${esc(link.actionNotes || '')}</textarea>
        </div>
        <p class="event-draft-status" id="note-action-status" role="status">${esc(link.message || '')}</p>
        <div class="note-action-footer">
          <button type="button" class="danger" data-contacts="delete-note-action">Delete</button>
          <button type="button" class="save-btn" data-contacts="save-note-action">${task.programmeTaskId ? 'Save' : 'Add action'}</button>
        </div>
      </aside>
    `;
  }

  function readActionLink() {
    if (!eventDraft?.link) return;
    const link = eventDraft.link;
    const name = document.getElementById('note-action-name');
    if (name) link.actionName = name.value;
    const category = document.getElementById('note-action-category');
    if (category) link.phaseId = category.value;
    const chosen = document.getElementById('note-action-task');
    if (chosen) link.taskId = chosen.value;
    const owner = document.getElementById('note-action-owner');
    if (owner) link.owner = owner.value;
    const due = document.getElementById('note-action-due');
    if (due) link.due = due.value;
    const title = document.getElementById('note-new-task');
    if (title) link.newTitle = title.value;
    const status = document.getElementById('note-new-status');
    if (status) link.status = status.value;
    const taskOwner = document.getElementById('note-new-owner');
    if (taskOwner) link.taskOwner = taskOwner.value;
    const start = document.getElementById('note-new-start');
    if (start) link.start = start.value;
    const end = document.getElementById('note-new-end');
    if (end) link.end = end.value;
    const notes = document.getElementById('note-new-notes');
    if (notes) link.taskNotes = notes.value;
    const summary = document.getElementById('note-action-summary');
    if (summary) link.actionNotes = summary.value;
  }

  function storeDraftTasks() {
    const contact = findContact(selectedId);
    const item = (contact?.interactions || []).find((entry) => entry.id === eventDraft?.id);
    if (!item || !Array.isArray(eventDraft?.tasks)) return;
    item.tasks = eventDraft.tasks.map((entry) => {
      const text = String(entry.text || '').trim();
      if (!text) return null;
      const stored = { text, owner: String(entry.owner || '') };
      if (entry.programmeTaskId) stored.programmeTaskId = entry.programmeTaskId;
      if (entry.programmeActionId) stored.programmeActionId = entry.programmeActionId;
      if (/^\d{4}-\d{2}-\d{2}$/.test(entry.due || '')) stored.due = entry.due;
      return stored;
    }).filter(Boolean);
    save();
    refreshContactBackup();
    pingNewActions();
  }

  function openNoteAction(index) {
    const actions = draftActions();
    const task = actions[index];
    if (!eventDraft || !task) return;
    if (!eventDraft.tasks?.length) eventDraft.tasks = actions;
    const saved = task.programmeTaskId
      ? window.KBProgramme?.readAction?.(task.programmeTaskId, task.programmeActionId)
      : null;
    const fresh = task.text === 'New action';
    const due = saved?.due || actionDue(task);
    const owner = saved?.owner || task.owner || eventDraft.person || '';
    eventDraft.actionIndex = index;
    eventDraft._skipLinkRead = true;
    eventDraft.link = {
      actionName: saved?.actionName || (fresh ? 'New action' : actionLabel(task.text)),
      phaseId: saved?.phaseId || '',
      taskId: saved && !saved.missing ? saved.taskId : '',
      owner,
      due,
      newTitle: '',
      status: 'todo',
      taskOwner: owner,
      start: today(),
      end: due || today(),
      taskNotes: '',
      actionNotes: saved ? (saved.notes || '') : (fresh ? '' : task.text),
      programmeActionId: saved?.actionId || task.programmeActionId || '',
      message: ''
    };
    render();
    document.getElementById('note-action-name')?.focus();
  }

  function addBlankAction() {
    if (!eventDraft) return;
    const actions = draftActions();
    eventDraft.tasks = actions;
    eventDraft.tasks.push({
      text: 'New action',
      owner: eventDraft.person || '',
      programmeTaskId: '',
      programmeActionId: '',
      due: ''
    });
    storeDraftTasks();
    openNoteAction(eventDraft.tasks.length - 1);
  }

  function deleteNoteAction() {
    if (!eventDraft || eventDraft.actionIndex == null) return;
    if (!confirm('Delete this action?')) return;
    if (!eventDraft.tasks?.length) eventDraft.tasks = draftActions();
    const task = eventDraft.tasks[eventDraft.actionIndex];
    if (task?.programmeTaskId) {
      window.KBProgramme?.deleteAction?.(task.programmeTaskId, task.programmeActionId, task.text);
    }
    eventDraft.tasks.splice(eventDraft.actionIndex, 1);
    eventDraft.actionIndex = null;
    eventDraft.link = null;
    storeDraftTasks();
    render();
  }

  function saveNoteAction() {
    readActionLink();
    if (!eventDraft?.tasks?.length) eventDraft.tasks = draftActions();
    const task = eventDraft?.tasks?.[eventDraft.actionIndex];
    const link = eventDraft?.link;
    const statusEl = document.getElementById('note-action-status');
    if (!task || !link || !window.KBProgramme?.attachAction) {
      if (statusEl) statusEl.textContent = 'The task list is not available in this view.';
      return;
    }
    const alreadyFiled = Boolean(task.programmeTaskId);
    const result = window.KBProgramme.attachAction({
      phaseId: link.phaseId,
      taskId: link.taskId,
      newTaskTitle: link.newTitle,
      status: link.status,
      start: link.start,
      end: link.end,
      taskNotes: link.taskNotes,
      taskOwner: link.taskOwner,
      actionText: link.actionName,
      due: link.due,
      notes: link.actionNotes,
      owner: link.owner,
      actionId: task.programmeActionId || link.programmeActionId,
      update: alreadyFiled
    });
    if (result?.error) {
      link.message = result.error;
      if (statusEl) statusEl.textContent = result.error;
      return;
    }
    task.programmeTaskId = result.taskId;
    task.programmeActionId = result.actionId;
    task.due = link.due || '';
    if (task.text === 'New action' && link.actionName) task.text = link.actionName;
    link.programmeActionId = result.actionId;
    storeDraftTasks();
    if (alreadyFiled) {
      link.message = '';
      render();
      return;
    }
    eventDraft.actionIndex = null;
    eventDraft.link = null;
    render();
  }

  function openEvent(existing) {
    const contact = findContact(selectedId);
    if (!contact) return;
    eventDraft = existing
      ? { ...existing, existing: true }
      : {
        id: uid(),
        title: '',
        channel: 'gmail',
        date: today(),
        person: contact.mainContactPerson || signedInPerson(),
        followUpDone: false,
        notes: '',
        existing: false
      };
    render();
    document.getElementById('event-title')?.focus();
  }

  function openNote(item) {
    const contact = findContact(selectedId);
    if (!contact || !item) return;
    eventDraft = {
      id: item.id,
      title: noteTitle(item),
      channel: item.source === 'granola' ? 'granola' : 'gmail',
      date: item.date || today(),
      person: memberName(item.lead) || contact.mainContactPerson || signedInPerson(),
      followUpDone: Boolean(item.followUpDone),
      notes: noteText(item),
      summary: String(item.summary || '').trim(),
      tasks: noteTasks(item),
      actionIndex: null,
      link: null,
      existing: true,
      automatic: true
    };
    render();
    document.getElementById('event-title')?.focus();
  }

  function commitAutomatic(contact, titleEl) {
    const item = (contact.interactions || []).find((entry) => entry.id === eventDraft.id);
    const title = titleEl.value.trim();
    const notes = document.getElementById('event-notes').value;
    const date = document.getElementById('event-date').value || eventDraft.date;
    const person = document.getElementById('event-person').value;
    const followUpDone = document.getElementById('event-follow').value === 'done';
    const changed = title !== eventDraft.title
      || notes !== eventDraft.notes
      || date !== eventDraft.date
      || person !== eventDraft.person
      || followUpDone !== Boolean(eventDraft.followUpDone);
    if (item && changed) {
      const derived = noteTitle({ ...item, title: '' });
      item.title = title && title !== derived ? title : '';
      item.date = date;
      item.followUpDone = followUpDone;
      if (notes !== eventDraft.notes) item.summary = notes;
      if (Array.isArray(eventDraft.tasks)) {
        item.tasks = eventDraft.tasks.map((entry) => {
          const text = String(entry.text || '').trim();
          if (!text) return null;
          const stored = { text, owner: String(entry.owner || '') };
          if (entry.programmeTaskId) stored.programmeTaskId = entry.programmeTaskId;
          if (entry.programmeActionId) stored.programmeActionId = entry.programmeActionId;
          if (/^\d{4}-\d{2}-\d{2}$/.test(entry.due || '')) stored.due = entry.due;
          return stored;
        }).filter(Boolean);
      }
      const member = members.find((entry) => entry.name === person);
      if (member) item.lead = member.id;
      save();
      refreshContactBackup();
    }
    eventDraft.title = title;
    eventDraft.date = date;
    eventDraft.person = person;
    eventDraft.followUpDone = followUpDone;
    eventDraft.notes = notes;
    eventDraft.draftStatus = '';
    render();
  }

  function commitEvent() {
    const contact = findContact(selectedId);
    const titleEl = document.getElementById('event-title');
    if (!contact || !eventDraft || !titleEl) {
      eventDraft = null;
      render();
      return;
    }
    if (eventDraft.automatic) return commitAutomatic(contact, titleEl);
    const channel = document.getElementById('event-channel').value;
    const next = normalizeEvent({
      id: eventDraft.id,
      title: titleEl.value.trim() || channelName(channel),
      channel,
      date: document.getElementById('event-date').value || today(),
      person: document.getElementById('event-person').value,
      followUpDone: document.getElementById('event-follow').value === 'done',
      notes: document.getElementById('event-notes').value
    });
    const events = Array.isArray(contact.events) ? contact.events.slice() : [];
    const index = events.findIndex((item) => item.id === next.id);
    if (index >= 0) events[index] = next;
    else events.unshift(next);
    contact.events = events;
    eventDraft = null;
    save();
    refreshContactBackup();
    render();
  }

  function discardEvent() {
    eventDraft = null;
    render();
  }

  function deleteEvent() {
    const contact = findContact(selectedId);
    if (!contact || !eventDraft) return;
    if (eventDraft.automatic) return deleteNote(eventDraft.id);
    contact.events = (contact.events || []).filter((item) => item.id !== eventDraft.id);
    eventDraft = null;
    save();
    refreshContactBackup();
    render();
  }

  function draftEvent() {
    const contact = findContact(selectedId);
    const notesEl = document.getElementById('event-notes');
    const status = document.getElementById('event-draft-status');
    if (!contact || !notesEl) return;
    const chunks = [];
    if (String(contact.summary || '').trim()) chunks.push(contact.summary.trim());
    [...(contact.interactions || [])]
      .filter((item) => item.status === 'written' && item.summary)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .forEach((item) => {
        const tasks = (item.tasks || [])
          .filter((task) => task.text)
          .map((task) => task.text)
          .join('; ');
        const source = item.source === 'granola' ? 'Granola' : 'Gmail';
        chunks.push([
          `${source} · ${displayDate(item.date)}`,
          item.summary,
          tasks
        ].filter(Boolean).join('\n'));
      });
    const draft = chunks.join('\n\n').trim();
    if (!draft) {
      if (status) status.textContent = 'No interaction notes yet. Gmail and Granola add them automatically.';
      return;
    }
    notesEl.value = draft;
    if (status) status.textContent = 'Drafted from interaction notes.';
  }

  function renderSkipped() {
    const rows = skippedRows();
    panelEl.innerHTML = `
      ${toolbar('Skipped notes', '')}
      <div class="contacts-detail">
        <p class="muted-note">These were judged not relevant to YourOrg and will not be checked again. Include one to write the note.</p>
        ${rows.length ? `<ul class="interaction-list">${rows.map(({ contact, item }) => `
          <li class="interaction">
            <div class="interaction-date">${esc(displayDate(item.date))}</div>
            <div class="interaction-source">${sourceIcon(item.source)}</div>
            <div class="interaction-body">
              <div class="interaction-meta">
                ${contactLink(contact)}
                <span>${esc(item.skipReason || 'Skipped')}</span>
              </div>
              <div class="interaction-actions">
                <button type="button" class="text-btn" data-contacts="unskip" data-contact="${esc(contact.id)}" data-id="${esc(item.id)}"${busy ? ' disabled' : ''}>Include</button>
              </div>
            </div>
          </li>
        `).join('')}</ul>` : '<p class="contacts-empty">Nothing has been skipped.</p>'}
      </div>
      ${sourceBar()}
    `;
  }

  function renderSettings() {
    const terms = (state.settings?.relevanceVocabulary || []).join('\n');
    panelEl.innerHTML = `
      ${toolbar('Relevance vocabulary', '<button type="button" class="save-btn" data-contacts="save-settings">Save</button>')}
      <div class="contacts-detail">
        <div class="field">
          <label for="relevance-vocab">Terms</label>
          <textarea id="relevance-vocab" rows="14">${esc(terms)}</textarea>
        </div>
        <p class="muted-note">One term per line. The classifier uses this list plus a short description of YourOrg, and it judges by meaning, so an email in another language about the same topic still counts.</p>
      </div>
      ${sourceBar()}
    `;
  }

  function signedInId() {
    return cookieValue('kb_user').toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '');
  }

  function dottedDate(iso) {
    const day = isoDay(iso);
    if (!day) return '';
    const [y, m, d] = day.split('-');
    return `${d}.${m}.${y}`;
  }

  function newsletterName(status) {
    if (status === 'agreed') return 'Agreed';
    if (status === 'declined') return 'Removed';
    if (status === 'unsubscribed') return 'Unsubscribed';
    return 'Pending';
  }

  function groupChip() {
    if (!groupFilter) return '';
    const group = (state.groups || []).find((item) => item.id === groupFilter);
    if (!group) return '';
    return `<button type="button" class="group-filter" data-contacts="clear-group">Group: ${esc(group.name)} <span aria-hidden="true">×</span><span class="visually-hidden">Clear group filter</span></button>`;
  }

  function newsletterComment(news) {
    const latest = (news.history || []).at(-1);
    const date = dottedDate(latest?.date || news.date);
    let how = '';
    if (latest?.event === 'unsubscribed' || news.status === 'unsubscribed') how = 'Unsubscribed through Mailchimp';
    else if (latest?.event === 'resubscribed') how = 'Resubscribed through Mailchimp';
    else if (latest?.event === 'agreed' && latest.via === 'review') how = 'Added from review';
    else if (latest?.event === 'agreed' || news.status === 'agreed') how = 'Added';
    else if (latest?.event === 'declined' || news.status === 'declined') how = 'Asked to be removed';
    else if (latest?.event === 'removed') how = 'Taken off';
    if (!date && !how) return '';
    return [date, how].filter(Boolean).join(' ');
  }

  function newsletterLine(contact) {
    const news = contact.newsletter || normalizeNewsletter(null);
    const noEmail = !contact.emails.length;
    const unsub = news.status === 'unsubscribed';
    const disabled = noEmail || unsub;
    const choices = unsub
      ? ['unsubscribed']
      : news.status === 'not-asked'
        ? ['not-asked', 'agreed', 'declined']
        : ['agreed', 'declined'];
    const options = choices.map((value) => (
      `<option value="${value}"${news.status === value ? ' selected' : ''}>${esc(newsletterName(value))}</option>`
    )).join('');
    const comment = noEmail ? 'Add an email first' : newsletterComment(news);
    const title = unsub
      ? 'Unsubscribed in Mailchimp. They can only rejoin through the Mailchimp signup form.'
      : '';
    return `
      <div class="field-row">
        <div class="field">
          <label for="c-newsletter">Newsletter</label>
          <div class="news-split">
            <select id="c-newsletter"${disabled ? ' disabled' : ''} title="${esc(title)}">${options}</select>
            <p class="news-comment">${esc(comment)}</p>
          </div>
        </div>
        <div class="field">
          <label>Groups</label>
          <div class="news-value">${groupChips(contact)}</div>
        </div>
      </div>
    `;
  }

  function groupChips(contact) {
    const chips = (contact.groups || []).map((id) => {
      const group = (state.groups || []).find((item) => item.id === id);
      if (!group) return '';
      return `<span class="email-chip">${esc(group.name)}<button type="button" data-contacts="remove-group" data-id="${esc(group.id)}" aria-label="Remove ${esc(group.name)}">×</button></span>`;
    }).join('');
    const menu = groupMenu ? groupMenuHtml(contact) : '';
    return `${chips}<span class="news-control"><button type="button" class="text-btn" data-contacts="group-menu">+ group</button>${menu}</span>`;
  }

  function groupMenuHtml(contact) {
    const query = groupQuery.trim().toLowerCase();
    const mine = new Set(contact.groups || []);
    const available = (state.groups || []).filter((group) => !mine.has(group.id));
    const shown = available.filter((group) => !query || group.name.toLowerCase().includes(query));
    const exact = (state.groups || []).some((group) => group.name.toLowerCase() === query);
    const rows = shown.map((group) => (
      `<button type="button" class="text-btn" data-contacts="add-group" data-id="${esc(group.id)}">${esc(group.name)}</button>`
    )).join('');
    const create = query && !exact
      ? `<button type="button" class="text-btn" data-contacts="create-group">Create "${esc(groupQuery.trim())}"</button>`
      : '';
    return `
      <div class="news-menu" role="menu">
        <input id="group-filter" type="text" placeholder="Group" value="${esc(groupQuery)}" autocomplete="off" aria-label="Filter groups">
        ${rows}${create}
      </div>
    `;
  }

  function csvField(value) {
    const text = String(value ?? '');
    if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
  }

  function groupCsv(contacts, group) {
    const lines = ['Email Address,First Name,Last Name,Tags'];
    for (const contact of contacts || []) {
      if (!group?.id || !(contact?.groups || []).includes(group.id)) continue;
      if (contact?.newsletter?.status !== 'agreed') continue;
      const email = contact.emails?.[0] || '';
      if (!email) continue;
      const parts = String(contact.name || '').trim().split(/\s+/).filter(Boolean);
      const firstName = parts.shift() || '';
      const lastName = parts.join(' ');
      lines.push([email, firstName, lastName, group.name || ''].map(csvField).join(','));
    }
    return `${lines.join('\n')}\n`;
  }

  function ensureGroup(name) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) return null;
    const existing = (state.groups || []).find((group) => group.name.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    state.groups = state.groups || [];
    const used = new Set(state.groups.map((group) => group.id));
    const group = normalizeGroup({
      name: clean,
      createdAt: new Date().toISOString(),
      createdBy: signedInId()
    }, used);
    state.groups.push(group);
    return group;
  }

  function renderGroups() {
    const rows = (state.groups || []).map((group) => {
      const members = state.contacts.filter((contact) => (contact.groups || []).includes(group.id));
      const agreed = members.filter((contact) => contact.newsletter?.status === 'agreed').length;
      const naming = renamingGroup === group.id
        ? `<input value="${esc(group.name)}" data-contacts="group-name" data-id="${esc(group.id)}" aria-label="Name for ${esc(group.name)}">`
        : `<button type="button" class="text-btn group-link" data-contacts="use-group" data-id="${esc(group.id)}">${esc(group.name)}</button>`;
      return `
        <li>
          ${naming}
          <span class="list-count">${members.length}</span>
          <span class="list-count">${agreed} agreed</span>
          <button type="button" class="text-btn" data-contacts="group-rename" data-id="${esc(group.id)}">Rename</button>
          <button type="button" class="text-btn" data-contacts="group-export" data-id="${esc(group.id)}">Export CSV</button>
          <button type="button" class="danger" data-contacts="group-delete" data-id="${esc(group.id)}">Delete</button>
        </li>`;
    }).join('');
    const empty = rows
      ? ''
      : `<p class="muted-note">No groups yet. Create one from a contact.</p>`;
    panelEl.innerHTML = `
      ${toolbar('Groups', '')}
      <div class="contacts-detail">
        ${empty}
        ${rows ? `<ul class="category-edit group-edit">${rows}</ul>` : ''}
      </div>
      ${sourceBar()}
    `;
    if (renamingGroup) document.querySelector('[data-contacts="group-name"]')?.focus();
  }

  function renderCategories() {
    panelEl.innerHTML = `
      ${toolbar('Categories', `<button type="button" class="save-btn" data-contacts="save-categories">Save</button><button type="button" class="text-btn" data-contacts="cat-add">+ Category</button>`)}
      <div class="contacts-detail">
        <p class="muted-note">These tags are stored with the contacts, not hardcoded. Add or rename them here; contacts keep the same ids.</p>
        <ul class="category-edit">
          ${state.categories.filter(categoryVisible).map((cat) => `
            <li>
              <input type="color" value="${esc(cat.color)}" data-contacts="cat-color" data-id="${esc(cat.id)}" aria-label="Colour for ${esc(cat.name)}">
              <input value="${esc(cat.name)}" data-contacts="cat-name" data-id="${esc(cat.id)}">
              <button type="button" class="danger" data-contacts="cat-delete" data-id="${esc(cat.id)}">Delete</button>
            </li>
          `).join('')}
        </ul>
        <button type="button" class="text-btn" data-contacts="cat-add">+ Category</button>
      </div>
    `;
  }

  function writeDetail() {
    const contact = findContact(selectedId);
    if (!contact || (view !== 'detail' && view !== 'proposal')) return;
    const nameEl = document.getElementById('c-name');
    if (!nameEl || nameEl.dataset.contactId !== contact.id) return;
    contact.name = nameEl.value.trim();
    contact.company = document.getElementById('c-company').value.trim();
    contact.position = document.getElementById('c-position').value.trim();
    contact.phone = document.getElementById('c-phone').value.trim().slice(0, 40);
    const categoryEl = document.getElementById('c-category');
    if (categoryEl.dataset.shown !== categoryEl.value) {
      contact.categories = categoryEl.value ? [categoryEl.value] : [];
      categoryEl.dataset.shown = categoryEl.value;
    }
    contact.mainContactPerson = document.getElementById('c-owner').value;
    contact.firstContactDate = document.getElementById('c-first').value;
    contact.lastContactDate = document.getElementById('c-last').value;
    const summaryEl = document.getElementById('c-summary');
    if (summaryEl) contact.summary = summaryEl.value.trim();
    if (contact.lastContactDate && contact.firstContactDate && contact.lastContactDate < contact.firstContactDate) {
      contact.lastContactDate = contact.firstContactDate;
    }
  }

  function refreshContactBackup() {
    const contact = findContact(selectedId);
    if (view === 'detail' && contact) contactBackup = JSON.parse(JSON.stringify(contact));
  }

  function restoreContactDraft() {
    if (!contactBackup) return;
    const index = state.contacts.findIndex((item) => item.id === contactBackup.id);
    if (index >= 0) state.contacts[index] = contactBackup;
    contactBackup = null;
  }

  function saveContactEdits() {
    writeDetail();
    if (view === 'proposal') return;
    contactIsNew = false;
    save();
    refreshContactBackup();
  }

  function scheduleSave() {
    dirty = true;
    cache();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(push, 500);
  }

  function save() {
    scheduleSave();
  }

  async function push() {
    cache();
    if (syncMode !== 'shared') {
      dirty = false;
      return true;
    }
    const payload = { base: serverVersion, state };
    try {
      const response = await fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.status === 401) return false;
      if (response.status === 409) {
        const remote = await response.json();
        serverVersion = remote.updatedAt || 0;
        return push();
      }
      if (!response.ok) throw new Error('save failed');
      const data = await response.json();
      serverVersion = data.updatedAt || 0;
      dirty = false;
      return true;
    } catch {
      statusText = 'Could not save contacts';
      render();
      return false;
    }
  }

  function queueMailchimp(body) {
    if (!integrations.mailchimp?.configured || syncMode !== 'shared') return;
    clearTimeout(saveTimer);
    push().then(async (saved) => {
      if (!saved) return;
      const response = await fetch('/api/mailchimp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error('sync failed');
      if (data.configured === false) return;
      if (data.updatedAt && !dirty) serverVersion = data.updatedAt;
      if (!dirty && Array.isArray(data.results)) {
        for (const item of data.results) {
          const contact = findContact(item.id);
          if (contact && item.newsletter) contact.newsletter = item.newsletter;
        }
        cache();
        render();
      }
    }).catch(() => {
      statusText = 'Saved here. Mailchimp sync failed';
      render();
    });
  }

  function applyRemote(remote) {
    if (!remote?.state) return;
    serverVersion = remote.updatedAt || 0;
    if (remote.integrations) integrations = remote.integrations;
    if (Array.isArray(remote.members)) setMembers(remote.members);
    if (!dirty && !eventDraft && !contactIsNew) {
      const keepId = selectedId;
      state = normalizeState(remote.state);
      cache();
      if (keepId && !findContact(keepId) && view === 'detail') {
        view = 'list';
        selectedId = null;
        holdId = '';
        window.KBRoute?.replaceNext();
      }
      render();
    }
    pingNewActions();
  }

  function pendingActions() {
    const rows = [];
    for (const contact of state.contacts || []) {
      for (const note of contact.interactions || []) {
        if (note.status === 'skipped') continue;
        (note.tasks || []).forEach((task, index) => {
          const text = String(task?.text || '').trim();
          if (!text || task.programmeTaskId || text === 'New action') return;
          rows.push({
            contactId: contact.id,
            contactName: contact.name || 'Untitled',
            noteId: note.id,
            index,
            text,
            owner: String(task.owner || '').trim(),
            due: /^\d{4}-\d{2}-\d{2}$/.test(task.due || '') ? task.due : '',
            date: note.date || ''
          });
        });
      }
    }
    rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || a.contactName.localeCompare(b.contactName));
    return rows;
  }

  function pingNewActions() {
    window.KBDashboard?.refreshNewActions?.();
  }

  function openPending(contactId, noteId, index) {
    const contact = (state.contacts || []).find((item) => item.id === contactId);
    const item = (contact?.interactions || []).find((entry) => entry.id === noteId);
    if (!contact || !item) return false;
    const go = () => {
      if (view === 'proposal') {
        writeDetail();
        stashProposal();
      } else if (view === 'detail') restoreContactDraft();
      selectedId = contact.id;
      contactIsNew = false;
      view = 'detail';
      reviewOpen = false;
      newsletterOpen = false;
      groupMenu = false;
      groupQuery = '';
      openNote(item);
      openNoteAction(Number(index));
    };
    if (contactIsNew && selectedId !== contact.id && holdLeave(go)) return false;
    go();
    return true;
  }

  async function refreshMembers() {
    try {
      const response = await fetch(API, { cache: 'no-store' });
      if (!response.ok) return;
      const remote = await response.json();
      const before = members.map((member) => `${member.id}:${member.name}`).join('|');
      setMembers(remote.members);
      const after = members.map((member) => `${member.id}:${member.name}`).join('|');
      if (before === after || panelEl.contains(document.activeElement)) return;
      render();
    } catch {
      /* keep the list already on screen */
    }
  }

  async function pull() {
    try {
      const response = await fetch(API, { cache: 'no-store' });
      if (response.status === 501) {
        syncMode = 'local';
        state = loadLocal();
        return;
      }
      if (response.status === 401) return;
      if (!response.ok) throw new Error('load failed');
      const remote = await response.json();
      syncMode = 'shared';
      if (remote.integrations) integrations = remote.integrations;
      if (!remote.state) {
        dirty = true;
        await push();
        return;
      }
      applyRemote(remote);
    } catch {
      syncMode = 'local';
      state = loadLocal();
    } finally {
      pingNewActions();
    }
  }

  function proposalContext(proposal) {
    if (proposal.summary) return proposal.summary;
    const who = proposal.name || 'They';
    const topic = String(proposal.subject || '').replace(/^(re|fw|fwd)\s*:\s*/i, '').trim();
    const first = topic
      ? `${who} wrote about ${topic.replace(/\.+$/, '')}.`
      : `${who} wrote to YourOrg.`;
    const detail = String(proposal.snippet || '').replace(/\s+/g, ' ').trim();
    if (!detail) return first;
    return `${first} ${/[.!?]$/.test(detail) ? detail : `${detail}.`}`;
  }

  function stashProposal() {
    const email = proposalDraft?.emails?.[0];
    if (email) proposalDrafts.set(email, proposalDraft);
    proposalDraft = null;
  }

  function openProposal(email) {
    const proposal = (state.proposals || []).find((item) => item.email === email);
    if (!proposal || !canReview()) return;
    reviewOpen = false;
    const ownerName = members.find((member) => member.id === proposal.owner)?.name || signedInPerson();
    proposalDraft = proposalDrafts.get(email) || normalizeContact({
      id: `proposal:${email}`,
      name: proposal.name,
      emails: [email],
      firstContactDate: proposal.date,
      lastContactDate: proposal.date,
      mainContactPerson: ownerName,
      summary: proposalContext(proposal),
      newsletter: applyNewsletterChoice(null, 'agreed', {
        date: today(),
        by: proposal.owner || signedInId(),
        via: 'review'
      })
    });
    selectedId = proposalDraft.id;
    view = 'proposal';
    newsletterOpen = false;
    groupMenu = false;
    groupQuery = '';
    render();
  }

  function validateProposal() {
    if (view !== 'proposal' || !proposalDraft || !canReview()) return;
    writeDetail();
    proposalDraft.newsletter = applyNewsletterChoice(
      { status: 'not-asked', history: [] },
      'agreed',
      { date: today(), by: signedInId(), via: 'review' }
    );
    const email = proposalDraft.emails?.[0] || '';
    const contact = normalizeContact({ ...proposalDraft, id: uid() });
    if (email && !contact.emails.includes(email)) contact.emails.unshift(email);
    state.contacts.unshift(contact);
    state.proposals = (state.proposals || []).filter((item) => item.email !== email);
    proposalDrafts.delete(email);
    proposalDraft = null;
    selectedId = contact.id;
    view = 'detail';
    save();
    render();
    queueMailchimp({ action: 'sync-contact', id: contact.id });
  }

  function dismissProposal() {
    if (view !== 'proposal' || !proposalDraft || !canReview()) return;
    const email = proposalDraft.emails?.[0] || '';
    if (email) {
      state.dismissedInbound = normalizeDismissed([...(state.dismissedInbound || []), email]);
      state.proposals = (state.proposals || []).filter((item) => item.email !== email);
      proposalDrafts.delete(email);
    }
    proposalDraft = null;
    selectedId = null;
    view = 'list';
    save();
    render();
  }

  function addContact(draft) {
    const contact = normalizeContact({
      id: uid(),
      name: draft?.name || '',
      emails: draft?.email ? [draft.email] : [],
      mainContactPerson: signedInPerson(),
      firstContactDate: today(),
      lastContactDate: today(),
      categories: draft?.categories || []
    });
    state.contacts.unshift(contact);
    selectedId = contact.id;
    view = 'detail';
    contactIsNew = true;
    contactBackup = null;
    render();
  }

  function deleteContact() {
    if (!confirm('Delete this contact?')) return;
    contactIsNew = false;
    contactBackup = null;
    state.contacts = state.contacts.filter((item) => item.id !== selectedId);
    selectedId = null;
    view = 'list';
    save();
    render();
  }

  function addEmail() {
    const contact = findContact(selectedId);
    const input = document.getElementById('c-email-add');
    if (!contact || !input) return;
    const email = input.value.trim().toLowerCase();
    if (!email || !email.includes('@')) return;
    if (!contact.emails.includes(email)) contact.emails.push(email);
    input.value = '';
    render();
  }

  async function summarize() {
    const id = selectedId;
    if (!id || busy) return;
    saveContactEdits();
    busy = true;
    statusText = 'Generating summary…';
    render();
    try {
      const response = await fetch('/api/contacts-summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: id })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        statusText = data.error || 'Could not generate a summary';
        return;
      }
      dirty = false;
      applyRemote(data);
      selectedId = id;
      view = 'detail';
      contactBackup = null;
      document.getElementById('c-name')?.remove();
      statusText = data.result?.errors?.[0]?.error || 'Summary cached';
    } catch {
      statusText = 'Could not reach the server';
    } finally {
      busy = false;
      render();
    }
  }

  function syncIfAgreed(contact) {
    if (contact?.newsletter?.status === 'agreed') queueMailchimp({ action: 'sync-contact', id: contact.id });
  }

  function setNewsletter(choice) {
    const contact = findContact(selectedId);
    if (!contact || !contact.emails.length || contact.newsletter?.status === 'unsubscribed') return;
    if (choice === 'not-asked' && contact.newsletter?.status && contact.newsletter.status !== 'not-asked') return;
    contact.newsletter = applyNewsletterChoice(contact.newsletter, choice, {
      date: today(),
      by: signedInId()
    });
    newsletterOpen = false;
    save();
    refreshContactBackup();
    render();
    if (view !== 'proposal') queueMailchimp({ action: 'sync-contact', id: contact.id });
  }

  function addContactToGroup(group) {
    const contact = findContact(selectedId);
    if (!contact || !group) return;
    contact.groups = contact.groups || [];
    if (!contact.groups.includes(group.id)) contact.groups.push(group.id);
    groupMenu = false;
    groupQuery = '';
    save();
    refreshContactBackup();
    render();
    if (view !== 'proposal') syncIfAgreed(contact);
  }

  function exportGroup(id) {
    const group = (state.groups || []).find((item) => item.id === id);
    if (!group) return;
    const blob = new Blob([groupCsv(state.contacts, group)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${group.id}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function deleteGroup(id) {
    const group = (state.groups || []).find((item) => item.id === id);
    if (!group || !confirm(`Delete ${group.name}? It will be removed from every contact.`)) return;
    const name = group.name;
    state.groups = state.groups.filter((item) => item.id !== id);
    for (const contact of state.contacts) {
      contact.groups = (contact.groups || []).filter((item) => item !== id);
    }
    if (groupFilter === id) groupFilter = '';
    save();
    render();
    queueMailchimp({ action: 'delete-group', name });
  }

  function finishGroupRename(id) {
    const group = (state.groups || []).find((item) => item.id === id);
    const input = document.querySelector(`[data-contacts="group-name"][data-id="${CSS.escape(id)}"]`);
    if (!group) return;
    const next = (input ? input.value : group.name).trim().slice(0, 80) || group.name;
    const old = renameBase.get(id) || group.name;
    group.name = next;
    renamingGroup = '';
    renameBase.delete(id);
    save();
    render();
    if (old !== next) queueMailchimp({ action: 'rename-group', oldName: old, name: next });
  }

  function writeCategories() {
    document.querySelectorAll('[data-contacts="cat-name"]').forEach((input) => {
      const cat = findCategory(input.dataset.id);
      if (cat) cat.name = input.value;
    });
    document.querySelectorAll('[data-contacts="cat-color"]').forEach((input) => {
      const cat = findCategory(input.dataset.id);
      if (cat) cat.color = input.value;
    });
  }

  function saveCategories() {
    writeCategories();
    save();
  }

  function saveSettings() {
    const vocab = document.getElementById('relevance-vocab');
    if (!vocab) return;
    state.settings = state.settings || {};
    state.settings.relevanceVocabulary = vocab.value.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 80);
    save();
  }

  function onPanelClick(event) {
    const link = event.target.closest('a[href]');
    if (link && !isPlainClick(event)) return;
    const btn = event.target.closest('[data-contacts]');
    if (!btn) return;
    if (link) event.preventDefault();
    holdId = '';
    const action = btn.dataset.contacts;
    if (action === 'close') return;
    if (action === 'back') {
      const go = () => {
        if (view === 'proposal') {
          writeDetail();
          stashProposal();
        } else restoreContactDraft();
        view = 'list';
        selectedId = null;
        newsletterOpen = false;
        groupMenu = false;
        groupQuery = '';
        render();
      };
      if (holdLeave(go)) return;
      return go();
    }
    if (action === 'add') {
      if (holdLeave(() => addContact())) return;
      return addContact();
    }
    if (action === 'categories') {
      view = 'categories';
      return render();
    }
    if (action === 'groups') {
      view = 'groups';
      renamingGroup = '';
      return render();
    }
    if (action === 'review') {
      reviewOpen = !reviewOpen;
      return render();
    }
    if (action === 'close-review-window') {
      reviewOpen = false;
      return render();
    }
    if (action === 'close-review') {
      if (event.target.closest('.review-window')) return;
      reviewOpen = false;
      return render();
    }
    if (action === 'open-proposal') return openProposal(btn.dataset.email);
    if (action === 'validate') return validateProposal();
    if (action === 'dismiss') return dismissProposal();
    if (action === 'open') {
      const go = () => {
        restoreContactDraft();
        contactIsNew = false;
        selectedId = btn.dataset.id;
        view = 'detail';
        newsletterOpen = false;
        groupMenu = false;
        groupQuery = '';
        render();
      };
      if (holdLeave(go)) return;
      return go();
    }
    if (action === 'sort') {
      const key = btn.dataset.key;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else {
        sortKey = key;
        sortDir = key === 'first' || key === 'last' ? 'desc' : 'asc';
      }
      return render();
    }
    if (action === 'filter-person' || action === 'filter-category') return;
    if (action === 'clear-group') {
      groupFilter = '';
      return render();
    }
    if (action === 'newsletter-set') return setNewsletter(btn.dataset.value);
    if (action === 'group-menu') {
      groupMenu = !groupMenu;
      groupQuery = '';
      newsletterOpen = false;
      return render();
    }
    if (action === 'add-group') {
      const group = (state.groups || []).find((item) => item.id === btn.dataset.id);
      return addContactToGroup(group);
    }
    if (action === 'create-group') return addContactToGroup(ensureGroup(groupQuery));
    if (action === 'remove-group') {
      const contact = findContact(selectedId);
      if (!contact) return;
      contact.groups = (contact.groups || []).filter((id) => id !== btn.dataset.id);
      save();
      refreshContactBackup();
      render();
      if (view !== 'proposal') return syncIfAgreed(contact);
      return;
    }
    if (action === 'use-group') {
      groupFilter = btn.dataset.id;
      view = 'list';
      return render();
    }
    if (action === 'group-rename') {
      renamingGroup = btn.dataset.id;
      const group = (state.groups || []).find((item) => item.id === renamingGroup);
      if (group) renameBase.set(group.id, group.name);
      return render();
    }
    if (action === 'group-export') return exportGroup(btn.dataset.id);
    if (action === 'group-delete') return deleteGroup(btn.dataset.id);
    if (action === 'toggle-cat') {
      const contact = findContact(selectedId);
      if (!contact) return;
      const id = btn.dataset.id;
      contact.categories = contact.categories.includes(id)
        ? contact.categories.filter((item) => item !== id)
        : contact.categories.concat(id);
      save();
      refreshContactBackup();
      return render();
    }
    if (action === 'remove-email') {
      const contact = findContact(selectedId);
      if (!contact) return;
      contact.emails = contact.emails.filter((email) => email !== btn.dataset.email);
      save();
      refreshContactBackup();
      return render();
    }
    if (action === 'delete') {
      if (view === 'proposal') return;
      return deleteContact();
    }
    if (action === 'add-event') return openEvent(null);
    if (action === 'edit-event') {
      const contact = findContact(selectedId);
      const item = (contact?.events || []).find((entry) => entry.id === btn.dataset.id);
      if (item) openEvent(item);
      return;
    }
    if (action === 'open-note') {
      const contact = findContact(selectedId);
      const item = (contact?.interactions || []).find((entry) => entry.id === btn.dataset.id);
      if (item) openNote(item);
      return;
    }
    if (action === 'save-contact') return saveContactEdits();
    if (action === 'save-event') return commitEvent();
    if (action === 'save-settings') return saveSettings();
    if (action === 'save-categories') return saveCategories();
    if (action === 'close-event') {
      if (btn.classList.contains('event-overlay') && event.target !== btn) return;
      return discardEvent();
    }
    if (action === 'delete-event') return deleteEvent();
    if (action === 'draft-event') return draftEvent();
    if (action === 'summarize') return summarize();
    if (action === 'update-notes') return updateNotes();
    if (action === 'rerun-note') return rerunNote(btn.dataset.id);
    if (action === 'add-note-action') return addBlankAction();
    if (action === 'open-note-action') return openNoteAction(Number(btn.dataset.index));
    if (action === 'delete-note-action') return deleteNoteAction();
    if (action === 'close-note-action') {
      if (eventDraft) {
        eventDraft.actionIndex = null;
        eventDraft.link = null;
      }
      return render();
    }
    if (action === 'note-action-panel') return;
    if (action === 'save-note-action') return saveNoteAction();
    if (action === 'delete-note') return deleteNote(btn.dataset.id);
    if (action === 'unskip') return unskip(btn.dataset.contact, btn.dataset.id);
    if (action === 'import-suggestion') {
      addContact({ name: btn.dataset.name, email: btn.dataset.email });
      state.suggestions = state.suggestions.filter((item) => item.email !== btn.dataset.email);
      save();
      return;
    }
    if (action === 'cat-add') {
      writeCategories();
      const used = new Set(state.categories.map((item) => item.id));
      state.categories.push(normalizeCategory({ name: 'New category', color: '#9a9a9a' }, used));
      save();
      return render();
    }
    if (action === 'cat-delete') {
      const id = btn.dataset.id;
      if (!confirm('Delete this category? It will be removed from every contact.')) return;
      writeCategories();
      state.categories = state.categories.filter((item) => item.id !== id);
      state.contacts.forEach((contact) => {
        contact.categories = contact.categories.filter((item) => item !== id);
      });
      save();
      return render();
    }
  }

  function deleteNote(id) {
    const contact = findContact(selectedId);
    const item = (contact?.interactions || []).find((entry) => entry.id === id);
    if (!contact || !item) return;
    if (!confirm('Delete this note? It will not be added again.')) return;
    if (item.sourceKey && !(contact.dismissedKeys || []).includes(item.sourceKey)) {
      contact.dismissedKeys = [...(contact.dismissedKeys || []), item.sourceKey];
    }
    contact.interactions = (contact.interactions || []).filter((entry) => entry.id !== id);
    if (eventDraft?.id === id) eventDraft = null;
    save();
    refreshContactBackup();
    render();
  }

  function showNoteStatus(message) {
    if (eventDraft) eventDraft.draftStatus = message;
    else statusText = message;
  }

  function applyNoteResponse(data) {
    dirty = false;
    serverVersion = data.updatedAt || serverVersion;
    if (data.integrations) integrations = data.integrations;
    if (Array.isArray(data.members)) setMembers(data.members);
    if (data.state) {
      state = normalizeState(data.state);
      cache();
    }
    contactBackup = null;
    if (!eventDraft) return;
    const item = (findContact(selectedId)?.interactions || []).find((entry) => entry.id === eventDraft.id);
    if (!item) return;
    eventDraft.title = noteTitle(item);
    eventDraft.notes = noteText(item);
    eventDraft.summary = String(item.summary || '').trim();
    eventDraft.tasks = noteTasks(item);
  }

  async function postCatchup(body) {
    const response = await fetch('/api/contacts-catchup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not update the notes');
    return data;
  }

  async function updateNotes() {
    if (busy) return;
    if (view === 'detail') saveContactEdits();
    clearTimeout(saveTimer);
    await push();
    clearTimeout(saveTimer);
    busy = true;
    showNoteStatus('Looking for new emails and meetings…');
    render();
    const skipIds = [];
    let wrote = 0;
    let failed = 0;
    let lastError = '';
    try {
      applyNoteResponse(await postCatchup({ step: 'find' }));
      for (let guard = 0; guard < 120; guard += 1) {
        const result = await postCatchup({ step: 'write', skipIds });
        applyNoteResponse(result);
        const remaining = Number(result.remaining) || 0;
        if (result.written) {
          wrote += 1;
          showNoteStatus(remaining ? `Writing notes… ${remaining} left` : (wrote === 1 ? '1 note updated' : `${wrote} notes updated`));
          render();
          if (!remaining) break;
          continue;
        }
        if (result.error) lastError = result.error;
        if (!result.id) break;
        failed += 1;
        skipIds.push(result.id);
        if (!remaining) break;
      }
      const detail = lastError ? ` · ${lastError}` : '';
      if (wrote && !failed) showNoteStatus(wrote === 1 ? '1 note updated' : `${wrote} notes updated`);
      else if (wrote && failed) showNoteStatus(`${wrote} notes updated · ${failed} still waiting${detail}`);
      else if (!failed) showNoteStatus('No new notes');
      else showNoteStatus((failed === 1 ? '1 note could not be written' : `${failed} notes could not be written`) + detail);
    } catch (error) {
      showNoteStatus(error?.message || 'Could not reach the server');
    } finally {
      clearTimeout(saveTimer);
      busy = false;
      render();
    }
  }

  async function rerunNote(id) {
    const contactId = selectedId;
    if (!contactId || !id || busy) return;
    const keepOpen = Boolean(eventDraft && eventDraft.id === id);
    saveContactEdits();
    clearTimeout(saveTimer);
    await push();
    clearTimeout(saveTimer);
    busy = true;
    showNoteStatus('Rewriting note…');
    render();
    try {
      const response = await fetch('/api/contacts-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId, interactionId: id })
      });
      const data = await response.json().catch(() => ({}));
      clearTimeout(saveTimer);
      if (!response.ok) {
        showNoteStatus(data.error || 'Could not rewrite the note');
        return;
      }
      dirty = false;
      serverVersion = data.updatedAt || serverVersion;
      if (data.integrations) integrations = data.integrations;
      if (Array.isArray(data.members)) setMembers(data.members);
      if (data.state) {
        state = normalizeState(data.state);
        cache();
      }
      selectedId = contactId;
      view = 'detail';
      contactBackup = null;
      const item = (findContact(contactId)?.interactions || []).find((entry) => entry.id === id);
      if (keepOpen && eventDraft && item) {
        eventDraft.notes = noteText(item);
        eventDraft.summary = String(item.summary || '').trim();
        eventDraft.draftStatus = 'Note updated';
      } else {
        statusText = 'Note updated';
      }
    } catch {
      showNoteStatus('Could not reach the server');
    } finally {
      clearTimeout(saveTimer);
      busy = false;
      render();
    }
  }

  async function unskip(contactId, interactionId) {
    const contact = findContact(contactId);
    const item = (contact?.interactions || []).find((entry) => entry.id === interactionId);
    if (!contact || !item || busy) return;
    item.status = 'pending';
    item.skipReason = '';
    item.sourceHash = '';
    item.coveredAt = '';
    selectedId = contactId;
    view = 'detail';
    save();
    await rerunNote(interactionId);
  }

  function onPanelInput(event) {
    if (event.target.dataset.contacts === 'filter-person') {
      personFilter = event.target.value;
      render();
      document.querySelector('[data-contacts="filter-person"]')?.focus();
      return;
    }
    if (event.target.dataset.contacts === 'filter-category') {
      categoryFilter = event.target.value;
      render();
      document.querySelector('[data-contacts="filter-category"]')?.focus();
      return;
    }
    if (event.target.id === 'note-action-task') {
      readActionLink();
      if (eventDraft?.link?.taskId) {
        eventDraft.link.newTitle = '';
        const title = document.getElementById('note-new-task');
        if (title) title.value = '';
      }
      if (eventDraft) eventDraft._skipLinkRead = true;
      render();
      document.getElementById('note-action-task')?.focus();
      return;
    }
    if (event.target.id === 'note-action-category') {
      readActionLink();
      if (eventDraft?.link) eventDraft.link.taskId = '';
      render();
      document.getElementById('note-action-category')?.focus();
      return;
    }
    if (event.target.id === 'event-notes') {
      refreshNoteActions();
      return;
    }
    if (event.target.id === 'note-new-task') {
      const extra = document.getElementById('note-new-task-fields');
      if (extra) extra.hidden = !event.target.value.trim();
    }
    if (event.target.id === 'group-filter') {
      groupQuery = event.target.value;
      refreshGroupMenu(event.target);
      return;
    }
    if (event.target.id === 'c-newsletter') return setNewsletter(event.target.value);
    if (event.target.closest('.event-overlay')) return;
    if (view === 'settings') {
      if (event.target.id !== 'relevance-vocab') return;
      return;
    }
    if (view === 'detail' || view === 'proposal') {
      if (event.target.id === 'c-email-add') return;
      if (event.target.id === 'c-name') {
        const title = document.getElementById('contacts-title');
        if (title) title.textContent = event.target.value.trim() || 'Contact';
      }
      return;
    }
    if (view === 'groups' && event.target.dataset.contacts === 'group-name') {
      const group = (state.groups || []).find((item) => item.id === event.target.dataset.id);
      if (!group) return;
      if (!renameBase.has(group.id)) renameBase.set(group.id, group.name);
      group.name = event.target.value;
      return;
    }
    if (view !== 'categories') return;
  }

  function refreshGroupMenu(input) {
    const contact = findContact(selectedId);
    const menu = input?.closest('.news-menu');
    if (!contact || !menu) return;
    menu.querySelectorAll('button').forEach((btn) => btn.remove());
    const query = groupQuery.trim().toLowerCase();
    const mine = new Set(contact.groups || []);
    const shown = (state.groups || []).filter((group) => !mine.has(group.id) && (!query || group.name.toLowerCase().includes(query)));
    const exact = (state.groups || []).some((group) => group.name.toLowerCase() === query);
    for (const group of shown) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'text-btn';
      btn.dataset.contacts = 'add-group';
      btn.dataset.id = group.id;
      btn.textContent = group.name;
      menu.appendChild(btn);
    }
    if (query && !exact) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'text-btn';
      btn.dataset.contacts = 'create-group';
      btn.textContent = `Create "${groupQuery.trim()}"`;
      menu.appendChild(btn);
    }
  }

  function confirmGroupQuery() {
    const contact = findContact(selectedId);
    if (!contact) return;
    const query = groupQuery.trim().toLowerCase();
    const mine = new Set(contact.groups || []);
    const match = (state.groups || []).find((group) => group.name.toLowerCase() === query && !mine.has(group.id))
      || (state.groups || []).find((group) => !mine.has(group.id) && group.name.toLowerCase().includes(query));
    if (match && query) return addContactToGroup(match);
    if (query && !(state.groups || []).some((group) => group.name.toLowerCase() === query)) {
      return addContactToGroup(ensureGroup(groupQuery));
    }
    groupMenu = false;
    groupQuery = '';
    render();
  }

  function onPanelKeydown(event) {
    if (event.target.id === 'c-email-add' && event.key === 'Enter') {
      event.preventDefault();
      addEmail();
    }
    if (event.target.id === 'group-filter' && event.key === 'Enter') {
      event.preventDefault();
      confirmGroupQuery();
    }
    if (event.target.id === 'group-filter' && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      groupMenu = false;
      groupQuery = '';
      render();
    }
    if (event.target.dataset.contacts === 'group-name' && event.key === 'Enter') {
      event.preventDefault();
      finishGroupRename(event.target.dataset.id);
    }
  }

  panelEl.addEventListener('focusin', (event) => {
    if (event.target.id === 'c-name') event.target.readOnly = false;
  });
  panelEl.addEventListener('click', onPanelClick);
  panelEl.addEventListener('input', onPanelInput);
  panelEl.addEventListener('change', onPanelInput);
  panelEl.addEventListener('keydown', onPanelKeydown);
  panelEl.addEventListener('blur', (event) => {
    if (event.target.id === 'c-email-add') addEmail();
    if (event.target.dataset.contacts === 'group-name') {
      const id = event.target.dataset.id;
      setTimeout(() => {
        if (renamingGroup !== id) return;
        const group = (state.groups || []).find((item) => item.id === id);
        if (group && renameBase.has(id)) group.name = renameBase.get(id);
        renamingGroup = '';
        renameBase.delete(id);
        render();
      }, 0);
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !eventDraft || rootEl.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    discardEvent();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || rootEl.hidden || eventDraft) return;
    if (contactLeaveOpen) return;
    if (view === 'detail' && (newsletterOpen || groupMenu)) {
      newsletterOpen = false;
      groupMenu = false;
      groupQuery = '';
      event.stopPropagation();
      render();
      return;
    }
    if (view === 'list') {
      if (!reviewOpen) return;
      reviewOpen = false;
      event.stopPropagation();
      render();
      return;
    }
    if (!document.getElementById('leave-task-layer')?.hidden) return;
    event.stopPropagation();
    const go = () => {
      if (view === 'proposal') {
        writeDetail();
        stashProposal();
      } else restoreContactDraft();
      newsletterOpen = false;
      groupMenu = false;
      groupQuery = '';
      view = 'list';
      selectedId = null;
      render();
    };
    if (holdLeave(go)) return;
    go();
  }, true);

  window.KBContacts = {
    show() {
      if (rootEl.hidden) return;
      render();
      refreshMembers();
    },
    openList() {
      const go = () => {
        if (view === 'proposal') {
          writeDetail();
          stashProposal();
        } else if (view === 'detail') restoreContactDraft();
        view = 'list';
        selectedId = null;
        reviewOpen = false;
        newsletterOpen = false;
        groupMenu = false;
        groupQuery = '';
        holdId = '';
      };
      if (holdLeave(go)) return;
      go();
    },
    holdLeave,
    route: contactRoute,
    applyRoute,
    pendingActions,
    openPending
  };

  const opening = window.KBRoute?.read?.() || { view: 'dashboard', screen: '', id: '' };
  if (opening.view === 'contacts') {
    applyRoute(opening);
    if (opening.screen === 'detail' && opening.id) holdId = opening.id;
  }

  state = loadLocal();
  pingNewActions();
  pull();
  if (!rootEl.hidden) render();
  clearArrivalQuery();
})();
