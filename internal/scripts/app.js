(function () {
  const STORAGE_KEY = 'yourorg-internal-v2';
  const VERSION_KEY = 'yourorg-internal-version';
  const PREFS_KEY = 'yourorg-internal-prefs-v1';
  const PROFILE_KEY = 'yourorg-profile-v1';
  const PROFILE_FIELDS = ['name', 'email', 'role', 'team'];
  const TEAM = ['Alex', 'Sam', 'Jordan', 'Taylor', 'Robin', 'Casey', 'Morgan'];
  const MANAGERS = ['Alex', 'Sam'];
  const COORDINATORS = {
    morgan: {
      owners: ['Morgan', 'Robin', 'Casey'],
      categories: [
        'Logistics',
        'Exhibition & Residencies',
        'Archive & Documentation',
        'PR / Media',
        'SMM / Content',
        'SMM / Website',
        'Programme Coordination'
      ]
    }
  };
  const PEERS = {
    robin: ['Casey'],
    casey: ['Robin']
  };
  const STATUS_LABEL = { todo: 'To do', doing: 'In progress', done: 'Done' };
  const YEARS = [2026, 2027, 2028, 2029, 2030];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const LINK_ONLY = [{ id: 'public', name: 'Public Program' }];
  const BACKLOG = { id: '', name: 'Unassigned' };
  const GENERAL_CHOICE = 'general';
  const PEOPLE = {
    alex: {
      name: 'Alex Admin',
      firstName: 'Alex',
      email: 'alex@example.org',
      role: 'Co-Founder and Executive Director',
      ownerKey: 'Alex',
      team: ''
    },
    sam: {
      name: 'Sam Manager',
      firstName: 'Sam',
      email: 'sam@example.org',
      role: 'Co-Founder and Artistic Director',
      ownerKey: 'Sam',
      team: ''
    },
    jordan: {
      name: 'Jordan Lee',
      firstName: 'Jordan',
      email: 'jordan@example.org',
      role: 'Collaborator',
      ownerKey: 'Jordan',
      team: ''
    },
    taylor: {
      name: 'Taylor Kim',
      firstName: 'Taylor',
      email: 'taylor@example.org',
      role: 'Collaborator',
      ownerKey: 'Taylor',
      team: ''
    },
    robin: {
      name: 'Robin Park',
      firstName: 'Robin',
      email: 'robin@example.org',
      role: 'Collaborator',
      ownerKey: 'Robin',
      team: ''
    },
    casey: {
      name: 'Casey Lim',
      firstName: 'Casey',
      email: 'casey@example.org',
      role: 'Collaborator',
      ownerKey: 'Casey',
      team: ''
    },
    morgan: {
      name: 'Morgan Reed',
      firstName: 'Morgan',
      email: 'morgan@example.org',
      role: 'Programme Coordinator',
      ownerKey: 'Morgan',
      team: ''
    }
  };

  const ganttEl = document.getElementById('gantt');
  const dashboardEl = document.getElementById('dashboard');
  const ganttBarEl = document.getElementById('gantt-bar');
  const contactsRootEl = document.getElementById('contacts-root');
  const contactsOpenBtn = document.getElementById('contacts-open');
  const drawerEl = document.getElementById('drawer');
  const backdropEl = document.getElementById('backdrop');
  const leaveTaskLayer = document.getElementById('leave-task-layer');
  const importFile = document.getElementById('import-file');
  const profileMenuEl = document.getElementById('profile-menu');
  const ganttMenuEl = document.getElementById('gantt-menu');
  const searchEl = document.getElementById('search');

  /* Browsers offer previous entries while typing. Nothing in the workspace should. */
  function quietField(el) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['password', 'checkbox', 'radio', 'file', 'color', 'hidden', 'date', 'button', 'submit'].includes(type)) return;
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'none');
  }
  function quietTree(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches('input, textarea')) quietField(node);
    node.querySelectorAll('input, textarea').forEach(quietField);
  }
  quietTree(document.body);
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) quietTree(node);
    }
  }).observe(document.body, { childList: true, subtree: true });

  let state = load();
  let prefs = loadPrefs();
  let profileEdits = loadProfileEdits();
  let profileSaveTimer = null;
  const openingRoute = readLocationRoute();
  if (prefs.view !== openingRoute.view) {
    prefs.view = openingRoute.view;
    savePrefs();
  }
  let selectedId = null;
  let drawerKind = null;
  let taskBackup = null;
  let taskIsNew = false;
  let leavePromptOpen = false;
  let afterLeave = null;
  let leaveChoice = null;
  let leaveCancel = null;
  let drawerId = null;
  let openActions = new Set();
  let editingAction = null;
  let agendaLeaving = 0;
  let drag = null;
  let suppressClick = false;
  let pxPerDay = 6;
  let centreOnToday = true;
  let placeLabel = '';
  let calMonth = new Date();
  calMonth.setDate(1);
  let calSelected = null;
  let dayPanelOpen = false;
  let newActionsOpen = false;
  let newActionDraft = null;
  let newActionBackup = null;
  let dashOpen = new Set();
  let ganttOpen = new Set();
  let taskClick = { id: '', at: 0 };
  let agendaDay = null;

  /* Shared-state sync. syncMode flips to 'shared' once /api/state answers. */
  const SYNC_URL = '/api/state';
  const POLL_MS = 15000;
  let syncMode = 'local';
  let serverVersion = Number(localStorage.getItem(VERSION_KEY)) || 0;
  let dirtyTasks = new Set();
  let dirtyAll = false;
  let pushTimer = null;
  let pushing = false;

  /* ── data ── */

  function uid() {
    return crypto.randomUUID();
  }

  function programmeState() {
    const src = window.KB_PROGRAMME;
    if (!src) return { workflowName: 'YourOrg 2026–2027', phases: [], tasks: [] };
    return {
      workflowName: String(src.workflowName || 'YourOrg 2026–2027'),
      phases: (src.phases || []).map(normalisePhase),
      tasks: (src.tasks || []).map(normaliseTask)
    };
  }

  function normaliseState(data) {
    return {
      workflowName: String(data.workflowName || 'YourOrg 2026–2027'),
      phases: data.phases.map(normalisePhase),
      tasks: data.tasks.map(normaliseTask)
    };
  }

  const EMAIL_DOMAIN = 'example.org';
  const SESSION_REFRESH_MS = 5 * 60 * 1000;

  function cookieValue(name) {
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  function signedInName() {
    const raw = cookieValue('kb_user');
    return raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
  }

  function accountEmail(login) {
    const local = String(login || '').trim().toLowerCase().split('@')[0].replace(/[^a-z0-9._-]/g, '');
    return local ? `${local}@${EMAIL_DOMAIN}` : '';
  }

  function signedInEmail() {
    return cookieValue('kb_email') || accountEmail(signedInName());
  }

  function inferOwner(name) {
    const n = String(name || '').trim().toLowerCase();
    if (n === 'sam') return 'Sam';
    if (n === 'alex') return 'Alex';
    return '';
  }

  function basePerson() {
    const login = signedInName();
    const key = login.trim().toLowerCase();
    const email = signedInEmail() || accountEmail(key);
    if (PEOPLE[key]) return Object.assign({ login }, PEOPLE[key], { email });
    const first = login.trim().split(/\s+/)[0] || '';
    return {
      login,
      name: login || 'Team member',
      firstName: first,
      email,
      role: '',
      ownerKey: inferOwner(key),
      team: ''
    };
  }

  function personRecord() {
    const person = basePerson();
    for (const field of PROFILE_FIELDS) {
      if (typeof profileEdits[field] === 'string') person[field] = profileEdits[field];
    }
    if (typeof profileEdits.name === 'string' && profileEdits.name) {
      person.firstName = profileEdits.name.split(/\s+/)[0];
    }
    return person;
  }

  function profileCacheKey() {
    return `${PROFILE_KEY}:${signedInName().toLowerCase()}`;
  }

  function loadProfileEdits() {
    try {
      const raw = JSON.parse(localStorage.getItem(profileCacheKey()) || 'null');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  function applyProfileEdits(edits) {
    profileEdits = edits && typeof edits === 'object' ? edits : {};
    localStorage.setItem(profileCacheKey(), JSON.stringify(profileEdits));
    renderProfileChip();
    if (prefs.view === 'dashboard') renderGreeting();
  }

  async function fetchProfile() {
    try {
      const response = await fetch('/api/profile', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      applyProfileEdits(data.profile);
      if (drawerKind === 'profile' && !drawerEl.contains(document.activeElement)) renderProfileDrawer();
    } catch {
      /* keep the cached profile */
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return programmeState();
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.phases) || !Array.isArray(data.tasks)) return programmeState();
      return normaliseState(data);
    } catch {
      return programmeState();
    }
  }

  function loadPrefs() {
    const base = { owner: '', dashOwner: '', scope: 'week', zoom: 'month', search: '', collapsed: [], view: 'dashboard' };
    try {
      const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      const firstDashboard = !Object.prototype.hasOwnProperty.call(stored, 'view');
      Object.assign(base, stored);
      if (firstDashboard) {
        base.view = 'dashboard';
        if (!base.owner) base.owner = inferOwner(signedInName());
        if (base.scope === 'all') base.scope = 'week';
      }
      if (base.view !== 'gantt' && base.view !== 'contacts') base.view = 'dashboard';
      return base;
    } catch {
      base.owner = inferOwner(signedInName());
      return base;
    }
  }

  function normalisePhase(p) {
    return {
      id: p.id || uid(),
      name: String(p.name || 'Category'),
      comment: String(p.comment || ''),
      start: p.start || '',
      end: p.end || ''
    };
  }

  function singleOwner(value) {
    const raw = String(value || '').replace(/programme coordinator/gi, 'Sam').trim();
    return raw.split(/\s*(?:\/|,|&)\s*/).map((part) => part.trim()).find(Boolean) || '';
  }

  function sharedOwnerTaskIds(data) {
    return (data?.tasks || []).filter((task) => {
      const parts = (value) => String(value || '').split(/\s*(?:\/|,|&)\s*/).filter(Boolean);
      return parts(task.owner).length > 1 || (task.actions || []).some((action) => parts(action.owner).length > 1);
    }).map((task) => task.id).filter(Boolean);
  }

  /* Managers write the first name back so a shared owner does not return on the next load. */
  function queueSharedOwners(data) {
    if (!canViewOthers()) return;
    sharedOwnerTaskIds(data).forEach((id) => dirtyTasks.add(id));
  }

  function normaliseTask(t) {
    const owner = singleOwner(t.owner);
    const task = {
      id: t.id || uid(),
      title: String(t.title || 'Untitled'),
      notes: String(t.notes || ''),
      phaseId: t.phaseId || '',
      linkedPhaseId: t.linkedPhaseId || '',
      start: t.start || '',
      end: t.end || '',
      status: STATUS_LABEL[t.status] ? t.status : 'todo',
      owner,
      actions: Array.isArray(t.actions) ? t.actions.map((a) => normaliseAction(a, t.start, owner)) : []
    };
    if (t.general) task.general = true;
    task.actions.sort(byDueDate);
    return task;
  }

  function byDueDate(a, b) {
    return (a.due || '9999-99-99').localeCompare(b.due || '9999-99-99');
  }

  function normaliseAction(a, anchor, taskOwner) {
    const done = a.done === true || /^(done|complete)/i.test(String(a.status || ''));
    const action = {
      week: String(a.week || ''),
      text: String(a.text || ''),
      status: done ? 'Done' : 'Not started',
      done,
      due: a.due || weekDeadline(a.week, anchor),
      notes: String(a.notes || ''),
      owner: singleOwner(a.owner || taskOwner || '')
    };
    const id = String(a.id || '').trim().slice(0, 80);
    if (id) action.id = id;
    return action;
  }

  /* "Wk of 7 Sep" → the Sunday ending that week. The year comes from the task's start. */
  function weekDeadline(label, anchor) {
    const match = String(label || '').match(/wk of (\d{1,2}) ([a-z]{3})/i);
    if (!match) return '';
    const month = MONTHS.indexOf(match[2].toLowerCase());
    if (month < 0) return '';
    const ref = parseDate(anchor) || new Date();
    let start = fmt(new Date(ref.getFullYear(), month, Number(match[1])));
    if (start < addDays(fmt(ref), -60)) start = fmt(new Date(ref.getFullYear() + 1, month, Number(match[1])));
    return addDays(monday(start), 6);
  }

  function weekLabel(iso) {
    const date = parseDate(monday(iso));
    return `Wk of ${date.getDate()} ${date.toLocaleDateString('en-GB', { month: 'short' }).slice(0, 3)}`;
  }

  function cloneData(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function persistedState() {
    if (drawerKind !== 'task' || !taskBackup) return state;
    let tasks = state.tasks.map((task) => (
      task.id === taskBackup.id ? cloneData(taskBackup) : task
    ));
    if (taskIsNew) tasks = tasks.filter((task) => task.id !== taskBackup.id);
    return { ...state, tasks };
  }

  function cache() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedState()));
    localStorage.setItem(VERSION_KEY, String(serverVersion || 0));
  }

  /* scope is a task id for single-task edits, or 'all' for anything structural. */
  function save(scope) {
    cache();
    if (scope && scope !== 'all') dirtyTasks.add(scope);
    else dirtyAll = true;
    schedulePush();
  }

  function savePrefs() {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }

  /* ── helpers ── */

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function parseDate(iso) {
    if (!iso) return null;
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function fmt(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function today() {
    return fmt(new Date());
  }

  function addDays(iso, n) {
    const date = parseDate(iso);
    date.setDate(date.getDate() + n);
    return fmt(date);
  }

  function daysBetween(a, b) {
    return Math.round((parseDate(b) - parseDate(a)) / 86400000);
  }

  function displayDate(iso) {
    const date = parseDate(iso);
    return date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  }

  function displayRange(start, end) {
    if (!start || !end) return '';
    const a = parseDate(start);
    const b = parseDate(end);
    if (a.getFullYear() !== b.getFullYear()) {
      return `${displayDate(start)} ${a.getFullYear()} – ${displayDate(end)} ${b.getFullYear()}`;
    }
    return `${displayDate(start)} – ${displayDate(end)}`;
  }

  function monday(iso) {
    const date = parseDate(iso || today());
    const back = date.getDay() === 0 ? 6 : date.getDay() - 1;
    date.setDate(date.getDate() - back);
    return fmt(date);
  }

  function findPhase(id) {
    return state.phases.find((p) => p.id === id) || LINK_ONLY.find((p) => p.id === id) || null;
  }

  function findTask(id) {
    return state.tasks.find((t) => t.id === id) || null;
  }

  /* Actions that belong to a category without a task sit on one standing task per category. */
  function generalTask(phaseId) {
    return state.tasks.find((task) => task.general && (task.phaseId || '') === (phaseId || '')) || null;
  }

  function ensureGeneralTask(phaseId) {
    const found = generalTask(phaseId);
    if (found) return found;
    const task = normaliseTask({ id: uid(), title: 'General', phaseId: phaseId || '', general: true });
    state.tasks.push(task);
    return task;
  }

  function taskLabel(task) {
    if (!task.general) return task.title;
    return `${findPhase(task.phaseId)?.name || BACKLOG.name} · General`;
  }

  /* Tasks keep the short owner key (Alex, Sam). The screen shows the full name.
     Email stays login@example.org, which is what Slack looks up. */
  function displayOwner(owner) {
    const raw = singleOwner(owner);
    if (!raw) return '';
    const person = Object.values(PEOPLE).find((item) => item.ownerKey.toLowerCase() === raw.toLowerCase());
    return person ? person.name : raw;
  }

  function shortOwner(owner) {
    return displayOwner(owner);
  }

  function greetingPhrase(date) {
    const hour = date.getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  function dashScope() {
    return prefs.dashScope === 'month' ? 'month' : 'week';
  }

  /* Coming back to the dashboard always starts on the signed-in person and this week.
     The timeline keeps its own period. */
  function showOwnWeek() {
    prefs.dashOwner = selfOwnerKey();
    prefs.dashScope = 'week';
    savePrefs();
  }

  function windowFor(scope) {
    if (scope === 'week') {
      const start = monday();
      return { start, end: addDays(start, 6) };
    }
    const now = parseDate(today());
    return {
      start: fmt(new Date(now.getFullYear(), now.getMonth(), 1)),
      end: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0))
    };
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function timezoneFallback() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const city = tz.split('/').pop()?.replace(/_/g, ' ') || '';
    const countries = {
      'Europe/Zurich': 'Switzerland',
      'Europe/Vaduz': 'Liechtenstein',
      'Europe/Kyiv': 'Ukraine',
      'Europe/Kiev': 'Ukraine',
      'Europe/Berlin': 'Germany',
      'Europe/Paris': 'France',
      'Europe/Vienna': 'Austria',
      'Europe/Rome': 'Italy',
      'Europe/London': 'United Kingdom'
    };
    const country = countries[tz];
    if (city && country) return `${city}, ${country}`;
    return city || 'Local time';
  }

  function hasOverdue(task) {
    return (task.actions || []).some((a) => !a.done && /overdue/i.test(a.week));
  }

  function isOverdueTask(task) {
    if (task.status === 'done') return false;
    return hasOverdue(task) || Boolean(task.end && task.end < today());
  }

  /* A bar past its end date is green when every action is done, red otherwise. */
  function timelineLate(task) {
    if (!task.end || task.end >= today()) return '';
    const actions = task.actions || [];
    return actions.every((action) => action.done) ? 'done' : 'open';
  }

  /* Timeline deadlines: red if overdue, green if done in the past, grey if still to come. */
  function deadlineTone(action) {
    if (!action?.due) return '';
    if (action.due >= today()) return 'is-upcoming';
    return action.done ? 'is-done' : 'is-late';
  }

  function actionDropRows(task, { dots } = {}) {
    const actions = [...task.actions].sort(byDueDate);
    if (!actions.length) {
      return `<button type="button" class="task-action-empty" data-id="${esc(task.id)}">No actions yet</button>`;
    }
    return actions.map((action) => {
      const index = task.actions.indexOf(action);
      const cls = ['task-action'];
      if (action.done) cls.push('is-done');
      const tone = dots ? deadlineTone(action) : '';
      if (tone === 'is-late') cls.push('is-overdue');
      const due = action.due
        ? `<span class="task-action-due">${dots ? `<span class="task-action-dot ${esc(tone)}" aria-hidden="true"></span>` : ''}${esc(displayDate(action.due))}</span>`
        : '<span class="task-action-due"></span>';
      return `<button type="button" class="${cls.join(' ')}" data-agenda-task="${esc(task.id)}" data-index="${index}">
        <span class="task-action-text">${esc(action.text || 'Untitled action')}</span>
        <span class="task-action-owner">${esc(shortOwner(actionOwner(task, action)) || 'Unassigned')}</span>
        ${due}
      </button>`;
    }).join('');
  }

  function actionPins(task, range) {
    return task.actions
      .filter((action) => action.due && action.due >= range.start && action.due <= range.end)
      .map((action) => {
        const x = daysBetween(range.start, action.due) * pxPerDay + pxPerDay / 2;
        const tone = deadlineTone(action);
        return `<span class="action-pin ${tone}" style="left:${x}px" title="${esc(action.text || 'Untitled action')} · ${esc(displayDate(action.due))}"></span>`;
      }).join('');
  }

  function nameIn(field, owner) {
    if (!owner) return true;
    const pattern = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${pattern}\\b`, 'i').test(String(field || ''));
  }

  /* An action without its own owner belongs to the task owner. */
  function actionOwner(task, action) {
    return action.owner || task.owner;
  }

  function ownsAction(task, action, owner) {
    return Boolean(owner) && nameIn(actionOwner(task, action), owner);
  }

  /* Dashboard filtering never falls back to "everyone": no owner means no tasks.
     A task also shows for anyone holding one of its actions. */
  function ownedBy(task, owner) {
    if (!owner) return false;
    return nameIn(task.owner, owner) || task.actions.some((action) => ownsAction(task, action, owner));
  }

  /* Alex and Sam edit everything; a collaborator edits tasks they own, and on
     other tasks only their own actions. A coordinator also edits the tasks they oversee.
     The server enforces the same rules. */
  function canEditTask(task) {
    return canViewOthers() || nameIn(task.owner, selfOwnerKey()) || overseesTask(task);
  }

  function canAssignOwner(task) {
    return canViewOthers() || overseesTask(task);
  }

  function canEditAction(task, action) {
    return canEditTask(task) || ownsAction(task, action, selfOwnerKey());
  }

  function selfOwnerKey() {
    const person = personRecord();
    if (person.ownerKey) return person.ownerKey;
    const first = String(person.login || '').toLowerCase().split(/[^a-z]+/).find(Boolean) || '';
    return first ? first[0].toUpperCase() + first.slice(1) : '';
  }

  function canViewOthers() {
    const login = signedInName().trim().toLowerCase();
    return login === 'alex' || login === 'sam';
  }

  function coordinatorScope() {
    return COORDINATORS[signedInName().trim().toLowerCase()] || null;
  }

  function canAddTasks() {
    return canViewOthers() || Boolean(coordinatorScope());
  }

  function accessiblePhases() {
    const scope = coordinatorScope();
    if (!scope) return state.phases.slice();
    const allowed = new Set(scope.categories.map(foldCategory));
    return state.phases.filter((phase) => allowed.has(foldCategory(phase.name)));
  }

  function canUsePhase(phaseId) {
    if (canViewOthers()) return true;
    if (!coordinatorScope()) return true;
    return Boolean(phaseId && accessiblePhases().some((phase) => phase.id === phaseId));
  }

  function categoryOptions(selectedId, emptyLabel) {
    const phases = accessiblePhases();
    const selected = findPhase(selectedId);
    if (selected && !phases.some((phase) => phase.id === selected.id)) phases.unshift(selected);
    const blank = emptyLabel ? [`<option value="">${esc(emptyLabel)}</option>`] : [];
    return blank
      .concat(phases.map((phase) => `<option value="${esc(phase.id)}" ${phase.id === selectedId ? 'selected' : ''}>${esc(phase.name)}</option>`))
      .join('');
  }

  function peerOwnerKeys() {
    return PEERS[signedInName().trim().toLowerCase()] || [];
  }

  function foldCategory(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function overseesTask(task) {
    const scope = coordinatorScope();
    if (!scope || !task) return false;
    const self = selfOwnerKey();
    if (scope.owners.some((owner) => owner !== self && ownedBy(task, owner))) return true;
    const name = foldCategory(findPhase(task.phaseId)?.name);
    return Boolean(name && scope.categories.some((item) => foldCategory(item) === name));
  }

  function canSeeTask(task) {
    if (canViewOthers()) return true;
    if (ownedBy(task, selfOwnerKey())) return true;
    if (peerOwnerKeys().some((owner) => ownedBy(task, owner))) return true;
    return overseesTask(task);
  }

  function teamOwnerKeys() {
    const scope = coordinatorScope();
    if (scope) return scope.owners.slice();
    if (canViewOthers()) return ownerNames();
    const self = selfOwnerKey();
    return [...new Set([self, ...peerOwnerKeys()].filter(Boolean))];
  }

  function canSwitchOwner() {
    return teamOwnerKeys().length > 1;
  }

  function ownerNames() {
    const seen = new Map();
    const owners = state.tasks.flatMap((task) => [task.owner, ...task.actions.map((action) => action.owner)]);
    [...MANAGERS, ...TEAM, ...owners].forEach((owner) => {
      String(owner || '').split(/\s*(?:\/|,|&)\s*/).forEach((part) => {
        const name = part.trim();
        if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
      });
    });
    const others = [...seen.values()]
      .filter((name) => !MANAGERS.includes(name))
      .sort((a, b) => a.localeCompare(b));
    return [...MANAGERS, ...others];
  }

  /* '' means everyone the signed-in person can see. */
  function ganttOwner() {
    if (canViewOthers()) return ownerNames().includes(prefs.owner) ? prefs.owner : '';
    if (canSwitchOwner()) return teamOwnerKeys().includes(prefs.owner) ? prefs.owner : '';
    return selfOwnerKey();
  }

  function ganttShows(task) {
    if (!canSeeTask(task)) return false;
    const owner = ganttOwner();
    if (!owner) return true;
    return ownedBy(task, owner);
  }

  function dashOwner() {
    const self = selfOwnerKey();
    if (!canSwitchOwner()) return self;
    return teamOwnerKeys().includes(prefs.dashOwner) ? prefs.dashOwner : self;
  }

  function assignTaskToPhase(task, phaseId) {
    task.phaseId = phaseId || '';
  }

  /* ── filtering ── */

  function scopeWindow() {
    if (prefs.scope === 'week' || prefs.scope === 'month') return windowFor(prefs.scope);
    return null;
  }

  function visibleTasks() {
    const win = scopeWindow();
    const needle = (prefs.search || '').trim().toLowerCase();
    const range = timelineRange();
    return state.tasks.filter((task) => {
      if (!ganttShows(task)) return false;
      if (task.start && task.end && !overlapsRange(task.start, task.end, range)) return false;
      if (win) {
        if (!task.start || !task.end) return false;
        if (task.start > win.end || task.end < win.start) return false;
      }
      if (needle) {
        const loose = task.general ? task.actions.map((action) => action.text).join(' ') : '';
        const hay = `${task.title} ${task.owner} ${task.notes} ${loose}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  function dashTasks() {
    const win = windowFor(dashScope());
    const owner = dashOwner();
    return state.tasks.filter((task) => {
      if (!ownedBy(task, owner)) return false;
      if (task.general) {
        return task.actions.some((action) => ownsAction(task, action, owner) && !action.done && (
          actionLate(action) || (action.due && action.due >= win.start && action.due <= win.end)
        ));
      }
      if (isOverdueTask(task) && hasOverdue(task)) return true;
      if (!task.start || !task.end) return false;
      return task.start <= win.end && task.end >= win.start;
    }).sort((a, b) => {
      const overdueA = isOverdueTask(a) ? 0 : 1;
      const overdueB = isOverdueTask(b) ? 0 : 1;
      if (overdueA !== overdueB) return overdueA - overdueB;
      return (a.start || '9999').localeCompare(b.start || '9999') || a.title.localeCompare(b.title);
    });
  }

  /* ── timeline geometry ── */

  function ganttYear() {
    const year = Number(prefs.year);
    if (YEARS.includes(year)) return year;
    const current = new Date().getFullYear();
    return Math.min(Math.max(current, YEARS[0]), YEARS[YEARS.length - 1]);
  }

  function timelineRange() {
    const year = ganttYear();
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }

  function overlapsRange(start, end, range) {
    return Boolean(start && end && start <= range.end && end >= range.start);
  }

  function monthTicks(rangeStart, rangeEnd) {
    const ticks = [];
    const cursor = parseDate(rangeStart);
    const last = parseDate(rangeEnd);
    while (cursor <= last) {
      const start = fmt(cursor);
      const monthEnd = fmt(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0));
      const end = monthEnd > rangeEnd ? rangeEnd : monthEnd;
      ticks.push({
        label: cursor.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
        days: daysBetween(start, end) + 1
      });
      cursor.setDate(1);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return ticks;
  }

  function weekTicks(rangeStart, rangeEnd) {
    const ticks = [];
    const cursor = parseDate(monday(rangeStart));
    const last = parseDate(rangeEnd);
    while (cursor <= last) {
      const start = fmt(cursor);
      const weekEnd = addDays(start, 6);
      const from = start < rangeStart ? rangeStart : start;
      const to = weekEnd > rangeEnd ? rangeEnd : weekEnd;
      ticks.push({ label: displayDate(from), days: daysBetween(from, to) + 1 });
      cursor.setDate(cursor.getDate() + 7);
    }
    return ticks;
  }

  /* ── routes ── */

  let suppressHistory = true;
  let replaceOnce = false;

  function readLocationRoute() {
    const path = location.pathname.replace(/\/+$/, '') || '/';
    const query = new URLSearchParams(location.search);
    if (path === '/internal/timeline') return { view: 'gantt', screen: '', id: '' };
    if (path === '/internal/contacts/review') return { view: 'contacts', screen: 'review', id: '' };
    const detail = path.match(/^\/internal\/contacts\/([^/]+)$/);
    if (detail) {
      let id = detail[1];
      try { id = decodeURIComponent(id); } catch { /* keep the raw segment */ }
      if (id && id !== '.' && id !== '..') return { view: 'contacts', screen: 'detail', id };
    }
    if (
      path === '/internal/contacts'
      || path.startsWith('/internal/contacts/')
      || (path === '/internal' && query.get('contacts') === '1')
    ) {
      return { view: 'contacts', screen: 'list', id: '' };
    }
    return { view: 'dashboard', screen: '', id: '' };
  }

  function pathForRoute(route) {
    if (route?.view === 'gantt') return '/internal/timeline';
    if (route?.view === 'contacts') {
      if (route.screen === 'review') return '/internal/contacts/review';
      if (route.screen === 'detail' && route.id) return `/internal/contacts/${encodeURIComponent(route.id)}`;
      return '/internal/contacts';
    }
    return '/internal';
  }

  function urlForRoute(route) {
    const path = pathForRoute(route);
    const gmail = new URLSearchParams(location.search).get('gmail');
    if (gmail === 'connected' || gmail === 'error') return `${path}?gmail=${encodeURIComponent(gmail)}`;
    return path;
  }

  function syncRoute(route) {
    if (!route) return;
    const path = pathForRoute(route);
    const here = location.pathname.replace(/\/+$/, '') || '/';
    if (path === here) {
      replaceOnce = false;
      return;
    }
    const state = { kb: path };
    const url = urlForRoute(route);
    if (suppressHistory || replaceOnce) {
      replaceOnce = false;
      history.replaceState(state, '', url);
      return;
    }
    history.pushState(state, '', url);
  }

  function plainClick(event) {
    return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
  }

  window.KBRoute = {
    read: readLocationRoute,
    sync: syncRoute,
    replaceNext() { replaceOnce = true; }
  };

  window.addEventListener('popstate', () => {
    const route = readLocationRoute();
    const apply = () => {
      suppressHistory = true;
      const nextView = route.view === 'gantt' || route.view === 'contacts' ? route.view : 'dashboard';
      if (nextView === 'dashboard' && prefs.view !== 'dashboard') showOwnWeek();
      prefs.view = nextView;
      if (prefs.view === 'gantt') centreOnToday = true;
      savePrefs();
      window.KBContacts?.applyRoute?.(route);
      render();
      suppressHistory = false;
    };
    if (prefs.view === 'contacts' && window.KBContacts?.holdLeave?.(apply)) return;
    apply();
  });

  /* ── render ── */

  function setView(view) {
    const next = view === 'gantt' || view === 'contacts' ? view : 'dashboard';
    if (prefs.view === 'contacts' && next !== 'contacts' && window.KBContacts?.holdLeave?.(() => setView(next))) return;
    if (next === 'gantt') centreOnToday = true;
    if (next === 'dashboard' && prefs.view !== 'dashboard') showOwnWeek();
    prefs.view = next;
    savePrefs();
    render();
  }

  function shellView() {
    if (prefs.view === 'contacts') return 'contacts';
    return prefs.view === 'gantt' ? 'gantt' : 'dashboard';
  }

  function render() {
    const view = shellView();
    if (view !== 'dashboard' && newActionsOpen) {
      newActionsOpen = false;
      const layer = document.getElementById('new-actions-layer');
      if (layer) layer.hidden = true;
    }
    if (prefs.view !== view) {
      prefs.view = view;
      savePrefs();
    }
    document.body.classList.toggle('view-gantt', view === 'gantt');
    document.body.classList.toggle('view-dashboard', view === 'dashboard');
    document.body.classList.toggle('view-contacts', view === 'contacts');
    dashboardEl.hidden = view !== 'dashboard';
    ganttEl.hidden = view !== 'gantt';
    ganttBarEl.hidden = view !== 'gantt';
    if (contactsRootEl) contactsRootEl.hidden = view !== 'contacts';
    if (contactsOpenBtn) {
      contactsOpenBtn.hidden = false;
      contactsOpenBtn.setAttribute('aria-pressed', String(view === 'contacts'));
    }
    renderProfileChip();

    if (view === 'contacts') {
      window.KBContacts?.show?.();
      if (!window.KBContacts) syncRoute(readLocationRoute());
      return;
    }

    syncRoute({ view: view === 'gantt' ? 'gantt' : 'dashboard', screen: '', id: '' });

    if (view !== 'gantt') {
      renderDashboard();
      return;
    }

    const keep = { left: ganttEl.scrollLeft, top: ganttEl.scrollTop };
    renderFilters();
    renderGantt();
    if (centreOnToday) {
      const todayX = Number(ganttEl.dataset.todayX) || 0;
      ganttEl.scrollLeft = Math.max(0, todayX - ganttEl.clientWidth * 0.3);
      centreOnToday = false;
    } else {
      ganttEl.scrollLeft = keep.left;
      ganttEl.scrollTop = keep.top;
    }
  }

  function segButtons(container, items, activeValue, key) {
    container.innerHTML = items.map((item) => `
      <button type="button" data-${key}="${esc(item.id)}" aria-pressed="${item.id === activeValue}">${esc(item.label)}</button>
    `).join('');
  }

  /* Closed state keeps the selected label. The full set opens underneath it. */
  function filterDrop(container, items, activeValue, key, groupLabel) {
    const active = items.find((item) => item.id === activeValue) || items[0];
    const current = active ? active.label : '';
    container.open = false;
    container.innerHTML = `
      <summary aria-label="${esc(groupLabel)}: ${esc(current)}">${esc(current)}</summary>
      <div class="filter-list" role="group" aria-label="${esc(groupLabel)}">
        ${items.map((item) => `
          <button type="button" data-${key}="${esc(item.id)}" aria-pressed="${item.id === activeValue}">${esc(item.label)}</button>
        `).join('')}
      </div>
    `;
  }

  function applyToolVisibility() {
    document.querySelectorAll('[data-add-tools]').forEach((el) => {
      el.hidden = !canAddTasks();
    });
    document.querySelectorAll('[data-manager-only]').forEach((el) => {
      el.hidden = !canViewOthers();
    });
  }

  function renderFilters() {
    applyToolVisibility();

    const ownerEl = document.getElementById('owner-filter');
    const people = canViewOthers() ? ownerNames() : (canSwitchOwner() ? teamOwnerKeys() : []);
    ownerEl.hidden = !people.length;
    if (people.length) {
      filterDrop(ownerEl, [
        { id: '', label: 'Everyone' },
        ...people.map((name) => ({ id: name, label: displayOwner(name) }))
      ], ganttOwner(), 'owner', 'Owner');
    } else {
      ownerEl.innerHTML = '';
    }

    filterDrop(document.getElementById('year-filter'), YEARS.map((year) => ({
      id: String(year),
      label: String(year)
    })), String(ganttYear()), 'year', 'Year');

    segButtons(document.getElementById('scope-filter'), [
      { id: 'all', label: 'All' },
      { id: 'month', label: 'This month' },
      { id: 'week', label: 'This week' }
    ], prefs.scope, 'scope');

    segButtons(document.getElementById('zoom-filter'), [
      { id: 'month', label: 'Months' },
      { id: 'week', label: 'Weeks' }
    ], prefs.zoom, 'zoom');

    if (searchEl && searchEl.value !== prefs.search) searchEl.value = prefs.search;
  }

  function renderProfileChip() {
    const person = personRecord();
    const avatar = document.getElementById('profile-avatar');
    const label = document.getElementById('profile-label');
    if (avatar) avatar.textContent = initials(person.name || person.login);
    if (label) label.textContent = person.name || person.login || 'Profile';
  }

  function renderDashboard() {
    applyToolVisibility();
    if (!canViewOthers()) newActionsOpen = false;
    renderGreeting();
    renderLocalMeta();
    renderDashFilters();
    renderTaskList();
    renderCalendar();
    refreshNewActions();
  }

  function renderGreeting() {
    const el = document.getElementById('greeting');
    if (!el) return;
    const person = personRecord();
    const phrase = greetingPhrase(new Date());
    el.textContent = person.firstName ? `${phrase}, ${person.firstName}` : phrase;
  }

  function renderLocalMeta() {
    const now = new Date();
    const dateEl = document.getElementById('local-date');
    const timeEl = document.getElementById('local-time');
    const placeEl = document.getElementById('local-place');
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
      });
    }
    if (timeEl) {
      timeEl.dateTime = now.toISOString();
      timeEl.textContent = now.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
    if (placeEl) placeEl.textContent = placeLabel || timezoneFallback();
  }

  function renderDashFilters() {
    const scopeEl = document.getElementById('dash-scope');
    if (scopeEl) {
      segButtons(scopeEl, [
        { id: 'week', label: 'This week' },
        { id: 'month', label: 'This month' }
      ], dashScope(), 'scope');
    }
    const ownerEl = document.getElementById('dash-owner');
    if (ownerEl) {
      ownerEl.hidden = !canSwitchOwner();
      if (canSwitchOwner()) {
        const left = ownerEl.scrollLeft;
        segButtons(ownerEl, teamOwnerKeys().map((name) => ({ id: name, label: displayOwner(name) })), dashOwner(), 'dash-owner');
        ownerEl.scrollLeft = left;
        const active = ownerEl.querySelector('[aria-pressed="true"]');
        if (active && ownerEl.clientWidth) {
          const row = ownerEl.getBoundingClientRect();
          const box = active.getBoundingClientRect();
          if (box.left < row.left) ownerEl.scrollLeft -= row.left - box.left;
          else if (box.right > row.right) ownerEl.scrollLeft += box.right - row.right;
        }
      } else {
        ownerEl.innerHTML = '';
      }
    }
  }

  function renderTaskList() {
    const el = document.getElementById('task-list');
    if (!el) return;
    const tasks = dashTasks();
    if (!tasks.length) {
      const owner = dashOwner();
      const who = !owner || owner === selfOwnerKey() ? 'you' : displayOwner(owner);
      const when = dashScope() === 'week' ? 'this week' : 'this month';
      el.innerHTML = `<p class="task-empty">No tasks ${when} for ${esc(who)}.</p>`;
      return;
    }
    el.innerHTML = tasks.map((task) => {
      const phase = findPhase(task.phaseId);
      const doneCount = task.actions.filter((a) => a.done).length;
      const progress = task.actions.length ? `${doneCount}/${task.actions.length} actions` : '';
      let overdue;
      let when;
      let bits;
      if (task.general) {
        const open = task.actions.filter((a) => !a.done && a.due).sort(byDueDate);
        const late = open.find(actionLate);
        overdue = Boolean(late);
        when = late ? `Overdue · ${displayDate(late.due)}` : (open[0] ? `Due ${displayDate(open[0].due)}` : 'No dates');
        bits = [phase?.name || BACKLOG.name, 'No task', progress];
      } else {
        overdue = isOverdueTask(task);
        when = overdue && task.end && task.end < today()
          ? `Overdue · ${displayDate(task.end)}`
          : (displayRange(task.start, task.end) || displayDate(task.end) || 'No dates');
        bits = [phase?.name, STATUS_LABEL[task.status], progress, shortOwner(task.owner)].filter(Boolean);
      }
      const open = dashOpen.has(task.id);
      const drop = open ? `<div class="task-drop">${actionDropRows(task)}</div>` : '';
      return `
        <div class="task-block${open ? ' is-open' : ''}">
          <button type="button" class="task-row ${overdue ? 'is-overdue' : ''}" data-dash-toggle="${esc(task.id)}" data-status="${esc(task.status)}" aria-expanded="${open}">
            <span class="dot" aria-hidden="true"></span>
            <span class="title">${esc(task.general ? 'General actions' : task.title)}</span>
            <span class="when">${esc(when)}</span>
            <span class="meta">${esc(bits.join(' · '))}</span>
          </button>
          ${drop}
        </div>
      `;
    }).join('');
  }

  function ownedActions(owner) {
    const list = [];
    state.tasks.forEach((task) => {
      task.actions.forEach((action, index) => {
        if (ownsAction(task, action, owner)) list.push({ task, action, index });
      });
    });
    return list;
  }

  /* Actions sitting on tasks this person owns, including those given to someone else. */
  function hostedActions(owner) {
    const list = [];
    state.tasks.forEach((task) => {
      if (!nameIn(task.owner, owner)) return;
      task.actions.forEach((action, index) => list.push({ task, action, index }));
    });
    return list;
  }

  function isDelegated(task, action, owner) {
    return Boolean(owner) && nameIn(task.owner, owner) && !ownsAction(task, action, owner);
  }

  /* Done (past or future) is green. Anything still open in the past is red.
     Open work still ahead stays the deadline colour. */
  function markTone(items, iso) {
    const due = items.filter(({ action }) => action.due === iso);
    if (!due.length) return '';
    const open = due.some(({ action }) => !action.done);
    if (!open) return 'done';
    return iso < today() ? 'overdue' : 'deadline';
  }

  function dayMarks(iso, mine, hosted, owner) {
    const assigned = hosted.filter((item) => isDelegated(item.task, item.action, owner));
    return { own: markTone(mine, iso), assigned: markTone(assigned, iso) };
  }

  function markSpan(tone, hollow) {
    if (!tone) return '';
    const labels = {
      deadline: hollow ? 'Assigned' : 'Deadline',
      overdue: hollow ? 'Assigned, overdue' : 'Overdue',
      done: hollow ? 'Assigned, done' : 'Done'
    };
    const cls = hollow ? `mark delegated ${tone}` : `mark ${tone}`;
    return `<span class="${cls}" title="${labels[tone]}"></span>`;
  }

  function renderCalendar() {
    const el = document.getElementById('month-cal');
    if (!el) return;
    if (!calSelected) calSelected = today();

    const year = calMonth.getFullYear();
    const month = calMonth.getMonth();
    const title = calMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();
    const cells = [];

    for (let i = 0; i < firstDow; i += 1) {
      const day = prevMonthDays - firstDow + 1 + i;
      cells.push({ iso: fmt(new Date(year, month - 1, day)), day, outside: true });
    }
    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push({ iso: fmt(new Date(year, month, day)), day, outside: false });
    }
    while (cells.length % 7) {
      const day = cells.length - firstDow - daysInMonth + 1;
      cells.push({ iso: fmt(new Date(year, month + 1, day)), day, outside: true });
    }

    const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const owner = dashOwner();
    const mine = ownedActions(owner);
    const hosted = hostedActions(owner);
    el.innerHTML = `
      <div class="cal-head">
        <h2>${esc(title)}</h2>
        <div class="cal-nav">
          <button type="button" data-cal="prev" aria-label="Previous month">‹</button>
          <button type="button" data-cal="next" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="cal-weekdays">${weekdays.map((day) => `<span>${day}</span>`).join('')}</div>
      <div class="cal-grid">
        ${cells.map((cell) => {
          const marks = dayMarks(cell.iso, mine, hosted, owner);
          const cls = ['cal-day'];
          if (cell.outside) cls.push('is-outside');
          if (cell.iso === today()) cls.push('is-today');
          if (cell.iso === calSelected && dayPanelOpen) cls.push('is-selected');
          const dots = markSpan(marks.own) + markSpan(marks.assigned, true);
          return `
            <button type="button" class="${cls.join(' ')}" data-day="${cell.iso}">
              <span class="num">${cell.day}</span>
              <span class="marks">${dots}</span>
            </button>
          `;
        }).join('')}
      </div>
      <p class="cal-legend">
        <span class="deadline"><i></i>Deadline</span>
        <span class="overdue"><i></i>Overdue</span>
        <span class="done"><i></i>Done</span>
        <span class="delegated"><i></i>Assigned</span>
      </p>
      ${renderDayPanel(owner, mine, hosted)}
    `;
    renderAgenda();
  }

  function agendaItems(list, empty, options) {
    if (!list.length) return `<p class="cal-empty">${empty}</p>`;
    return list.map(({ task, action, index }) => {
      const cls = ['agenda-item'];
      if (actionLate(action)) cls.push('is-overdue');
      if (action.done) cls.push('is-done');
      const text = action.text || 'Untitled action';
      const who = options?.showWho ? shortOwner(actionOwner(task, action)) : '';
      const parent = who ? `${taskLabel(task)} · ${who}` : taskLabel(task);
      const off = canEditAction(task, action) ? '' : 'disabled';
      return `
        <div class="${cls.join(' ')}">
          <input type="checkbox" class="action-check" data-agenda-toggle="${esc(task.id)}" data-index="${index}" ${action.done ? 'checked' : ''} ${off} aria-label="Done">
          <button type="button" class="agenda-open" data-agenda-task="${esc(task.id)}" data-index="${index}" title="${esc(text)} — ${esc(parent)}">
            <span class="title">${esc(text)}</span>
            <span class="parent">${esc(parent)}</span>
          </button>
          <span class="when">${esc(action.due ? displayDate(action.due) : '')}</span>
        </div>
      `;
    }).join('');
  }

  function renderDayPanel(owner, mine, hosted) {
    if (!dayPanelOpen || !calSelected) return '';
    const due = (item) => item.action.due === calSelected;
    const yours = mine.filter(due);
    const others = hosted.filter((item) => due(item) && isDelegated(item.task, item.action, owner));
    const self = owner === selfOwnerKey();
    const yoursLabel = self ? 'Yours' : owner;
    const othersLabel = self ? 'On your tasks' : `On ${owner}'s tasks`;
    const emptyYours = self ? 'Nothing of yours due this day.' : `Nothing for ${owner} this day.`;
    const emptyOthers = self ? 'No one else has an action on your tasks this day.' : `No one else has an action on ${owner}'s tasks this day.`;
    const label = parseDate(calSelected).toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    });
    return `
      <div class="day-panel" data-keeps-done>
        <div class="day-panel-head">
          <h3>${esc(label)}</h3>
          <button type="button" class="drawer-close" data-action="close-day" aria-label="Close">×</button>
        </div>
        <div class="agenda-block">
          <h3>${esc(yoursLabel)}</h3>
          ${agendaItems(yours, emptyYours)}
        </div>
        <div class="agenda-block">
          <h3>${esc(othersLabel)}</h3>
          ${agendaItems(others, emptyOthers, { showWho: true })}
        </div>
      </div>
    `;
  }

  function agendaDate() {
    return agendaDay || today();
  }

  function renderAgenda() {
    const el = document.getElementById('cal-agenda');
    if (!el || !calMonth) return;
    const day = agendaDate();
    const monthStart = fmt(new Date(calMonth.getFullYear(), calMonth.getMonth(), 1));
    const monthEnd = fmt(new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0));
    const todayIso = today();
    const actions = ownedActions(dashOwner());
    const byDue = (a, b) => (a.action.due || '').localeCompare(b.action.due || '');

    const dayActions = actions.filter(({ action }) => action.due === day);

    const overdue = actions.filter(({ action }) => actionLate(action)).sort(byDue);

    const deadlinesMonth = actions.filter(({ action }) => (
      !action.done && action.due && action.due >= todayIso && action.due >= monthStart && action.due <= monthEnd
    )).sort(byDue);

    const dayLabel = parseDate(day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    el.innerHTML = `
      <div class="agenda-block" data-keeps-done>
        <div class="agenda-day-head">
          <h3>${esc(dayLabel)}</h3>
          <div class="cal-nav">
            <button type="button" class="agenda-today" data-agenda-day="today">Today</button>
            <button type="button" data-agenda-day="prev" aria-label="Previous day">‹</button>
            <button type="button" data-agenda-day="next" aria-label="Next day">›</button>
          </div>
        </div>
        ${agendaItems(dayActions, 'No actions due on this day.')}
      </div>
      <div class="agenda-block">
        <h3>Deadlines</h3>
        ${agendaItems(deadlinesMonth, 'No upcoming deadlines this month.')}
      </div>
      <div class="agenda-block">
        <h3>Overdue</h3>
        ${agendaItems(overdue, 'Nothing overdue.')}
      </div>
    `;
  }

  function renderGantt() {
    const tasks = visibleTasks();
    const range = timelineRange();
    const groups = [...state.phases, BACKLOG]
      .map((phase) => ({
        phase,
        tasks: tasks.filter((t) => (t.phaseId || '') === phase.id && !(t.general && !t.actions.length))
      }))
      .filter((g) => g.tasks.length || (
        g.phase.id && !prefs.search && prefs.scope === 'all' && !ganttOwner() && (
          canViewOthers() || coordinatorScope()?.categories.some((name) => foldCategory(name) === foldCategory(g.phase.name))
        )
      ));

    if (!groups.length) {
      ganttEl.style.removeProperty('--track');
      ganttEl.innerHTML = `<p class="gantt-empty">No tasks in ${ganttYear()} match these filters. Clear the search, switch back to “All”, or pick another year.</p>`;
      return;
    }

    pxPerDay = prefs.zoom === 'week' ? 14 : 5;
    const totalDays = daysBetween(range.start, range.end) + 1;
    const trackWidth = totalDays * pxPerDay;
    const weekPx = 7 * pxPerDay;
    const weekOffset = daysBetween(range.start, monday(range.start)) * pxPerDay;
    const todayIso = today();
    const showToday = todayIso >= range.start && todayIso <= range.end;
    const todayX = showToday ? daysBetween(range.start, todayIso) * pxPerDay : 0;

    ganttEl.style.setProperty('--track', `${trackWidth}px`);
    ganttEl.style.setProperty('--week-px', `${weekPx}px`);
    ganttEl.style.setProperty('--week-offset', `${weekOffset}px`);
    ganttEl.dataset.todayX = todayX;

    const todayLine = showToday ? `<div class="today-line" style="left:${todayX}px"></div>` : '';
    const months = monthTicks(range.start, range.end);
    const weeks = prefs.zoom === 'week' ? weekTicks(range.start, range.end) : null;

    const axis = `
      <div class="axis ${weeks ? '' : 'single'}">
        <div class="axis-tier months">
          ${months.map((t) => `<div class="tick" style="width:${t.days * pxPerDay}px">${esc(t.label)}</div>`).join('')}
        </div>
        ${weeks ? `<div class="axis-tier weeks">
          ${weeks.map((t) => `<div class="tick" style="width:${t.days * pxPerDay}px">${esc(t.label)}</div>`).join('')}
        </div>` : ''}
        ${showToday ? `<div class="today-flag" style="left:${todayX}px" tabindex="0">Today<span class="today-date">${esc(displayDate(todayIso))} ${parseDate(todayIso).getFullYear()}</span></div>` : ''}
      </div>
    `;

    const rows = groups.map(({ phase, tasks: items }) => {
      const collapsed = prefs.collapsed.includes(phase.id);
      const note = String(phase.comment || '').trim();
      const head = `
        <div class="cat-side ${collapsed ? 'collapsed' : ''}">
          <button type="button" class="cat-toggle" data-cat="${esc(phase.id)}" aria-expanded="${!collapsed}">
            <span class="twist" aria-hidden="true">▼</span>
            <h2>${esc(phase.name)}</h2>
            ${note ? `<span class="cat-comment" title="${esc(note)}">${esc(note)}</span>` : ''}
            <span class="count">${items.length}</span>
          </button>
          ${phase.id && canViewOthers() ? `<button type="button" class="edit-cat" data-cat-edit="${esc(phase.id)}" aria-label="Edit ${esc(phase.name)}">edit</button>` : ''}
        </div>
        <div class="cat-track">${todayLine}</div>
      `;

      if (collapsed) return head;
      if (!items.length) return head + '<p class="cat-empty">No tasks yet.</p>';

      const sorted = [...items].sort((a, b) => (
        Number(Boolean(b.general)) - Number(Boolean(a.general)) || (a.start || '9999').localeCompare(b.start || '9999')
      ));
      return head + sorted.map((task) => taskRow(task, range, todayLine) + ganttDrop(task, todayLine)).join('');
    }).join('');

    ganttEl.innerHTML = `
      <div class="corner"><span>Task</span></div>
      ${axis}
      ${rows}
    `;
  }

  function generalRow(task, range, todayLine, selected) {
    const count = task.actions.length;
    return `
      <button type="button" class="task-side is-general ${selected ? 'is-selected' : ''}" data-id="${esc(task.id)}" title="Actions in ${esc(findPhase(task.phaseId)?.name || BACKLOG.name)} without a task">
        <span class="title">General</span>
        <span class="who">${count} action${count === 1 ? '' : 's'}</span>
      </button>
      <div class="task-track ${selected ? 'is-selected' : ''}" data-id="${esc(task.id)}">
        ${todayLine}
        ${actionPins(task, range)}
      </div>
    `;
  }

  /* Two clicks open a task only when the second one arrives within a second of opening. */
  function isTaskSecondClick(id) {
    const now = Date.now();
    if (taskClick.id === id && now - taskClick.at < 1000) {
      taskClick = { id: '', at: 0 };
      return true;
    }
    return false;
  }

  function markTaskClick(id) {
    taskClick = { id, at: Date.now() };
  }

  function ganttDrop(task, todayLine) {
    if (!ganttOpen.has(task.id)) return '';
    return `
      <div class="gantt-drop">${actionDropRows(task, { dots: true })}</div>
      <div class="gantt-drop-track">${todayLine}</div>
    `;
  }

  function taskRow(task, range, todayLine) {
    const selected = task.id === selectedId;
    if (task.general) return generalRow(task, range, todayLine, selected);
    const side = `
      <button type="button" class="task-side ${selected ? 'is-selected' : ''}" data-id="${esc(task.id)}" data-status="${esc(task.status)}"
        title="${esc(task.title)}${task.owner ? ' · ' + esc(task.owner) : ''}${task.start ? ' · ' + esc(displayRange(task.start, task.end)) : ''}">
        <span class="dot" aria-hidden="true"></span>
        <span class="title">${esc(task.title)}</span>
        ${hasOverdue(task) ? '<span class="flag" title="Overdue action this week">!</span>' : ''}
        <span class="who">${esc(shortOwner(task.owner))}</span>
      </button>
    `;

    if (!task.start || !task.end) {
      return side + `
        <div class="task-track ${selected ? 'is-selected' : ''}" data-id="${esc(task.id)}">
          ${todayLine}
          ${actionPins(task, range)}
          <span class="unscheduled">No dates yet — open the task to schedule it</span>
        </div>
      `;
    }

    const left = daysBetween(range.start, task.start) * pxPerDay;
    const width = Math.max(4, (daysBetween(task.start, task.end) + 1) * pxPerDay);
    const sync = task.linkedPhaseId === 'public';
    const late = timelineLate(task);
    const lateClass = late === 'open' ? 'is-late-open' : late === 'done' ? 'is-late-done' : '';
    const lateNote = late === 'open' ? ' · Overdue, actions still open' : late === 'done' ? ' · Overdue, all actions done' : '';
    const label = `${task.title}${task.owner ? ' · ' + task.owner : ''}`;

    return side + `
      <div class="task-track ${selected ? 'is-selected' : ''}" data-id="${esc(task.id)}">
        ${todayLine}
        <div class="bar ${selected ? 'is-selected' : ''} ${sync ? 'needs-sync' : ''} ${lateClass}" data-id="${esc(task.id)}" data-status="${esc(task.status)}"
          style="left:${left}px;width:${width}px"
          title="${esc(label)} · ${esc(displayRange(task.start, task.end))}${esc(lateNote)}">
          <span class="handle" data-edge="start"></span>
          <span class="handle" data-edge="end"></span>
        </div>
        ${actionPins(task, range)}
      </div>
    `;
  }

  function paintSelection(id) {
    selectedId = id;
    ganttEl.querySelectorAll('.task-side.is-selected, .task-track.is-selected, .bar.is-selected').forEach((el) => {
      el.classList.remove('is-selected');
    });
    if (!id) return;
    const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\"');
    ganttEl.querySelectorAll(`[data-id="${safe}"]`).forEach((el) => {
      if (el.matches('.task-side, .task-track, .bar')) el.classList.add('is-selected');
    });
  }

  function selectTask(id, scrollIntoView) {
    selectedId = id;
    render();
    if (!scrollIntoView) return;
    const bar = ganttEl.querySelector(`.bar[data-id="${id}"]`);
    if (!bar) return;
    const left = parseFloat(bar.style.left) || 0;
    const sidePx = ganttEl.querySelector('.corner')?.offsetWidth || 0;
    const visible = ganttEl.clientWidth - sidePx;
    if (left < ganttEl.scrollLeft || left > ganttEl.scrollLeft + visible - 40) {
      ganttEl.scrollLeft = Math.max(0, left - visible * 0.3);
    }
  }

  /* ── drawer ── */

  function revertTask() {
    if (!taskBackup) return;
    const index = state.tasks.findIndex((task) => task.id === taskBackup.id);
    if (index >= 0) state.tasks[index] = cloneData(taskBackup);
    taskBackup = null;
  }

  function taskHasUnsavedChanges() {
    if (drawerKind !== 'task') return false;
    writeTaskFromForm();
    const task = findTask(drawerId);
    if (!task || !taskBackup) return false;
    return JSON.stringify(task) !== JSON.stringify(taskBackup);
  }

  function newActionSnapshot(draft) {
    if (!draft) return null;
    return {
      phaseId: draft.phaseId || '',
      taskId: draft.taskId || '',
      text: draft.text || '',
      owner: draft.owner || '',
      due: draft.due || '',
      notes: draft.notes || ''
    };
  }

  function newActionHasUnsavedChanges() {
    if (drawerKind !== 'new-action' || !newActionDraft || !newActionBackup) return false;
    readNewActionDraft();
    return JSON.stringify(newActionSnapshot(newActionDraft)) !== JSON.stringify(newActionSnapshot(newActionBackup));
  }

  function drawerHasUnsavedChanges() {
    return taskHasUnsavedChanges() || newActionHasUnsavedChanges();
  }

  function showLeavePrompt(onChoice, onCancel) {
    leavePromptOpen = true;
    leaveChoice = typeof onChoice === 'function' ? onChoice : null;
    leaveCancel = typeof onCancel === 'function' ? onCancel : null;
    if (!leaveTaskLayer) return;
    leaveTaskLayer.hidden = false;
    leaveTaskLayer.querySelector('[data-action="save-and-close-task"]')?.focus();
  }

  function hideLeavePrompt() {
    leavePromptOpen = false;
    if (leaveTaskLayer) leaveTaskLayer.hidden = true;
  }

  function cancelLeavePrompt() {
    hideLeavePrompt();
    afterLeave = null;
    const cancel = leaveCancel;
    leaveChoice = null;
    leaveCancel = null;
    cancel?.();
  }

  function resolveLeave(shouldSave) {
    if (!leavePromptOpen) return;
    const choice = leaveChoice;
    leaveChoice = null;
    leaveCancel = null;
    hideLeavePrompt();
    if (choice) {
      choice(shouldSave);
      return;
    }
    if (shouldSave) {
      if (drawerKind === 'new-action') {
        if (!commitNewAction()) return;
        const next = afterLeave;
        afterLeave = null;
        next?.();
        return;
      }
      saveTaskEdits();
    }
    finishCloseDrawer();
    const next = afterLeave;
    afterLeave = null;
    next?.();
  }

  function openDrawer(kind, id) {
    if (drawerKind === 'task' && !(kind === 'task' && id === drawerId)) {
      afterLeave = () => openDrawer(kind, id);
      closeDrawer();
      return;
    }
    if (drawerKind === 'new-action' && kind !== 'new-action') {
      afterLeave = () => openDrawer(kind, id);
      closeDrawer();
      return;
    }
    if (kind !== 'task') taskIsNew = false;
    openActions = new Set();
    editingAction = null;
    drawerKind = kind;
    drawerId = id;
    backdropEl.hidden = false;
    drawerEl.hidden = false;
    drawerEl.classList.toggle('is-profile', kind === 'profile');
    if (kind === 'task') {
      const task = findTask(id);
      if (!taskBackup || taskBackup.id !== id) taskBackup = task ? cloneData(task) : null;
      renderTaskDrawer(task);
    } else if (kind === 'profile') renderProfileDrawer();
    else if (kind === 'new-action') renderNewActionDrawer('#new-action-phase');
    else renderCategoryDrawer(findPhase(id));
  }

  function closeDrawer() {
    if (leavePromptOpen) return false;
    if (drawerHasUnsavedChanges()) {
      showLeavePrompt();
      return false;
    }
    finishCloseDrawer();
    const next = afterLeave;
    afterLeave = null;
    next?.();
    return true;
  }

  function finishCloseDrawer() {
    hideLeavePrompt();
    const wasNew = taskIsNew;
    const newId = drawerId;
    const redraw = Boolean(drawerKind === 'task' && (taskBackup || wasNew));
    if (drawerKind === 'task') revertTask();
    const left = drawerKind === 'task' ? findTask(drawerId) : null;
    if (wasNew && newId) {
      state.tasks = state.tasks.filter((task) => task.id !== newId);
    } else if (left?.general && !left.actions.length && canViewOthers()) {
      state.tasks = state.tasks.filter((task) => task !== left);
    }
    taskIsNew = false;
    newActionDraft = null;
    newActionBackup = null;
    drawerKind = null;
    drawerId = null;
    drawerEl.classList.remove('is-profile');
    drawerEl.hidden = true;
    backdropEl.hidden = true;
    drawerEl.innerHTML = '';
    if (redraw) render();
  }

  function actionMeta(action) {
    if (action.due) return `Due ${displayDate(action.due)}`;
    return action.week || 'No deadline';
  }

  function actionLate(action) {
    if (action.done) return false;
    return /overdue/i.test(action.week) || Boolean(action.due && action.due < today());
  }

  /* Named people only, one each. Pass emptyLabel for an extra blank choice such as Unassigned. */
  function ownerOptions(selected, emptyLabel) {
    const names = ownerNames().filter((name) => !/\s*(?:\/|,|&)\s*/.test(name));
    const current = singleOwner(selected);
    if (current && !names.some((name) => name.toLowerCase() === current.toLowerCase())) names.push(current);
    const blank = emptyLabel ? [`<option value="">${esc(emptyLabel)}</option>`] : [];
    return blank
      .concat(names.map((name) => `<option value="${esc(name)}" ${name.toLowerCase() === current.toLowerCase() ? 'selected' : ''}>${esc(displayOwner(name))}</option>`))
      .join('');
  }

  function sortActions(task) {
    const open = [...openActions].map((index) => task.actions[index]).filter(Boolean);
    const editing = editingAction !== null ? task.actions[editingAction] : null;
    task.actions.sort(byDueDate);
    openActions = new Set(open.map((action) => task.actions.indexOf(action)).filter((index) => index >= 0));
    if (!editing) return;
    const index = task.actions.indexOf(editing);
    editingAction = index >= 0 ? index : null;
  }

  function actionItems(task) {
    sortActions(task);
    const taskEditable = canEditTask(task);
    return task.actions.map((action, i) => {
      const open = openActions.has(i);
      const editable = canEditAction(task, action);
      const off = editable ? '' : 'disabled';
      const cls = ['action-item'];
      if (action.done) cls.push('is-done');
      if (actionLate(action)) cls.push('is-overdue');
      if (open) cls.push('is-open');
      const delegated = action.owner && action.owner !== task.owner ? ` · ${shortOwner(action.owner)}` : '';
      const editing = open && editingAction === i && editable;
      return `
        <li class="${cls.join(' ')}" data-index="${i}">
          <input type="checkbox" class="action-check" data-action-toggle="${i}" ${action.done ? 'checked' : ''} ${off} aria-label="Done">
          <div class="action-main">
            <button type="button" class="action-body" data-action-open="${i}" aria-expanded="${open}">
              <span class="action-week">${esc(actionMeta(action) + delegated)}</span>
              ${editing ? '' : `<span class="action-text">${esc(action.text || 'Untitled action')}</span>`}
            </button>
            ${editing ? `<input id="action-text-${i}" class="action-name" data-action-field="text" value="${esc(action.text)}" aria-label="Action name">` : ''}
            ${open && editable && !editing ? `<button type="button" class="action-edit" data-action="edit-action" data-index="${i}">Edit</button>` : ''}
            ${open ? `
              <div class="action-detail">
                <div class="field-row">
                  <div class="field">
                    <label for="action-due-${i}">Deadline</label>
                    <input id="action-due-${i}" type="date" data-action-field="due" value="${esc(action.due)}" ${off}>
                  </div>
                  <div class="field">
                    <label for="action-owner-${i}">Owner</label>
                    <select id="action-owner-${i}" data-action-field="owner" ${taskEditable ? '' : 'disabled'}>${ownerOptions(actionOwner(task, action))}</select>
                  </div>
                </div>
                <div class="field">
                  <label for="action-notes-${i}">Details</label>
                  <textarea id="action-notes-${i}" data-action-field="notes" ${off}>${esc(action.notes)}</textarea>
                </div>
                ${taskEditable ? `<button type="button" class="danger" data-action="delete-action" data-index="${i}">Remove action</button>` : ''}
              </div>
            ` : ''}
          </div>
        </li>
      `;
    }).join('');
  }

  function renderGeneralDrawer(task, focusSelector) {
    const editable = canEditTask(task);
    drawerEl.innerHTML = `
      <div class="drawer-top">
        <h2 id="drawer-title">${esc(taskLabel(task))}</h2>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Close">×</button>
      </div>
      <p class="drawer-hint">Actions that belong to ${esc(findPhase(task.phaseId)?.name || BACKLOG.name)} without a task.</p>
      <div class="field">
        <label>Actions</label>
        <ul class="action-list">${actionItems(task)}</ul>
        ${editable ? '<button type="button" class="add-action" data-action="add-action">+ Add action</button>' : ''}
      </div>
      <div class="drawer-footer">
        <button type="button" class="save-btn" data-action="save-task">Save</button>
      </div>
    `;
    const focus = focusSelector || (editable ? '.add-action' : '.drawer-close');
    drawerEl.querySelector(focus)?.focus();
  }

  function renderTaskDrawer(task, focusSelector) {
    if (!task) return closeDrawer();
    if (task.general) return renderGeneralDrawer(task, focusSelector);
    const linkTargets = [...accessiblePhases(), ...LINK_ONLY.filter((p) => !state.phases.some((x) => x.id === p.id))];
    const catEmpty = coordinatorScope() ? 'Choose a category' : 'Unassigned — not on the timeline';
    const catOptions = categoryOptions(task.phaseId, catEmpty);
    const linkedOptions = ['<option value="">None</option>']
      .concat(linkTargets.map((p) => `<option value="${esc(p.id)}" ${p.id === task.linkedPhaseId ? 'selected' : ''}>${esc(p.name)}</option>`))
      .join('');
    const statusOptions = Object.entries(STATUS_LABEL)
      .map(([value, label]) => `<option value="${value}" ${task.status === value ? 'selected' : ''}>${label}</option>`)
      .join('');
    const editable = canEditTask(task);
    const off = editable ? '' : 'disabled';

    drawerEl.innerHTML = `
      <div class="drawer-top">
        <h2 id="drawer-title">Task</h2>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Close">×</button>
      </div>
      ${editable ? '' : `<p class="drawer-hint">You can update the actions assigned to you. Only ${esc(displayOwner(task.owner) || 'the task owner')}, Alex Admin or Sam Manager can change the task itself.</p>`}
      <div class="field">
        <label for="task-title">Title</label>
        <input id="task-title" value="${esc(task.title)}" ${off}>
      </div>
      <div class="field">
        <label for="task-phase">Category</label>
        <select id="task-phase" ${off}>${catOptions}</select>
      </div>
      <div class="field">
        <label for="task-linked">Coordinate with</label>
        <select id="task-linked" ${off}>${linkedOptions}</select>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="task-status">Status</label>
          <select id="task-status" ${off}>${statusOptions}</select>
        </div>
        <div class="field">
          <label for="task-owner">Owner</label>
          <select id="task-owner" ${canAssignOwner(task) ? '' : 'disabled'}>${ownerOptions(task.owner, 'Unassigned')}</select>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="task-start">Start</label>
          <input id="task-start" type="date" value="${esc(task.start)}" ${off}>
        </div>
        <div class="field">
          <label for="task-end">End</label>
          <input id="task-end" type="date" value="${esc(task.end)}" ${off}>
        </div>
      </div>
      <div class="field">
        <label for="task-notes">Notes</label>
        <textarea id="task-notes" ${off}>${esc(task.notes)}</textarea>
      </div>
      <div class="field">
        <label>Actions</label>
        <ul class="action-list">${actionItems(task)}</ul>
        ${editable ? '<button type="button" class="add-action" data-action="add-action">+ Add action</button>' : ''}
      </div>
      <div class="drawer-footer">
        ${canViewOthers() ? '<button type="button" class="danger" data-action="delete-task">Delete task</button>' : ''}
        <button type="button" class="save-btn" data-action="save-task">Save</button>
      </div>
    `;
    const focus = focusSelector || (editable ? '#task-title' : '.drawer-close');
    drawerEl.querySelector(focus)?.focus();
  }

  function applyActionDraft(el) {
    const task = findTask(drawerId);
    if (!task || drawerKind !== 'task') return;
    if (el.dataset.actionToggle !== undefined) {
      const action = task.actions[Number(el.dataset.actionToggle)];
      if (!action || action.done === el.checked || !canEditAction(task, action)) return;
      action.done = el.checked;
      action.status = action.done ? 'Done' : 'Not started';
      const item = el.closest('.action-item');
      item.classList.toggle('is-done', action.done);
      item.classList.toggle('is-overdue', actionLate(action));
      return;
    }
    const field = el.dataset.actionField;
    const index = Number(el.closest('.action-item')?.dataset.index);
    const action = task.actions[index];
    if (!field || !action || !canEditAction(task, action)) return;
    if (field === 'owner' && !canEditTask(task)) return;
    action[field] = field === 'owner' ? singleOwner(el.value) : el.value;
    if (field === 'due') action.week = action.due ? weekLabel(action.due) : '';
    const item = el.closest('.action-item');
    const delegated = action.owner && action.owner !== task.owner ? ` · ${shortOwner(action.owner)}` : '';
    item.querySelector('.action-week').textContent = actionMeta(action) + delegated;
    const title = item.querySelector('.action-text');
    if (title) title.textContent = action.text || 'Untitled action';
    item.classList.toggle('is-overdue', actionLate(action));
  }

  function toggleActionDetail(index) {
    const task = findTask(drawerId);
    if (!task) return;
    writeTaskFromForm();
    if (openActions.has(index)) {
      openActions.delete(index);
      if (editingAction === index) editingAction = null;
    } else openActions.add(index);
    renderTaskDrawer(task, `[data-action-open="${index}"]`);
  }

  function editActionName(index) {
    const task = findTask(drawerId);
    if (!task || !task.actions[index]) return;
    if (!canEditAction(task, task.actions[index])) return;
    writeTaskFromForm();
    openActions.add(index);
    editingAction = index;
    renderTaskDrawer(task, `#action-text-${index}`);
  }

  function addAction() {
    const task = findTask(drawerId);
    if (!task || !canEditTask(task)) return;
    writeTaskFromForm();
    const created = { week: '', text: '', status: 'Not started', done: false, due: '', notes: '', owner: task.owner || selfOwnerKey() };
    task.actions.push(created);
    openActions.add(task.actions.length - 1);
    editingAction = task.actions.length - 1;
    sortActions(task);
    renderTaskDrawer(task, `#action-text-${task.actions.indexOf(created)}`);
  }

  function deleteAction(index) {
    const task = findTask(drawerId);
    if (!task || !task.actions[index] || !canEditTask(task)) return;
    task.actions.splice(index, 1);
    openActions = new Set([...openActions].filter((item) => item !== index).map((item) => (item > index ? item - 1 : item)));
    if (editingAction === index) editingAction = null;
    else if (editingAction !== null && editingAction > index) editingAction -= 1;
    writeTaskFromForm();
    renderTaskDrawer(task, '.add-action');
  }

  function renderCategoryDrawer(phase) {
    if (!phase) return closeDrawer();
    const looseCount = generalTask(phase.id)?.actions.length || 0;
    drawerEl.innerHTML = `
      <div class="drawer-top">
        <h2 id="drawer-title">Category</h2>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Close">×</button>
      </div>
      <div class="field">
        <label for="phase-name">Name</label>
        <input id="phase-name" value="${esc(phase.name)}">
      </div>
      <div class="field">
        <label for="phase-comment">Comment</label>
        <textarea id="phase-comment" rows="4">${esc(phase.comment || '')}</textarea>
      </div>
      <div class="field">
        <label>Actions without a task</label>
        <div class="value">${looseCount ? `${looseCount} action${looseCount === 1 ? '' : 's'}` : 'None yet'}</div>
        <button type="button" class="add-action" data-action="open-general">${looseCount ? 'Open actions' : '+ Add action'}</button>
      </div>
      <div class="field">
        <label>Order</label>
        <div class="move-row">
          <button type="button" data-action="cat-up">Move up</button>
          <button type="button" data-action="cat-down">Move down</button>
        </div>
      </div>
      <div class="drawer-footer">
        <button type="button" class="danger" data-action="delete-category">Delete category</button>
        <button type="button" class="save-btn" data-action="save-category">Save</button>
      </div>
    `;
    document.getElementById('phase-name').focus();
  }

  function renderProfileDrawer() {
    const person = personRecord();
    const accountAddress = signedInEmail();
    const inputs = [
      ['name', 'Name', 'text', 'name'],
      ['email', 'Email', 'email', 'email'],
      ['role', 'Role', 'text', 'organization-title'],
      ['team', 'Team', 'text', 'off']
    ];
    const passkeyReady = window.KBPasskey?.supported?.() === true;
    const field = ([id, label, type, autocomplete]) => `
      <div class="field">
        <label for="profile-${id}">${label}</label>
        <input id="profile-${id}" data-profile-field="${id}" type="${type}" autocomplete="${autocomplete}" maxlength="120" value="${esc(person[id] || '')}">
      </div>
    `;
    drawerEl.innerHTML = `
      <div class="drawer-top">
        <h2 id="drawer-title">Profile</h2>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Close">×</button>
      </div>
      <div class="profile-sheet">
        <div class="profile-hero">
          <div class="avatar-lg" id="profile-hero-avatar">${esc(initials(person.name || person.login))}</div>
          <div>
            <h3 id="profile-hero-name">${esc(person.name || person.login || 'Profile')}</h3>
            <p id="profile-hero-role">${esc(person.role || 'YourOrg')}</p>
          </div>
        </div>
        ${inputs.map(field).join('')}
        <button type="button" class="save-btn" data-action="save-profile">Save</button>
        <div class="field">
          <label>Signed in as</label>
          <div class="value">${esc(person.login || '—')}</div>
        </div>
        <p class="password-status" id="profile-status" role="status"></p>
        <div class="password-form">
          <h3>Touch ID or Face ID</h3>
          <p class="password-hint" id="passkey-hint">${passkeyReady
            ? 'Sign in on this Mac or iPhone with Touch ID or Face ID, instead of typing a password.'
            : 'This browser cannot use Touch ID or Face ID.'}</p>
          <button type="button" class="password-save" id="passkey-save" data-action="setup-passkey"${passkeyReady ? '' : ' disabled'}>Set up on this device</button>
          <p class="password-status" id="passkey-status" role="status"></p>
        </div>
        <div class="password-form">
          <h3>Password</h3>
          <p class="password-hint">We will email a link to ${esc(accountAddress || 'your account address')}. Open it to choose a new password. The link expires after 30 minutes.</p>
          <button type="button" class="password-save" id="pw-save" data-action="send-reset-link">Email me a reset link</button>
          <p class="password-status" id="pw-status" role="status"></p>
        </div>
      </div>
    `;
    refreshPasskeyStatus();
  }

  async function refreshPasskeyStatus() {
    const hint = document.getElementById('passkey-hint');
    if (!hint || window.KBPasskey?.supported?.() !== true) return;
    try {
      const response = await fetch('/api/passkey');
      const data = await response.json().catch(() => ({}));
      if (!document.getElementById('passkey-hint')) return;
      if (response.ok && data.count > 0) {
        hint.textContent = 'This account can already sign in with Touch ID or Face ID. Add this device if it is a new one.';
      }
    } catch {
      /* the button still starts setup */
    }
  }

  async function setupPasskey() {
    const status = document.getElementById('passkey-status');
    const button = document.getElementById('passkey-save');
    if (!status || !button || !window.KBPasskey) return;
    button.disabled = true;
    status.textContent = 'Waiting for Touch ID or Face ID…';
    try {
      await window.KBPasskey.register();
      status.textContent = 'This device can now sign in with Touch ID or Face ID.';
      const hint = document.getElementById('passkey-hint');
      if (hint) hint.textContent = 'This account can already sign in with Touch ID or Face ID. Add this device if it is a new one.';
    } catch (error) {
      if (error && error.message === 'Not signed in') {
        logout();
        return;
      }
      status.textContent = window.KBPasskey.friendly(error);
    } finally {
      if (document.getElementById('passkey-save')) button.disabled = false;
    }
  }

  function applyProfileDraft() {
    const edits = {};
    drawerEl.querySelectorAll('[data-profile-field]').forEach((input) => {
      edits[input.dataset.profileField] = input.value.trim();
    });
    applyProfileEdits(edits);
    const person = personRecord();
    const avatar = document.getElementById('profile-hero-avatar');
    const name = document.getElementById('profile-hero-name');
    const role = document.getElementById('profile-hero-role');
    if (avatar) avatar.textContent = initials(person.name || person.login);
    if (name) name.textContent = person.name || person.login || 'Profile';
    if (role) role.textContent = person.role || 'YourOrg';
    saveProfile(edits);
  }

  async function saveProfile(edits) {
    const status = document.getElementById('profile-status');
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: edits })
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) return logout();
      if (status) status.textContent = response.ok ? 'Saved' : (data.error || 'Could not save your profile.');
    } catch {
      if (status) status.textContent = 'Could not reach the server. Your changes are kept in this browser.';
    }
  }

  async function sendResetLink() {
    const status = document.getElementById('pw-status');
    const button = document.getElementById('pw-save');
    if (!status || !button) return;
    button.disabled = true;
    status.textContent = 'Sending…';
    try {
      const response = await fetch('/api/password-reset', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401 && data.error === 'Not signed in') {
        logout();
        return;
      }
      status.textContent = response.ok
        ? `Link sent to ${data.email}. Check your inbox.`
        : (data.error || 'Could not send the link.');
    } catch {
      status.textContent = 'Could not reach the server.';
    } finally {
      button.disabled = false;
    }
  }

  function writeTaskFromForm() {
    const task = findTask(drawerId);
    const titleEl = document.getElementById('task-title');
    if (!task || drawerKind !== 'task' || !titleEl || !canEditTask(task)) return;
    task.title = titleEl.value.trim() || 'Untitled';
    task.notes = document.getElementById('task-notes').value;
    task.status = document.getElementById('task-status').value;
    if (canAssignOwner(task)) task.owner = singleOwner(document.getElementById('task-owner').value);
    task.start = document.getElementById('task-start').value;
    task.end = document.getElementById('task-end').value;
    task.linkedPhaseId = document.getElementById('task-linked').value;
    const nextPhase = document.getElementById('task-phase').value;
    if (nextPhase !== task.phaseId && canUsePhase(nextPhase || (coordinatorScope() ? task.phaseId : ''))) {
      assignTaskToPhase(task, nextPhase);
      document.getElementById('task-start').value = task.start;
      document.getElementById('task-end').value = task.end;
    }
  }

  function saveTaskEdits() {
    writeTaskFromForm();
    const task = findTask(drawerId);
    if (!task) return;
    if (task.start && task.end && task.end < task.start) {
      task.end = task.start;
      const endEl = document.getElementById('task-end');
      if (endEl) endEl.value = task.end;
    }
    const changed = taskIsNew || !taskBackup || JSON.stringify(task) !== JSON.stringify(taskBackup);
    taskIsNew = false;
    taskBackup = cloneData(task);
    if (!changed) return;
    save(task.id);
    render();
  }

  function writeCategoryFromForm() {
    const phase = findPhase(drawerId);
    const nameEl = document.getElementById('phase-name');
    if (!phase || drawerKind !== 'category' || !nameEl) return;
    phase.name = nameEl.value.trim() || 'Category';
    const commentEl = document.getElementById('phase-comment');
    if (commentEl) phase.comment = commentEl.value;
  }

  function saveCategoryEdits() {
    writeCategoryFromForm();
    save('all');
    render();
  }

  /* ── mutations ── */

  function addCategory() {
    const phase = { id: uid(), name: 'New category', comment: '' };
    state.phases.push(phase);
    save('all');
    render();
    openDrawer('category', phase.id);
  }

  function pendingNoteActions() {
    return window.KBContacts?.pendingActions?.() || [];
  }

  function refreshNewActions() {
    const pending = canViewOthers() ? pendingNoteActions() : [];
    const dot = document.querySelector('.new-actions-dot');
    const button = document.querySelector('[data-action="new-actions"]');
    if (dot) dot.hidden = pending.length === 0;
    if (button) {
      button.setAttribute('aria-expanded', String(newActionsOpen));
      button.setAttribute('aria-label', pending.length ? `New actions, ${pending.length} pending` : 'New actions');
    }
    const layer = document.getElementById('new-actions-layer');
    const list = document.getElementById('new-actions-list');
    if (!layer || !list) return;
    layer.hidden = !newActionsOpen;
    if (!newActionsOpen) return;
    if (!pending.length) {
      list.innerHTML = '<p class="new-actions-empty">No new actions from interaction notes.</p>';
      return;
    }
    list.innerHTML = pending.map((row) => {
      const when = row.due || row.date;
      const meta = [row.contactName, row.owner ? displayOwner(row.owner) : '', when ? displayDate(when) : '']
        .filter(Boolean)
        .join(' · ');
      return `<button type="button" class="new-action-row" data-action="open-pending" data-contact="${esc(row.contactId)}" data-note="${esc(row.noteId)}" data-index="${row.index}">
        <span class="new-action-text">${esc(row.text)}</span>
        <span class="new-action-meta">${esc(meta)}</span>
      </button>`;
    }).join('');
  }

  function closeNewActions() {
    if (!newActionsOpen) return;
    newActionsOpen = false;
    refreshNewActions();
  }

  function addTask(phaseId, owner) {
    if (!canAddTasks()) return;
    const start = () => {
      const task = normaliseTask({ id: uid(), title: 'Untitled', owner: owner || '' });
      const phase = phaseId || (coordinatorScope() ? accessiblePhases()[0]?.id : '');
      if (phase) assignTaskToPhase(task, phase);
      state.tasks.unshift(task);
      selectedId = task.id;
      taskIsNew = true;
      openDrawer('task', task.id);
    };
    if (drawerKind === 'task') {
      afterLeave = start;
      closeDrawer();
      return;
    }
    start();
  }

  function openNewAction() {
    if (!canAddTasks()) return;
    const start = () => {
      newActionDraft = {
        phaseId: coordinatorScope() ? (accessiblePhases()[0]?.id || '') : '',
        taskId: '',
        text: '',
        owner: dashOwner(),
        due: addDays(monday(), 6),
        notes: '',
        message: ''
      };
      newActionBackup = cloneData(newActionDraft);
      openDrawer('new-action');
    };
    if (drawerKind === 'task' || drawerKind === 'new-action') {
      afterLeave = start;
      closeDrawer();
      return;
    }
    start();
  }

  function readNewActionDraft() {
    if (!newActionDraft) return;
    const value = (id) => document.getElementById(id)?.value ?? '';
    const phaseId = value('new-action-phase');
    newActionDraft.taskId = phaseId === newActionDraft.phaseId ? value('new-action-task') : '';
    newActionDraft.phaseId = phaseId;
    newActionDraft.text = value('new-action-text');
    newActionDraft.owner = value('new-action-owner');
    newActionDraft.due = value('new-action-due');
    newActionDraft.notes = value('new-action-notes');
  }

  function renderNewActionDrawer(focusSelector) {
    const draft = newActionDraft;
    if (!draft) return closeDrawer();
    const tasks = draft.phaseId ? window.KBProgramme.tasksIn(draft.phaseId) : [];
    const phaseOptions = categoryOptions(draft.phaseId, 'Choose a category');
    const taskOptions = draft.phaseId
      ? tasks.map((t) => `<option value="${esc(t.id)}" ${t.id === draft.taskId ? 'selected' : ''}>${esc(t.title)}</option>`).join('')
      : '<option value="">Choose a category first</option>';
    drawerEl.innerHTML = `
      <div class="drawer-top">
        <h2 id="drawer-title">New action</h2>
        <button type="button" class="drawer-close" data-action="close-drawer" aria-label="Close">×</button>
      </div>
      <div class="field">
        <label for="new-action-phase">Category</label>
        <select id="new-action-phase">${phaseOptions}</select>
      </div>
      <div class="field">
        <label for="new-action-task">Task</label>
        <select id="new-action-task" ${draft.phaseId ? '' : 'disabled'}>${taskOptions}</select>
      </div>
      <div class="field">
        <label for="new-action-text">Action</label>
        <input id="new-action-text" maxlength="160" autocomplete="off" value="${esc(draft.text)}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="new-action-due">Deadline</label>
          <input id="new-action-due" type="date" value="${esc(draft.due)}">
        </div>
        <div class="field">
          <label for="new-action-owner">Owner</label>
          <select id="new-action-owner">${ownerOptions(draft.owner)}</select>
        </div>
      </div>
      <div class="field">
        <label for="new-action-notes">Details</label>
        <textarea id="new-action-notes">${esc(draft.notes)}</textarea>
      </div>
      ${draft.message ? `<p class="drawer-hint" role="status">${esc(draft.message)}</p>` : ''}
      <div class="drawer-footer">
        <button type="button" class="save-btn" data-action="save-new-action">Add action</button>
      </div>
    `;
    drawerEl.querySelector(focusSelector || '#new-action-text')?.focus();
  }

  function saveNewAction() {
    readNewActionDraft();
    const draft = newActionDraft;
    if (!draft) return false;
    const result = window.KBProgramme.attachAction({
      phaseId: draft.phaseId,
      taskId: draft.taskId || GENERAL_CHOICE,
      actionText: draft.text,
      due: draft.due,
      notes: draft.notes,
      owner: draft.owner
    });
    if (result?.error) {
      draft.message = draft.phaseId ? result.error : 'Choose a category first.';
      renderNewActionDrawer('.save-btn');
      return false;
    }
    newActionDraft = null;
    newActionBackup = null;
    return true;
  }

  function commitNewAction() {
    if (!saveNewAction()) return false;
    finishCloseDrawer();
    render();
    return true;
  }

  function openGeneral(phaseId) {
    if (!canViewOthers()) return;
    const task = ensureGeneralTask(phaseId);
    selectedId = task.id;
    openDrawer('task', task.id);
    if (!task.actions.length) addAction();
  }

  function deleteTask() {
    if (!canViewOthers() || !confirm('Delete this task?')) return;
    afterLeave = null;
    taskBackup = null;
    taskIsNew = false;
    const removed = drawerId;
    state.tasks = state.tasks.filter((t) => t.id !== removed);
    save(removed);
    finishCloseDrawer();
    render();
  }

  function deleteCategory() {
    if (!confirm('Delete this category? Its tasks move to Unassigned.')) return;
    state.tasks.forEach((t) => {
      if (t.phaseId === drawerId) t.phaseId = '';
    });
    state.phases = state.phases.filter((p) => p.id !== drawerId);
    save('all');
    closeDrawer();
    render();
  }

  function moveCategory(dir) {
    const index = state.phases.findIndex((p) => p.id === drawerId);
    const next = index + dir;
    if (index < 0 || next < 0 || next >= state.phases.length) return;
    const [phase] = state.phases.splice(index, 1);
    state.phases.splice(next, 0, phase);
    save('all');
    render();
  }

  function toggleCategory(id) {
    const i = prefs.collapsed.indexOf(id);
    if (i === -1) prefs.collapsed.push(id);
    else prefs.collapsed.splice(i, 1);
    savePrefs();
    render();
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    downloadBlob(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), `yourorg-timeline-${today()}.json`);
  }

  /* The full year on the chart, including tasks with no dates. Filters for a person,
     a search, or this week stay on screen and are not applied to the file. */
  function exportTasks() {
    const range = timelineRange();
    return state.tasks.filter((task) => {
      if (task.general && !task.actions.length) return false;
      if (!canViewOthers() && !ganttShows(task)) return false;
      if (task.start && task.end && !overlapsRange(task.start, task.end, range)) return false;
      return true;
    });
  }

  function exportModel() {
    const range = timelineRange();
    const tasks = exportTasks();
    const groups = [...state.phases, BACKLOG]
      .map((phase) => ({
        phase,
        tasks: tasks
          .filter((task) => (task.phaseId || '') === phase.id)
          .sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.title.localeCompare(b.title))
      }))
      .filter((group) => group.tasks.length || group.phase.id);
    const months = [];
    const cursor = parseDate(range.start);
    const last = parseDate(range.end);
    while (cursor <= last) {
      const start = fmt(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
      const end = fmt(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0));
      months.push({
        label: cursor.toLocaleDateString('en-GB', { month: 'short' }),
        start: start < range.start ? range.start : start,
        end: end > range.end ? range.end : end
      });
      cursor.setMonth(cursor.getMonth() + 1, 1);
    }
    return { range, groups, months, year: ganttYear() };
  }

  function exportPdf() {
    const model = exportModel();
    downloadBlob(new Blob([buildTimelinePdf(model)], { type: 'application/pdf' }), `yourorg-timeline-${model.year}.pdf`);
  }

  function exportExcel() {
    const model = exportModel();
    downloadBlob(buildTimelineWorkbook(model), `yourorg-timeline-${model.year}.xlsx`);
  }

  function pdfEscape(value) {
    const text = String(value ?? '')
      .replace(/[–—]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\u00a0/g, ' ');
    let out = '';
    for (const ch of text) {
      const code = ch.codePointAt(0);
      const byte = code <= 255 ? code : 63;
      if (byte === 92 || byte === 40 || byte === 41) out += `\\${String.fromCharCode(byte)}`;
      else if (byte < 32) out += ' ';
      else if (byte > 126) out += `\\${byte.toString(8).padStart(3, '0')}`;
      else out += String.fromCharCode(byte);
    }
    return out;
  }

  function fitPdfText(value, size, maxWidth) {
    const text = String(value ?? '');
    const widthOf = (sample) => sample.length * size * 0.5;
    if (widthOf(text) <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && widthOf(`${cut}...`) > maxWidth) cut = cut.slice(0, -1);
    return `${cut}...`;
  }

  function buildTimelinePdf(model) {
    const pageW = 1191;
    const pageH = 842;
    const margin = 28;
    const nameW = 188;
    const chartX = margin + nameW;
    const chartW = pageW - margin - chartX;
    const totalDays = daysBetween(model.range.start, model.range.end) + 1;
    const dayW = chartW / totalDays;
    const rowH = 16;
    const pages = [];
    let ops = [];
    let y = margin;

    const num = (value) => (Math.round(value * 100) / 100).toString();
    const xOf = (iso) => chartX + Math.max(0, daysBetween(model.range.start, iso)) * dayW;
    const span = (start, end) => {
      const a = start < model.range.start ? model.range.start : start;
      const b = end > model.range.end ? model.range.end : end;
      return { x: xOf(a), w: Math.max(1.2, (daysBetween(a, b) + 1) * dayW) };
    };
    const rgb = (color) => ops.push(`${color.map(num).join(' ')} rg`);
    const fill = (x, top, w, h, color) => {
      rgb(color);
      ops.push(`${num(x)} ${num(pageH - top - h)} ${num(w)} ${num(h)} re f`);
    };
    const label = (x, top, size, text, bold, color) => {
      rgb(color);
      ops.push(`BT ${bold ? '/F2' : '/F1'} ${size} Tf ${num(x)} ${num(pageH - top - size)} Td (${pdfEscape(text)}) Tj ET`);
    };

    function paintHeader(continued) {
      y = margin;
      label(margin, y, 13, `YourOrg timeline ${model.year}`, true, [0, 0, 0]);
      label(margin + 210, y + 3, 8, continued ? 'continued' : 'Red: overdue, actions open    Green: overdue, actions done', false, [0.35, 0.35, 0.35]);
      y += 22;
      model.months.forEach((month, index) => {
        const box = span(month.start, month.end);
        if (index % 2) fill(box.x, y, box.w, 14, [0.95, 0.95, 0.95]);
        label(box.x + 2, y + 3, 8, month.label, true, [0.15, 0.15, 0.15]);
      });
      y += 16;
    }

    function ensure(height) {
      if (!ops.length) paintHeader(pages.length > 0);
      else if (y + height > pageH - margin) {
        pages.push(ops.join('\n'));
        ops = [];
        paintHeader(true);
      }
    }

    function paintRow(title, bold, bar) {
      ensure(rowH);
      const top = y;
      if (bold) fill(margin, top, pageW - margin * 2, rowH, [0.93, 0.93, 0.93]);
      model.months.forEach((month, index) => {
        if (index % 2 === 0) return;
        const box = span(month.start, month.end);
        fill(box.x, top, box.w, rowH, [0.97, 0.97, 0.97]);
      });
      label(margin + 4, top + 4, 8, fitPdfText(title, 8, nameW - 10), bold, [0, 0, 0]);
      if (bar) fill(bar.x, top + 3, bar.w, 10, bar.color);
      if (bar?.text) label(bar.x + 3, top + 4.5, 7, fitPdfText(bar.text, 7, bar.w - 6), false, bar.ink);
      const todayIso = today();
      if (todayIso >= model.range.start && todayIso <= model.range.end) {
        const x = xOf(todayIso);
        ops.push(`0.15 0.15 0.15 RG ${num(x)} ${num(pageH - top - rowH)} m ${num(x)} ${num(pageH - top)} l S`);
      }
      y += rowH;
    }

    if (!model.groups.length) {
      paintHeader(false);
      label(margin, y + 8, 10, `No tasks in ${model.year}.`, false, [0.2, 0.2, 0.2]);
    } else {
      model.groups.forEach((group) => {
        const note = String(group.phase.comment || '').trim();
        const heading = note ? `${group.phase.name} — ${note}` : group.phase.name;
        paintRow(heading, true, null);
        group.tasks.forEach((task) => {
          let bar = null;
          if (task.start && task.end && overlapsRange(task.start, task.end, model.range)) {
            const late = timelineLate(task);
            const color = late === 'open' ? [1, 0.271, 0.227] : late === 'done' ? [0.188, 0.82, 0.345] : [0.72, 0.72, 0.72];
            const ink = late === 'open' ? [1, 1, 1] : late === 'done' ? [0.02, 0.13, 0.05] : [0.12, 0.12, 0.12];
            const box = span(task.start, task.end);
            bar = { ...box, color, ink, text: box.w > 46 ? task.title : '' };
          }
          paintRow(task.title, false, bar);
        });
      });
    }
    if (ops.length) pages.push(ops.join('\n'));

    pages.forEach((stream, index) => {
      const footer = `BT /F1 8 Tf 0.45 0.45 0.45 rg ${num(margin)} 16 Td (${pdfEscape(`YourOrg  ${model.year}`)}) Tj ET BT /F1 8 Tf ${num(pageW - margin - 48)} 16 Td (${index + 1} / ${pages.length}) Tj ET`;
      pages[index] = `${stream}\n${footer}`;
    });

    return assemblePdf(pages);
  }

  function assemblePdf(streams) {
    const objects = [];
    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>';
    const kids = [];
    let id = 5;
    streams.forEach((stream) => {
      const pageId = id;
      const contentId = id + 1;
      id += 2;
      kids.push(`${pageId} 0 R`);
      objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1191 842] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`;
      objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });
    objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${streams.length} >>`;
    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i < objects.length; i += 1) {
      if (!objects[i]) continue;
      offsets[i] = out.length;
      out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xref = out.length;
    const size = objects.length;
    out += `xref\n0 ${size}\n`;
    out += '0000000000 65535 f \n';
    for (let i = 1; i < size; i += 1) {
      out += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return out;
  }

  function exportColumn(index) {
    let n = index + 1;
    let name = '';
    while (n) {
      const mod = (n - 1) % 26;
      name = String.fromCharCode(65 + mod) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  function xmlText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    }[ch]));
  }

  function sheetXml(rows, widths) {
    const cols = widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('');
    const body = rows.map((row, rowIndex) => {
      const cells = row.map((item, colIndex) => {
        if (!item) return '';
        const ref = `${exportColumn(colIndex)}${rowIndex + 1}`;
        const style = item.style ? ` s="${item.style}"` : '';
        if (!item.text && item.text !== 0) return `<c r="${ref}"${style}/>`;
        return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlText(item.text)}</t></is></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${cols}</cols>
  <sheetData>${body}</sheetData>
</worksheet>`;
  }

  function buildTimelineWorkbook(model) {
    const monthStyle = (task) => {
      const late = timelineLate(task);
      if (late === 'open') return 2;
      if (late === 'done') return 3;
      return 4;
    };
    const signal = (task) => {
      const late = timelineLate(task);
      if (late === 'open') return 'Overdue, actions open';
      if (late === 'done') return 'Overdue, actions done';
      return '';
    };
    const head = ['Category', 'Task', 'Owner', 'Status', 'Start', 'End', 'Actions done', 'Actions open', 'Timeline', ...model.months.map((month) => month.label)]
      .map((text) => ({ text, style: 1 }));
    const ganttRows = [head];
    const actionRows = [[
      { text: 'Category', style: 1 },
      { text: 'Task', style: 1 },
      { text: 'Action', style: 1 },
      { text: 'Owner', style: 1 },
      { text: 'Due', style: 1 },
      { text: 'Status', style: 1 },
      { text: 'Notes', style: 1 }
    ]];
    model.groups.forEach((group) => {
      ganttRows.push([
        { text: group.phase.name, style: 5 },
        { text: String(group.phase.comment || '').trim(), style: 5 }
      ]);
      group.tasks.forEach((task) => {
        const actions = task.actions || [];
        const done = actions.filter((action) => action.done).length;
        const row = [
          { text: group.phase.name },
          { text: task.title },
          { text: displayOwner(task.owner) },
          { text: STATUS_LABEL[task.status] || task.status },
          { text: task.start || '' },
          { text: task.end || '' },
          { text: String(done) },
          { text: String(actions.length - done) },
          { text: signal(task) }
        ];
        model.months.forEach((month) => {
          const hits = task.start && task.end && task.start <= month.end && task.end >= month.start;
          row.push(hits ? { text: '', style: monthStyle(task) } : null);
        });
        ganttRows.push(row);
        actions.forEach((action) => {
          actionRows.push([
            { text: group.phase.name },
            { text: task.title },
            { text: action.text },
            { text: displayOwner(action.owner) },
            { text: action.due || action.week || '' },
            { text: action.done ? 'Done' : 'Open' },
            { text: action.notes }
          ]);
        });
      });
    });
    const ganttWidths = [22, 36, 22, 14, 12, 12, 14, 14, 26, ...model.months.map(() => 8)];
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="3">
    <font><sz val="11"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1A1A1A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFF453A"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF30D158"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD0D0D0"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE6E6E6"/></patternFill></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="6">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>
    <xf numFmtId="0" fontId="2" fillId="6" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
    return zipStore([
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Gantt" sheetId="1" r:id="rId1"/>
    <sheet name="Actions" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
      { name: 'xl/styles.xml', data: styles },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml(ganttRows, ganttWidths) },
      { name: 'xl/worksheets/sheet2.xml', data: sheetXml(actionRows, [22, 36, 42, 22, 14, 12, 36]) }
    ], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zipStore(files, type) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((file) => {
      const name = encoder.encode(file.name);
      const data = encoder.encode(file.data);
      const crc = crc32(data);
      const zipTime = 12 << 11;
      const zipDate = ((2026 - 1980) << 9) | (10 << 5) | 12;
      const local = new Uint8Array(30 + name.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, zipTime, true);
      view.setUint16(12, zipDate, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      parts.push(local, data);
      const entry = new Uint8Array(46 + name.length);
      const directory = new DataView(entry.buffer);
      directory.setUint32(0, 0x02014b50, true);
      directory.setUint16(4, 20, true);
      directory.setUint16(6, 20, true);
      directory.setUint16(10, 0, true);
      directory.setUint16(12, zipTime, true);
      directory.setUint16(14, zipDate, true);
      directory.setUint32(16, crc, true);
      directory.setUint32(20, data.length, true);
      directory.setUint32(24, data.length, true);
      directory.setUint16(28, name.length, true);
      directory.setUint32(42, offset, true);
      entry.set(name, 46);
      central.push(entry);
      offset += local.length + data.length;
    });
    const centralStart = offset;
    let centralSize = 0;
    central.forEach((entry) => { centralSize += entry.length; });
    const end = new Uint8Array(22);
    const ending = new DataView(end.buffer);
    ending.setUint32(0, 0x06054b50, true);
    ending.setUint16(8, files.length, true);
    ending.setUint16(10, files.length, true);
    ending.setUint32(12, centralSize, true);
    ending.setUint32(16, centralStart, true);
    return new Blob([...parts, ...central, end], { type });
  }

  function importJson(file) {
    if (!canViewOthers()) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.phases) || !Array.isArray(data.tasks)) throw new Error('bad file');
        state = normaliseState(data);
        save('all');
        afterLeave = null;
        finishCloseDrawer();
        render();
      } catch {
        alert('Could not import that file. Use a JSON export from this page.');
      }
    };
    reader.readAsText(file);
  }

  function reloadProgramme() {
    if (!canViewOthers()) return;
    const warning = syncMode === 'shared'
      ? 'Reload the programme from the internal timeline? This replaces the shared version for the whole team.'
      : 'Reload the programme from the internal timeline? Changes saved in this browser will be replaced.';
    if (!confirm(warning)) return;
    state = programmeState();
    save('all');
    afterLeave = null;
    finishCloseDrawer();
    centreOnToday = true;
    render();
  }

  /* ── shared state ── */

  function setSyncStatus(kind, detail) {
    const el = document.getElementById('sync');
    if (!el) return;
    const labels = {
      checking: '',
      synced: '',
      saving: 'Saving…',
      offline: 'Not saved yet',
      local: ''
    };
    el.textContent = labels[kind] ?? '';
    el.dataset.state = kind;
    el.title = detail || {
      synced: 'Everyone signed in sees this timeline',
      saving: 'Sending your change to the team',
      offline: 'Could not reach the server — your change is kept here and retried'
    }[kind] || '';
  }

  function currentDirtyScope() {
    return { all: dirtyAll, tasks: new Set(dirtyTasks) };
  }

  /* Takes the team's version, but keeps the tasks this browser just changed. */
  function applyRemote(remote, keep) {
    serverVersion = remote.updatedAt || 0;
    if (!remote.state || !Array.isArray(remote.state.tasks)) return;
    queueSharedOwners(remote.state);
    if (keep && keep.all) return;

    const live = drawerKind === 'task' && drawerId
      ? state.tasks.find((task) => task.id === drawerId)
      : null;
    const incoming = normaliseState(remote.state);
    if (keep && keep.tasks.size) {
      const mine = new Map(state.tasks.map((t) => [t.id, t]));
      incoming.tasks = incoming.tasks
        .filter((t) => !keep.tasks.has(t.id) || mine.has(t.id))
        .map((t) => (keep.tasks.has(t.id) ? mine.get(t.id) : t));
      keep.tasks.forEach((id) => {
        if (mine.has(id) && !incoming.tasks.some((t) => t.id === id)) {
          incoming.tasks.unshift(mine.get(id));
        }
      });
    }
    if (live) {
      const index = incoming.tasks.findIndex((task) => task.id === live.id);
      if (index >= 0) incoming.tasks[index] = live;
      else incoming.tasks.unshift(live);
    }

    state = incoming;
    cache();
    render();
  }

  function schedulePush(delay) {
    if (syncMode !== 'shared') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay ?? 700);
  }

  async function push(attempt) {
    if (syncMode !== 'shared' || pushing) return;
    if (!dirtyAll && !dirtyTasks.size) return;

    const scope = currentDirtyScope();
    dirtyAll = false;
    dirtyTasks = new Set();
    pushing = true;
    setSyncStatus('saving');

    const keepDirty = () => {
      if (scope.all) dirtyAll = true;
      scope.tasks.forEach((id) => dirtyTasks.add(id));
    };

    try {
      const response = await fetch(SYNC_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: serverVersion, state: persistedState() })
      });

      if (response.status === 401) {
        logout();
        return;
      }
      if (response.status === 409) {
        applyRemote(await response.json(), scope);
        pushing = false;
        keepDirty();
        if ((attempt || 0) < 3) return push((attempt || 0) + 1);
        setSyncStatus('offline', 'Someone else is editing right now — retrying shortly');
        return schedulePush(4000);
      }
      if (response.status === 403) {
        const refusal = await response.json().catch(() => ({}));
        serverVersion = -1;
        pushing = false;
        await pull();
        setSyncStatus('offline', refusal.error || 'That change is not allowed');
        return;
      }
      if (!response.ok) throw new Error(`save failed (${response.status})`);

      const data = await response.json();
      serverVersion = data.updatedAt || 0;
      setSyncStatus('synced');
    } catch (error) {
      keepDirty();
      setSyncStatus('offline', `Could not save: ${error.message}. Retrying.`);
      schedulePush(5000);
    } finally {
      pushing = false;
    }
  }

  async function readRemote() {
    const pending = window.KB_STATE_PROMISE;
    window.KB_STATE_PROMISE = null;
    if (pending) {
      const packed = await pending;
      if (!packed) throw new Error('load failed');
      return packed;
    }
    const response = await fetch(SYNC_URL, { cache: 'no-store' });
    return {
      status: response.status,
      body: response.ok ? await response.json() : null
    };
  }

  async function pull() {
    if (pushing) return;
    try {
      const packed = await readRemote();
      if (packed.status === 401) {
        logout();
        return;
      }
      if (packed.status === 501) {
        syncMode = 'local';
        setSyncStatus('local');
        return;
      }
      if (packed.status !== 200 || !packed.body) throw new Error(`load failed (${packed.status})`);

      const remote = packed.body;
      const firstContact = syncMode !== 'shared';
      syncMode = 'shared';

      if (!remote.state) {
        serverVersion = 0;
        dirtyAll = true;
        await push();
        return;
      }
      queueSharedOwners(remote.state);
      if ((remote.updatedAt || 0) === serverVersion && serverVersion) {
        setSyncStatus(dirtyAll || dirtyTasks.size ? 'saving' : 'synced');
        schedulePush(300);
        return;
      }
      if (firstContact || (remote.updatedAt || 0) !== serverVersion) {
        applyRemote(remote, currentDirtyScope());
      }
      setSyncStatus(dirtyAll || dirtyTasks.size ? 'saving' : 'synced');
      schedulePush(300);
    } catch (error) {
      setSyncStatus('offline', `Could not load the team version: ${error.message}`);
    }
  }

  function startSync() {
    pull();
    setInterval(() => {
      if (document.hidden || drag || !drawerEl.hidden) return;
      pull();
    }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pull();
    });
  }

  async function logout() {
    prefs.view = 'dashboard';
    savePrefs();
    try {
      await fetch('/api/logout', { method: 'POST' });
    } catch {
      /* fall through to reload either way */
    }
    window.location.href = '/internal/login';
  }

  function startSessionRefresh() {
    let lastRefresh = 0;
    let leaving = false;
    setInterval(async () => {
      if (leaving || Date.now() - lastRefresh < SESSION_REFRESH_MS) return;
      lastRefresh = Date.now();
      try {
        const response = await fetch('/api/session', { method: 'POST' });
        if (response.status === 401) {
          leaving = true;
          logout();
        }
      } catch {
        /* next tick retries */
      }
    }, 15000);
  }

  /* ── events ── */

  const THEME_KEY = 'kb-theme';

  function syncThemeButton() {
    const light = document.documentElement.classList.contains('theme-light');
    document.getElementById('theme-toggle')?.setAttribute('aria-pressed', String(light));
  }

  function toggleTheme() {
    const light = document.documentElement.classList.toggle('theme-light');
    localStorage.setItem(THEME_KEY, light ? 'light' : 'dark');
    syncThemeButton();
  }

  function closeMenus(event) {
    if (profileMenuEl?.open && !profileMenuEl.contains(event.target)) profileMenuEl.open = false;
    if (ganttMenuEl?.open && !ganttMenuEl.contains(event.target)) ganttMenuEl.open = false;
    document.querySelectorAll('.filter-drop[open]').forEach((drop) => {
      if (!drop.contains(event.target)) drop.open = false;
    });
  }

  document.addEventListener('click', (event) => {
    const internalLink = event.target.closest('a[href^="/internal"]');
    if (internalLink && !plainClick(event)) return;
    closeMenus(event);

    const dashOwnerBtn = event.target.closest('[data-dash-owner]');
    if (dashOwnerBtn) {
      prefs.dashOwner = dashOwnerBtn.dataset.dashOwner;
      savePrefs();
      return render();
    }
    const owner = event.target.closest('[data-owner]');
    if (owner) {
      prefs.owner = owner.dataset.owner;
      savePrefs();
      return render();
    }
    const scope = event.target.closest('[data-scope]');
    if (scope) {
      if (scope.closest('#dash-scope')) prefs.dashScope = scope.dataset.scope === 'month' ? 'month' : 'week';
      else prefs.scope = scope.dataset.scope;
      savePrefs();
      return render();
    }
    const yearBtn = event.target.closest('[data-year]');
    if (yearBtn) {
      prefs.year = Number(yearBtn.dataset.year);
      savePrefs();
      centreOnToday = true;
      return render();
    }
    const zoomBtn = event.target.closest('[data-zoom]');
    if (zoomBtn) {
      prefs.zoom = zoomBtn.dataset.zoom;
      savePrefs();
      centreOnToday = true;
      return render();
    }

    const agendaNav = event.target.closest('[data-agenda-day]');
    if (agendaNav) {
      agendaDay = agendaNav.dataset.agendaDay === 'today'
        ? null
        : addDays(agendaDate(), agendaNav.dataset.agendaDay === 'next' ? 1 : -1);
      return renderAgenda();
    }
    const calNav = event.target.closest('[data-cal]');
    if (calNav) {
      calMonth.setMonth(calMonth.getMonth() + (calNav.dataset.cal === 'next' ? 1 : -1));
      dayPanelOpen = false;
      return renderCalendar();
    }
    const dayBtn = event.target.closest('[data-day]');
    if (dayBtn) {
      const iso = dayBtn.dataset.day;
      if (dayPanelOpen && calSelected === iso) dayPanelOpen = false;
      else {
        calSelected = iso;
        dayPanelOpen = true;
      }
      return renderCalendar();
    }
    if (event.target.closest('[data-action="close-day"]')) {
      dayPanelOpen = false;
      return renderCalendar();
    }
    if (dayPanelOpen && !event.target.closest('.day-panel')) {
      dayPanelOpen = false;
      renderCalendar();
    }

    const agendaOpen = event.target.closest('[data-agenda-task]');
    if (agendaOpen) {
      const task = findTask(agendaOpen.dataset.agendaTask);
      if (!task) return;
      selectedId = task.id;
      openDrawer('task', task.id);
      const action = task.actions[Number(agendaOpen.dataset.index)];
      if (!action) return;
      sortActions(task);
      const index = task.actions.indexOf(action);
      openActions.add(index);
      return renderTaskDrawer(task, `[data-action-open="${index}"]`);
    }
    const dashToggle = event.target.closest('#task-list [data-dash-toggle]');
    if (dashToggle) {
      const id = dashToggle.dataset.dashToggle;
      if (isTaskSecondClick(id)) {
        selectedId = id;
        return openDrawer('task', id);
      }
      if (dashOpen.has(id)) dashOpen.delete(id);
      else {
        dashOpen.add(id);
        markTaskClick(id);
      }
      return renderTaskList();
    }
    const dashItem = event.target.closest('#task-list [data-id]');
    if (dashItem) {
      selectedId = dashItem.dataset.id;
      return openDrawer('task', dashItem.dataset.id);
    }

    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'discard-task') return resolveLeave(false);
    if (action === 'save-and-close-task') return resolveLeave(true);
    if (action === 'expand-gantt') {
      event.preventDefault();
      setView('gantt');
    }
    if (action === 'collapse-gantt') {
      event.preventDefault();
      setView('dashboard');
    }
    if (action === 'open-contacts') {
      event.preventDefault();
      window.KBContacts?.openList?.();
      setView('contacts');
    }
    if (action === 'toggle-theme') toggleTheme();
    if (action === 'open-profile') openDrawer('profile');
    if (action === 'add-task') addTask('');
    if (action === 'add-dash-task') addTask('', dashOwner());
    if (action === 'add-dash-action') openNewAction();
    if (action === 'new-actions') {
      newActionsOpen = !newActionsOpen;
      refreshNewActions();
    }
    if (action === 'close-new-actions') closeNewActions();
    if (action === 'open-pending') {
      const button = event.target.closest('[data-action="open-pending"]');
      const opened = window.KBContacts?.openPending?.(button?.dataset.contact, button?.dataset.note, Number(button?.dataset.index));
      closeNewActions();
      if (opened) setView('contacts');
    }
    if (action === 'add-category') addCategory();
    if (action === 'export') exportJson();
    if (action === 'export-pdf') exportPdf();
    if (action === 'export-excel') exportExcel();
    if (action === 'import') importFile.click();
    if (action === 'reset') reloadProgramme();
    if (action === 'logout') logout();
    if (profileMenuEl) profileMenuEl.open = false;
    if (ganttMenuEl) ganttMenuEl.open = false;
  });

  dashboardEl.addEventListener('change', (event) => {
    const box = event.target.closest('[data-agenda-toggle]');
    if (!box) return;
    const task = findTask(box.dataset.agendaToggle);
    const action = task?.actions[Number(box.dataset.index)];
    if (!action || !canEditAction(task, action)) {
      box.checked = Boolean(action?.done);
      return;
    }
    action.done = box.checked;
    action.status = action.done ? 'Done' : 'Not started';
    save(task.id);

    const item = box.closest('.agenda-item');
    item.classList.toggle('is-done', action.done);
    if (item.leaveTimer) {
      clearTimeout(item.leaveTimer);
      item.leaveTimer = null;
      agendaLeaving -= 1;
    }
    if (!action.done || item.closest('[data-keeps-done]')) {
      if (!agendaLeaving) render();
      return;
    }

    agendaLeaving += 1;
    item.leaveTimer = setTimeout(() => {
      item.leaveTimer = null;
      item.style.height = `${item.offsetHeight}px`;
      void item.offsetHeight;
      item.classList.add('is-leaving');
      item.style.height = '0px';
      setTimeout(() => {
        agendaLeaving -= 1;
        if (!agendaLeaving) render();
      }, 340);
    }, 650);
  });

  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      prefs.search = searchEl.value;
      savePrefs();
      render();
    }, 160);
  });

  ganttEl.addEventListener('click', (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const catEdit = event.target.closest('[data-cat-edit]');
    if (catEdit) {
      openDrawer('category', catEdit.dataset.catEdit);
      return;
    }
    const cat = event.target.closest('[data-cat]');
    if (cat) {
      toggleCategory(cat.dataset.cat);
      return;
    }
    if (event.target.closest('.handle')) return;
    const dropEmpty = event.target.closest('.gantt-drop [data-id]');
    if (dropEmpty) {
      openDrawer('task', dropEmpty.dataset.id);
      return;
    }
    if (event.target.closest('.gantt-drop')) return;
    const bar = event.target.closest('.bar');
    if (bar) {
      paintSelection(bar.dataset.id);
      return;
    }
    const side = event.target.closest('.task-side');
    if (side) {
      const id = side.dataset.id;
      if (isTaskSecondClick(id)) {
        openDrawer('task', id);
        return;
      }
      if (ganttOpen.has(id)) {
        ganttOpen.delete(id);
        return renderGantt();
      }
      ganttOpen.add(id);
      markTaskClick(id);
      selectTask(id, true);
    }
  });

  ganttEl.addEventListener('dblclick', (event) => {
    const hit = event.target.closest('.task-side, .bar, .task-track');
    if (!hit?.dataset.id) return;
    paintSelection(hit.dataset.id);
    openDrawer('task', hit.dataset.id);
  });

  ganttEl.addEventListener('pointerdown', (event) => {
    const bar = event.target.closest('.bar');
    if (!bar) return;
    const task = findTask(bar.dataset.id);
    if (!task || !task.start || !task.end || !canEditTask(task)) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const handle = event.target.closest('.handle');
    drag = {
      mode: handle ? handle.dataset.edge : 'move',
      taskId: task.id,
      startX: event.clientX,
      origStart: task.start,
      origEnd: task.end,
      origLeft: parseFloat(bar.style.left) || 0,
      origWidth: parseFloat(bar.style.width) || pxPerDay,
      bar,
      moved: false,
      pointerId: event.pointerId
    };
  });

  ganttEl.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const shift = event.clientX - drag.startX;
    const delta = Math.round(shift / pxPerDay);
    if (!drag.moved && Math.abs(shift) < 2) return;
    if (!drag.moved) {
      drag.moved = true;
      try {
        drag.bar.setPointerCapture(drag.pointerId);
      } catch {
        /* pointer may already be released */
      }
    }
    const task = findTask(drag.taskId);
    if (!task) return;
    const minWidth = Math.max(4, pxPerDay);
    let left = drag.origLeft;
    let width = drag.origWidth;
    if (drag.mode === 'move') {
      const length = daysBetween(drag.origStart, drag.origEnd);
      task.start = addDays(drag.origStart, delta);
      task.end = addDays(task.start, length);
      left = drag.origLeft + shift;
    } else if (drag.mode === 'start') {
      task.start = addDays(drag.origStart, delta);
      if (task.start > drag.origEnd) task.start = drag.origEnd;
      const used = Math.min(shift, drag.origWidth - minWidth);
      left = drag.origLeft + used;
      width = Math.max(minWidth, drag.origWidth - used);
      task.end = drag.origEnd;
    } else {
      task.end = addDays(drag.origEnd, delta);
      if (task.end < drag.origStart) task.end = drag.origStart;
      width = Math.max(minWidth, drag.origWidth + shift);
      task.start = drag.origStart;
    }
    drag.bar.style.left = `${left}px`;
    drag.bar.style.width = `${width}px`;
  });

  function endDrag() {
    if (!drag) return;
    const { moved, taskId } = drag;
    drag = null;
    if (!moved) return;
    suppressClick = true;
    save(taskId);
    selectedId = taskId;
    render();
  }

  ganttEl.addEventListener('pointerup', endDrag);
  ganttEl.addEventListener('pointercancel', endDrag);

  drawerEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.classList.contains('action-name')) return;
    event.preventDefault();
    const index = Number(event.target.closest('.action-item')?.dataset.index);
    editingAction = null;
    const task = findTask(drawerId);
    if (task) renderTaskDrawer(task, `.action-item[data-index="${index}"] [data-action="edit-action"]`);
  });

  drawerEl.addEventListener('input', (event) => {
    if (event.target.matches('input[type="date"]')) return;
    if (event.target.closest('.action-list')) return applyActionDraft(event.target);
  });

  drawerEl.addEventListener('change', (event) => {
    if (event.target.closest('.action-list')) return applyActionDraft(event.target);
    if (drawerKind === 'new-action' && event.target.id === 'new-action-phase') {
      readNewActionDraft();
      renderNewActionDrawer('#new-action-task');
    }
  });

  drawerEl.addEventListener('keydown', (event) => {
    if (drawerKind !== 'new-action' || event.key !== 'Enter' || event.target.id !== 'new-action-text') return;
    event.preventDefault();
    commitNewAction();
  });

  drawerEl.addEventListener('click', (event) => {
    const openBtn = event.target.closest('[data-action-open]');
    if (openBtn) return toggleActionDetail(Number(openBtn.dataset.actionOpen));
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'add-action') addAction();
    if (action === 'edit-action') editActionName(Number(event.target.closest('[data-index]')?.dataset.index));
    if (action === 'delete-action') deleteAction(Number(event.target.closest('[data-index]')?.dataset.index));
    if (action === 'close-drawer') closeDrawer();
    if (action === 'save-task') saveTaskEdits();
    if (action === 'save-new-action') commitNewAction();
    if (action === 'save-category') saveCategoryEdits();
    if (action === 'open-general') openGeneral(drawerId);
    if (action === 'save-profile') applyProfileDraft();
    if (action === 'delete-task') deleteTask();
    if (action === 'delete-category') deleteCategory();
    if (action === 'cat-up') moveCategory(-1);
    if (action === 'cat-down') moveCategory(1);
    if (action === 'send-reset-link') sendResetLink();
    if (action === 'setup-passkey') setupPasskey();
  });

  backdropEl.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (leavePromptOpen) {
        cancelLeavePrompt();
        return;
      }
      if (newActionsOpen) {
        closeNewActions();
        return;
      }
      const openDrop = document.querySelector('.filter-drop[open]');
      if (openDrop) {
        openDrop.open = false;
        return;
      }
      if (dayPanelOpen) {
        dayPanelOpen = false;
        renderCalendar();
        return;
      }
      if (!drawerEl.hidden) closeDrawer();
      return;
    }
    if (event.target.matches('input, textarea, select')) return;
    if (event.key === '/' && searchEl && !ganttEl.hidden) {
      event.preventDefault();
      searchEl.focus();
    }
  });

  importFile.addEventListener('change', () => {
    const file = importFile.files[0];
    importFile.value = '';
    if (file) importJson(file);
  });

  async function detectPlace() {
    const placeEl = document.getElementById('local-place');
    const endpoints = ['https://ipwho.is/', 'https://get.geojs.io/v1/ip/geo.json'];
    for (const url of endpoints) {
      try {
        const response = await fetch(url);
        const data = await response.json();
        const city = data.city || data.region;
        const country = data.country || data.country_name;
        if (city && country) {
          placeLabel = `${city}, ${country}`;
          if (placeEl) placeEl.textContent = placeLabel;
          return;
        }
      } catch {
        /* try the next lookup */
      }
    }
    placeLabel = timezoneFallback();
    if (placeEl) placeEl.textContent = placeLabel;
  }

  async function openWorkspace() {
    if (!localStorage.getItem(STORAGE_KEY)) {
      try {
        const packed = await window.KB_STATE_PROMISE;
        const remote = packed?.status === 200 ? packed.body : null;
        if (remote?.state && Array.isArray(remote.state.tasks)) {
          serverVersion = remote.updatedAt || 0;
          queueSharedOwners(remote.state);
          state = normaliseState(remote.state);
          cache();
          syncMode = 'shared';
        }
      } catch {
        /* pull() retries once the page is open */
      }
    }
    if (shellView() === 'dashboard') showOwnWeek();
    render();
    syncThemeButton();
    detectPlace();
  }

  function ownerKeyFrom(value) {
    const raw = String(value || '').trim().toLowerCase();
    const person = Object.values(PEOPLE).find((item) => (
      item.ownerKey.toLowerCase() === raw
      || item.firstName.toLowerCase() === raw
      || item.name.toLowerCase() === raw
      || item.email.split('@')[0] === raw
    ));
    return person ? person.ownerKey : singleOwner(value);
  }

  /* Contacts notes file a follow-up onto a programme task, or create the task. */
  document.getElementById('new-actions-layer')?.addEventListener('click', (event) => {
    if (event.target.id === 'new-actions-layer') closeNewActions();
  });

  leaveTaskLayer?.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'discard-task') {
      event.stopPropagation();
      resolveLeave(false);
    }
    if (action === 'save-and-close-task') {
      event.stopPropagation();
      resolveLeave(true);
    }
  });

  window.KBLeave = {
    ask(onChoice, onCancel) {
      showLeavePrompt(onChoice, onCancel);
    }
  };
  window.KBDashboard = { refreshNewActions };
  window.KBProgramme = {
    categories() {
      return accessiblePhases().map((phase) => ({ id: phase.id, name: phase.name }));
    },
    tasksIn(phaseId) {
      const tasks = state.tasks
        .filter((task) => !task.general && (task.phaseId || '') === String(phaseId || ''))
        .map((task) => ({ id: task.id, title: task.title }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
      if (!phaseId) return tasks;
      return [{ id: generalTask(phaseId)?.id || GENERAL_CHOICE, title: 'Category only (no task)' }, ...tasks];
    },
    ownerMenu(selected) {
      return ownerOptions(ownerKeyFrom(selected));
    },
    readAction(taskId, actionId) {
      const task = findTask(taskId);
      if (!task) return null;
      const action = actionId ? task.actions.find((item) => item.id === actionId) : null;
      if (!action) return { phaseId: task.phaseId || '', taskId: task.id, missing: true };
      return {
        phaseId: task.phaseId || '',
        taskId: task.id,
        actionId: action.id || '',
        actionName: action.text,
        owner: action.owner || task.owner,
        due: action.due || '',
        notes: action.notes || ''
      };
    },
    deleteAction(taskId, actionId, text) {
      const task = findTask(taskId);
      if (!task) return;
      const before = task.actions.length;
      task.actions = task.actions.filter((item) => (
        actionId ? item.id !== actionId : item.text !== text
      ));
      if (task.actions.length !== before) save(task.id);
    },
    attachAction(input) {
      if (!canAddTasks()) return { error: 'Only Alex, Sam and programme coordinators can add a task.' };
      const title = String(input?.actionText || '').trim().slice(0, 160);
      if (!title) return { error: 'The action needs a name.' };
      const due = /^\d{4}-\d{2}-\d{2}$/.test(input?.due || '') ? input.due : '';
      const owner = ownerKeyFrom(input?.owner);
      const notes = String(input?.notes || '').trim().slice(0, 4000);
      const newTitle = String(input?.newTaskTitle || '').trim().slice(0, 160);
      const actionId = String(input?.actionId || '').trim();
      let fromTask = null;
      let existingAction = null;
      if (actionId) {
        for (const candidate of state.tasks) {
          const found = candidate.actions.find((item) => item.id === actionId);
          if (found) {
            fromTask = candidate;
            existingAction = found;
            break;
          }
        }
      }
      let task = newTitle ? null : (input?.taskId ? findTask(input.taskId) : null);
      let created = false;
      if (!task && !newTitle && input?.taskId === GENERAL_CHOICE) {
        if (!input?.phaseId || !findPhase(input.phaseId) || !canUsePhase(input.phaseId)) {
          return { error: coordinatorScope() ? 'Choose a category you oversee.' : 'Choose a category first.' };
        }
        created = !generalTask(input.phaseId);
        task = ensureGeneralTask(input.phaseId);
      }
      if (!task) {
        if (!newTitle) return { error: 'Choose a task, or type a new one.' };
        if (!input?.phaseId || !findPhase(input.phaseId) || !canUsePhase(input.phaseId)) {
          return { error: coordinatorScope() ? 'Choose a category you oversee.' : 'Choose a category first.' };
        }
        const taskOwner = ownerKeyFrom(input?.taskOwner) || owner;
        const start = /^\d{4}-\d{2}-\d{2}$/.test(input?.start || '') ? input.start : today();
        let end = /^\d{4}-\d{2}-\d{2}$/.test(input?.end || '') ? input.end : (due || start);
        if (end < start) end = start;
        task = normaliseTask({
          id: uid(),
          title: newTitle,
          notes: String(input?.taskNotes || '').trim().slice(0, 4000),
          status: STATUS_LABEL[input?.status] ? input.status : 'todo',
          start,
          end,
          owner: taskOwner
        });
        assignTaskToPhase(task, input.phaseId);
        state.tasks.unshift(task);
        created = true;
      }
      if (!existingAction && input?.update && !newTitle) {
        existingAction = task.actions.find((item) => item.text === title) || null;
        if (existingAction) fromTask = task;
      }
      if (existingAction && fromTask && fromTask !== task) {
        fromTask.actions = fromTask.actions.filter((item) => item !== existingAction);
      }
      if (existingAction) {
        if (!existingAction.id) existingAction.id = uid();
        existingAction.text = title;
        existingAction.due = due;
        existingAction.week = due ? weekLabel(due) : '';
        existingAction.notes = notes;
        existingAction.owner = owner || existingAction.owner || task.owner;
        if (!task.actions.includes(existingAction)) task.actions.push(existingAction);
        sortActions(task);
        save(created || (fromTask && fromTask !== task) ? 'all' : task.id);
        return { taskId: task.id, actionId: existingAction.id, title: task.title };
      }
      const action = {
        id: uid(),
        week: due ? weekLabel(due) : '',
        text: title,
        status: 'Not started',
        done: false,
        due,
        notes,
        owner: owner || task.owner
      };
      task.actions.push(action);
      sortActions(task);
      save(created ? 'all' : task.id);
      return { taskId: task.id, actionId: action.id, title: task.title };
    }
  };

  openWorkspace().then(() => {
    setInterval(() => {
      if (document.hidden || prefs.view !== 'dashboard') return;
      renderGreeting();
      renderLocalMeta();
    }, 1000);
    setSyncStatus(syncMode === 'shared' ? 'synced' : 'checking');
    startSync();
    fetchProfile();
    startSessionRefresh();
    setTimeout(() => { suppressHistory = false; }, 0);
  });
})();
