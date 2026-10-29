import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyDraft,
  chooseLead,
  contactsMatching,
  gmailThreadDraft,
  granolaDraft,
  isDue,
  listDue,
  mergeCronNotes,
  mergeTasks,
  recentAfterSeconds,
  findRecentNotes,
  runContactNotes,
  writeNextNote,
  snapshotInteractions,
  syncResultMessage
} from './contact-notes.js';
import { normalizeContact } from './contacts.js';

function b64url(text) {
  return Buffer.from(text).toString('base64url');
}

function message({ id, at, messageId, from, to, subject, body, labels }) {
  return {
    id,
    internalDate: String(at),
    labelIds: labels,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Message-ID', value: messageId },
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject }
      ],
      body: { data: b64url(body) }
    }
  };
}

const team = new Map([
  ['alex@example.org', 'alex'],
  ['sam@example.org', 'sam']
]);

test('a thread is stored only when a participant email is on the contact', () => {
  const state = {
    contacts: [
      { id: 'c1', name: 'Olena Kovalenko', emails: ['olena@museum.example'], interactions: [], dismissedKeys: [] },
      { id: 'c2', name: 'Museum of Modern Art', emails: [], interactions: [], dismissedKeys: [] }
    ]
  };
  const draft = {
    source: 'gmail',
    sourceKey: '<first@museum.example>',
    date: '2026-01-02',
    lead: 'alex',
    participants: ['olena@museum.example', 'alex@example.org'],
    activityAt: '2026-01-02T10:00:00.000Z',
    seenHash: 'm1',
    threadUser: 'alex',
    threadId: 'thread-a'
  };
  assert.equal(contactsMatching(state.contacts, ['Museum of Modern Art']).length, 0);
  assert.deepEqual(contactsMatching(state.contacts, draft.participants).map((item) => item.id), ['c1']);
  applyDraft(state, draft);
  applyDraft(state, { ...draft, threadId: 'thread-from-other-mailbox', seenHash: 'm1' });
  assert.equal(state.contacts[0].interactions.length, 1);
  assert.equal(state.contacts[0].interactions[0].sourceKey, '<first@museum.example>');
  assert.equal(state.contacts[1].interactions.length, 0);
  applyDraft(state, { ...draft, sourceKey: '<other@museum.example>', participants: ['nobody@example.com'] });
  assert.equal(state.contacts[0].interactions.length, 1);
});

test('the lead is the team member who sent the most, and a tie uses the first sender', () => {
  assert.equal(chooseLead([
    { from: 'sam@example.org', at: 2 },
    { from: 'alex@example.org', at: 3 },
    { from: 'alex@example.org', at: 4 }
  ], team), 'alex');
  assert.equal(chooseLead([
    { from: 'guest@example.com', at: 1 },
    { from: 'sam@example.org', at: 2 },
    { from: 'alex@example.org', at: 3 }
  ], team), 'sam');
});

test('gmail sourceKey is the first message id, and a new message makes a written note due', () => {
  const firstAt = Date.parse('2026-01-01T09:00:00.000Z');
  const lastAt = Date.parse('2026-01-02T09:00:00.000Z');
  const thread = {
    id: 'thread-xyz',
    historyId: '99',
    messages: [
      message({
        id: 'later',
        at: lastAt,
        messageId: '<later@museum.example>',
        from: 'Alex Admin <alex@example.org>',
        to: 'Olena <olena@museum.example>',
        subject: 'Re: residency',
        body: 'Confirmed.\n\nOn 1 Jan 2026 Olena wrote:\n> original offer'
      }),
      message({
        id: 'earlier',
        at: firstAt,
        messageId: '<First@museum.example>',
        from: 'Olena <olena@museum.example>',
        to: 'alex@example.org',
        subject: 'residency',
        body: 'The Kyiv residency starts on 3 March 2026.'
      })
    ]
  };
  const draft = gmailThreadDraft(thread, team);
  assert.equal(draft.sourceKey, '<first@museum.example>');
  assert.notEqual(draft.sourceKey, 'thread-xyz');
  assert.equal(draft.lead, 'alex');
  assert.match(draft.sourceText, /Kyiv residency starts on 3 March 2026/);
  assert.doesNotMatch(draft.sourceText, /original offer/);
  assert.equal(draft.date, '2026-01-02');

  const hour = 60 * 60 * 1000;
  const interaction = {
    source: 'gmail',
    status: 'pending',
    activityAt: draft.activityAt,
    seenHash: draft.seenHash,
    sourceHash: ''
  };
  assert.equal(isDue(interaction, lastAt + hour), true);
  interaction.status = 'written';
  interaction.sourceHash = draft.seenHash;
  assert.equal(isDue(interaction, lastAt + hour), false);
  interaction.seenHash = `${draft.seenHash},new`;
  assert.equal(isDue(interaction, lastAt + hour), true);
  interaction.status = 'skipped';
  assert.equal(isDue(interaction, lastAt + hour * 48), false);

  assert.equal(gmailThreadDraft({ id: 'thread-no-id', messages: [message({
    id: 'm',
    at: firstAt,
    messageId: '',
    from: 'a@b.example',
    to: 'c@d.example',
    subject: 'Hi',
    body: 'Hello'
  })] }, team), null);
});

test('an unsent draft is not an interaction note, and a draft reply is left out of a sent thread', () => {
  const at = Date.parse('2026-06-01T08:00:00.000Z');
  const draftOnly = gmailThreadDraft({
    id: 'thread-draft',
    historyId: '1',
    messages: [message({
      id: 'draft-1',
      at,
      messageId: '<draft@museum.example>',
      from: 'Alex Admin <alex@example.org>',
      to: 'Olena <olena@museum.example>',
      subject: 'Draft',
      body: 'Still writing this.',
      labels: ['DRAFT']
    })]
  }, team);
  assert.equal(draftOnly, null);

  const mixed = gmailThreadDraft({
    id: 'thread-mixed',
    historyId: '2',
    messages: [
      message({
        id: 'sent-1',
        at,
        messageId: '<sent@museum.example>',
        from: 'Olena <olena@museum.example>',
        to: 'Alex Admin <alex@example.org>',
        subject: 'Catalogue',
        body: 'The June catalogue is confirmed.'
      }),
      message({
        id: 'draft-2',
        at: at + 60_000,
        messageId: '<reply-draft@museum.example>',
        from: 'Alex Admin <alex@example.org>',
        to: 'Olena <olena@museum.example>',
        subject: 'Re: Catalogue',
        body: 'Unsent reply that should stay in drafts.',
        labels: ['DRAFT']
      })
    ]
  }, team);
  assert.equal(mixed.sourceKey, '<sent@museum.example>');
  assert.match(mixed.sourceText, /June catalogue is confirmed/);
  assert.doesNotMatch(mixed.sourceText, /Unsent reply/);
});

test('a 25-message thread keeps its first and last 5 messages intact', () => {
  const messages = [];
  for (let i = 0; i < 25; i += 1) {
    const kind = i === 0 ? 'FIRST' : i >= 20 ? 'TAIL' : 'MIDDLE';
    messages.push(message({
      id: `m${i}`,
      at: Date.parse('2026-01-01T00:00:00.000Z') + i * 60_000,
      messageId: `<m${i}@museum.example>`,
      from: i % 2 ? 'Alex Admin <alex@example.org>' : 'Olena <olena@museum.example>',
      to: 'alex@example.org',
      subject: `residency ${i}`,
      body: [`${kind}-${i}-OPEN`, 'x'.repeat(1800), `${kind}-${i}-CLOSE`].join('\n')
    }));
  }
  const draft = gmailThreadDraft({ id: 'thread-long', historyId: '1', messages }, team);
  assert.match(draft.sourceText, /FIRST-0-OPEN/);
  assert.match(draft.sourceText, /FIRST-0-CLOSE/);
  assert.match(draft.sourceText, /\[19 earlier messages shortened\]/);
  assert.match(draft.sourceText, /MIDDLE-1-OPEN/);
  assert.match(draft.sourceText, /MIDDLE-19-OPEN/);
  assert.doesNotMatch(draft.sourceText, /MIDDLE-1-CLOSE/);
  assert.doesNotMatch(draft.sourceText, /MIDDLE-19-CLOSE/);
  for (let i = 20; i < 25; i += 1) {
    assert.match(draft.sourceText, new RegExp(`TAIL-${i}-OPEN`));
    assert.match(draft.sourceText, new RegExp(`TAIL-${i}-CLOSE`));
  }
  assert.ok(draft.sourceText.indexOf('TAIL-24-CLOSE') > draft.sourceText.indexOf('TAIL-20-OPEN'));
  assert.ok(draft.sourceText.indexOf('FIRST-0-OPEN') < draft.sourceText.indexOf('[19 earlier messages shortened]'));
});

test('a Granola note with enhanced notes uses them over summary_text', () => {
  const ending = 'END-OF-ENHANCED-NOTE Olena confirmed the catalogue on 2 June 2026.';
  const summaryMarkdown = `${'## Enhanced notes\n\nThe meeting covered the Kyiv residency.\n'.repeat(400)}${ending}`;
  const draft = granolaDraft({
    id: 'not_1d3tmYTlCICgjy',
    title: 'Studio visit',
    created_at: '2026-05-14T10:00:00.000Z',
    owner: { name: 'Alex Admin', email: 'alex@example.org' },
    attendees: [{ name: 'Olena Kovalenko', email: 'olena@museum.example' }],
    summary_text: 'Do not use this plain summary.',
    summary_markdown: summaryMarkdown,
    private_notes_markdown: '- Ask about the Leistungsvereinbarung'
  }, team);
  assert.equal(draft.sourceField, 'private_notes_markdown+summary_markdown');
  assert.match(draft.sourceText, /Leistungsvereinbarung/);
  assert.match(draft.sourceText, /END-OF-ENHANCED-NOTE Olena confirmed the catalogue on 2 June 2026/);
  assert.match(draft.sourceText, /Kyiv residency/);
  assert.doesNotMatch(draft.sourceText, /Do not use this plain summary/);
  const state = {
    contacts: [{ id: 'c1', emails: ['olena@museum.example'], interactions: [], dismissedKeys: [] }]
  };
  applyDraft(state, draft);
  assert.equal(state.contacts[0].interactions[0].sourceField, 'private_notes_markdown+summary_markdown');
});

test('a Granola meeting is filed on the guest, not on Alex or Sam', () => {
  const draft = granolaDraft({
    id: 'not_abcdef12345678',
    title: 'Kyiv residency dates agreed with Olena',
    created_at: '2026-10-13T10:00:00.000Z',
    owner: { name: 'Alex Admin', email: 'alex@example.org' },
    attendees: [{ name: 'Sam Manager', email: 'sam@example.org' }],
    calendar_event: {
      event_title: 'Studio visit',
      organiser: 'alex@example.org',
      invitees: [{ email: 'olena@museum.example' }]
    },
    summary_markdown: '## Enhanced\n\nOlena confirmed the Kyiv residency for 2 June 2026. The catalogue will follow.'
  }, team);
  assert.match(draft.sourceText, /enhanced summary/i);
  assert.match(draft.sourceText, /Olena confirmed the Kyiv residency for 2 June 2026/);
  assert.equal(draft.meetingTitle, 'Kyiv residency dates agreed with');
  assert.ok(draft.participants.includes('olena@museum.example'));
  const state = {
    contacts: [
      { id: 'alex', name: 'Alex Admin', emails: ['alex@example.org'], interactions: [], dismissedKeys: [] },
      { id: 'sam', name: 'Sam Manager', emails: ['personal@example.com'], interactions: [], dismissedKeys: [] },
      { id: 'olena', name: 'Olena Kovalenko', emails: ['olena@museum.example'], interactions: [], dismissedKeys: [] }
    ]
  };
  applyDraft(state, draft);
  assert.equal(state.contacts[0].interactions.length, 0);
  assert.equal(state.contacts[1].interactions.length, 0);
  assert.equal(state.contacts[2].interactions.length, 1);
  assert.equal(state.contacts[2].interactions[0].title, '');
  assert.equal(state.contacts[2].interactions[0].lead, 'alex');
});

test('a Granola note without an enhanced summary is not written from the title alone', () => {
  const draft = granolaDraft({
    id: 'not_abcdef12345678',
    title: 'Granola',
    owner: { name: 'Alex Admin', email: 'alex@example.org' },
    attendees: [{ name: 'Olena', email: 'olena@museum.example' }]
  }, team);
  assert.equal(draft.sourceText, '');
  assert.equal(draft.meetingTitle, '');
});

test('interaction notes that were never written are dropped from internal profiles', () => {
  const pending = {
    id: 'n1',
    source: 'granola',
    sourceKey: 'not_abcdef12345678',
    status: 'pending',
    summary: ''
  };
  const written = { ...pending, id: 'n2', status: 'written', summary: 'A written note.' };
  assert.equal(normalizeContact({ id: 's', name: 'Alex Admin', emails: ['alex@example.org'], interactions: [pending, written] }).interactions.length, 1);
  assert.equal(normalizeContact({ id: 'k', name: 'Taylor Kim', emails: ['taylor@example.org'], interactions: [pending] }).interactions.length, 0);
  assert.equal(normalizeContact({ id: 'f', name: 'Sam Manager', emails: [], interactions: [pending] }).interactions.length, 0);
  assert.equal(normalizeContact({ id: 'o', name: 'Olena Kovalenko', emails: ['olena@museum.example'], interactions: [pending] }).interactions.length, 1);
});

test('an internal-only thread creates no note and is not attached to a platform user', () => {
  const thread = {
    id: 'thread-internal',
    historyId: '1',
    messages: [message({
      id: 'm',
      at: Date.parse('2026-06-01T08:00:00.000Z'),
      messageId: '<internal@example.org>',
      from: 'Alex Admin <alex@example.org>',
      to: 'Taylor Kim <taylor@example.org>',
      subject: 'Internal',
      body: 'See you at the office.'
    })]
  };
  assert.equal(gmailThreadDraft(thread, team), null);
  const state = {
    contacts: [
      { id: 'alex', name: 'Alex Admin', emails: ['alex@example.org'], interactions: [], dismissedKeys: [] },
      { id: 'guest', name: 'Olena Kovalenko', emails: ['olena@museum.example'], interactions: [], dismissedKeys: [] }
    ]
  };
  const draft = {
    source: 'gmail',
    sourceKey: '<mixed@museum.example>',
    participants: ['olena@museum.example', 'alex@example.org'],
    date: '2026-06-01'
  };
  applyDraft(state, draft);
  assert.equal(state.contacts[0].interactions.length, 0);
  assert.equal(state.contacts[1].interactions.length, 1);
});

test('a rewrite keeps validated actions and replaces the suggestions', () => {
  const existing = [
    { text: 'Send the catalogue', owner: 'Alex', due: '2026-06-02', programmeTaskId: 't1', programmeActionId: 'a1' },
    { text: 'Book the venue', owner: 'Olena' },
    { text: 'Call the funder', owner: '' }
  ];
  const extracted = [
    { text: 'Please send the catalogue by Friday', owner: 'Someone else' },
    { text: 'Confirm the print run', owner: 'Olena' },
    { text: 'Book the venue for June', owner: 'Olena' }
  ];
  const merged = mergeTasks(existing, extracted);
  assert.deepEqual(merged[0], existing[0]);
  assert.deepEqual(merged.map((task) => task.text), [
    'Send the catalogue',
    'Confirm the print run',
    'Book the venue for June'
  ]);
  assert.equal(merged[1].programmeTaskId, undefined);
});

test('a validation made while the cron is writing survives the save', () => {
  const beforeNote = {
    id: 'n1',
    source: 'gmail',
    sourceKey: '<m@museum.example>',
    status: 'written',
    summary: 'Old summary.',
    title: '',
    tasks: [
      { text: 'Send the catalogue', owner: 'Alex' },
      { text: 'Book the venue', owner: 'Olena' }
    ],
    seenHash: 'm1',
    sourceHash: 'm1'
  };
  const cronState = {
    contacts: [{
      id: 'c1',
      interactions: [{
        ...beforeNote,
        summary: 'Olena confirmed the June catalogue.',
        seenHash: 'm1,m2',
        sourceHash: 'm1,m2',
        title: 'June catalogue dates confirmed',
        tasks: mergeTasks(beforeNote.tasks, [
          { text: 'Send the catalogue tomorrow', owner: 'Alex' },
          { text: 'Confirm the print run', owner: 'Olena' }
        ])
      }]
    }]
  };
  const fresh = {
    contacts: [{
      id: 'c1',
      interactions: [{
        ...beforeNote,
        tasks: [
          { text: 'Send the catalogue', owner: 'Alex', due: '2026-06-02', programmeTaskId: 't1', programmeActionId: 'a1' },
          { text: 'Book the venue', owner: 'Olena' }
        ]
      }, {
        id: 'n-user',
        source: 'gmail',
        sourceKey: '<other@museum.example>',
        status: 'pending',
        summary: ''
      }]
    }]
  };
  const snapshot = snapshotInteractions({
    contacts: [{ id: 'c1', interactions: [beforeNote] }]
  });
  mergeCronNotes(fresh, cronState, snapshot);
  const note = fresh.contacts[0].interactions[0];
  assert.equal(note.summary, 'Olena confirmed the June catalogue.');
  assert.equal(note.title, 'June catalogue dates confirmed');
  assert.deepEqual(note.tasks[0], {
    text: 'Send the catalogue',
    owner: 'Alex',
    due: '2026-06-02',
    programmeTaskId: 't1',
    programmeActionId: 'a1'
  });
  assert.equal(note.tasks[1].text, 'Confirm the print run');
  assert.equal(note.tasks.some((task) => task.text === 'Book the venue'), false);
  assert.equal(fresh.contacts[0].interactions.some((item) => item.id === 'n-user'), true);
});

function gmailJson(data) {
  return { ok: true, status: 200, json: async () => data };
}

function fullThread({ id, historyId, from, to, subject, body, messageId }) {
  return {
    id,
    historyId,
    messages: [message({
      id: `${id}-m`,
      at: Date.parse('2026-06-01T08:00:00.000Z'),
      messageId,
      from,
      to,
      subject,
      body
    })]
  };
}

function connectedAlex() {
  return {
    alex: {
      refresh_token: 'refresh',
      access_token: 'token',
      expiry: Date.now() + 60 * 60 * 1000,
      email: 'alex@example.org'
    }
  };
}

test('a new thread for the last contact is picked up in the first run', async () => {
  const contacts = [];
  for (let i = 0; i < 12; i += 1) {
    contacts.push({
      id: `c${i}`,
      name: `Person ${i}`,
      emails: [`person${i}@museum.example`],
      interactions: [],
      dismissedKeys: []
    });
  }
  const state = { contacts, settings: {} };
  const queries = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const id = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    if (parsed.pathname.endsWith('/threads')) {
      const q = parsed.searchParams.get('q') || '';
      queries.push(q);
      if (q.includes('after:')) {
        return gmailJson({ threads: [{ id: 'thread-last', historyId: 'h-last' }] });
      }
      return gmailJson({
        threads: [1, 2, 3, 4].map((n) => ({ id: `noise-${n}`, historyId: `hn-${n}` }))
      });
    }
    if (id === 'thread-last') {
      return gmailJson(fullThread({
        id: 'thread-last',
        historyId: 'h-last',
        from: 'Last Person <person11@museum.example>',
        to: 'Alex Admin <alex@example.org>',
        subject: 'Catalogue',
        body: 'The June catalogue is confirmed.',
        messageId: '<last@museum.example>'
      }));
    }
    return gmailJson({ id, historyId: 'noise', messages: [] });
  };
  try {
    const result = await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: {},
      now: Date.parse('2026-06-01T12:00:00.000Z')
    });
    const last = state.contacts[state.contacts.length - 1];
    assert.equal(last.emails[0], 'person11@museum.example');
    assert.equal(last.interactions.length, 1);
    assert.equal(last.interactions[0].sourceKey, '<last@museum.example>');
    assert.equal(last.interactions[0].threadId, 'thread-last');
    assert.ok(result.cursor.contactIndex < state.contacts.length - 1);
    assert.equal(queries.some((q) => q.includes('after:') && q.includes('-in:spam') && q.includes('-in:drafts')), true);
    assert.equal(queries.some((q) => q.includes('person11@museum.example')), false);
  } finally {
    globalThis.fetch = original;
  }
});

test('a failed run keeps the last successful recent window', async () => {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const successAt = Date.parse('2026-06-01T12:00:00.000Z');
  const failedAt = successAt + 20 * day;
  const nextAt = failedAt + day;
  const state = {
    contacts: [{
      id: 'c0',
      name: 'Olena',
      emails: ['olena@museum.example'],
      interactions: [],
      dismissedKeys: []
    }],
    settings: {}
  };
  const original = globalThis.fetch;
  const queries = [];
  let failRecent = false;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (!parsed.pathname.endsWith('/threads')) return gmailJson({ id: 'x', messages: [] });
    const q = parsed.searchParams.get('q') || '';
    queries.push(q);
    if (q.includes('after:') && failRecent) throw new Error('gmail down');
    return gmailJson({ threads: [] });
  };
  try {
    const first = await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: {},
      now: successAt
    });
    assert.equal(first.cursor.lastRecentScanAt, new Date(successAt).toISOString());
    assert.equal(recentAfterSeconds('', successAt), Math.floor((successAt - day - hour) / 1000));

    failRecent = true;
    const failed = await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: first.cursor,
      now: failedAt
    });
    assert.equal(failed.cursor.lastRecentScanAt, new Date(successAt).toISOString());
    assert.ok(failed.stats.errors.some((item) => item.includes('gmail down')));

    failRecent = false;
    queries.length = 0;
    await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: failed.cursor,
      now: nextAt
    });
    const recent = queries.find((q) => q.includes('after:'));
    const used = Number(recent.match(/after:(\d+)/)[1]);
    const fromSuccess = Math.floor((successAt - hour) / 1000);
    const fromADayAgo = Math.floor((nextAt - day - hour) / 1000);
    assert.equal(used, fromSuccess);
    assert.notEqual(used, fromADayAgo);
  } finally {
    globalThis.fetch = original;
  }
});

test('a pending Granola note is written before the Gmail queue', () => {
  const due = listDue({
    contacts: [{
      id: 'c1',
      interactions: [
        { id: 'g', source: 'gmail', status: 'pending', activityAt: '2020-01-01T00:00:00.000Z' },
        { id: 'n', source: 'granola', status: 'pending', activityAt: '2026-10-13T00:00:00.000Z' }
      ]
    }]
  }, Date.parse('2026-10-15T00:00:00.000Z'));
  assert.equal(due[0].interaction.id, 'n');
});

test('every due note is written in one run', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const state = {
    contacts: [{
      id: 'c1',
      name: 'Olena Kovalenko',
      emails: ['olena@museum.example'],
      interactions: Array.from({ length: 10 }, (_, index) => ({
        id: `n${index}`,
        source: 'gmail',
        status: 'pending',
        sourceKey: `<m${index}@museum.example>`,
        threadUser: 'alex',
        threadId: `t${index}`,
        activityAt: '2026-06-01T07:00:00.000Z',
        participants: ['olena@museum.example', 'alex@example.org'],
        seenHash: `h${index}`,
        title: ''
      }))
    }],
    settings: {}
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('anthropic.com')) {
      const body = JSON.parse(init.body);
      const system = String(body.system || '');
      if (system.includes('classify')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify({ relevant: true }) }]
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'June catalogue dates confirmed',
              summary: 'Olena confirmed the June catalogue.',
              tasks: [{ text: 'Send the catalogue', owner: 'Olena' }],
              sourceLanguage: 'en'
            })
          }]
        })
      };
    }
    return gmailJson(fullThread({
      id: 't',
      historyId: 'h',
      from: 'Olena <olena@museum.example>',
      to: 'Alex Admin <alex@example.org>',
      subject: 'Catalogue',
      body: 'The June catalogue is confirmed.',
      messageId: '<m@museum.example>'
    }));
  };
  try {
    const result = await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: {},
      now: Date.parse('2026-06-01T08:00:00.000Z')
    });
    assert.equal(result.stats.written, 10);
    assert.equal(result.stats.remaining, 0);
    assert.equal(state.contacts[0].interactions.every((item) => item.status === 'written'), true);
    assert.equal(state.contacts[0].interactions[0].title, 'June catalogue dates confirmed');
  } finally {
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('a draft-only thread is removed instead of waiting to be written', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const state = {
    contacts: [{
      id: 'c1',
      name: 'Olena Kovalenko',
      emails: ['olena@museum.example'],
      interactions: [{
        id: 'n-draft',
        source: 'gmail',
        status: 'pending',
        sourceKey: '<draft@museum.example>',
        threadUser: 'alex',
        threadId: 't-draft',
        activityAt: '2026-06-01T07:00:00.000Z',
        participants: ['olena@museum.example', 'alex@example.org'],
        seenHash: 'draft',
        title: ''
      }]
    }],
    settings: {}
  };
  const original = globalThis.fetch;
  let anthropicCalls = 0;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('anthropic.com')) {
      anthropicCalls += 1;
      return { ok: true, status: 200, json: async () => ({ content: [] }) };
    }
    const parsed = new URL(href);
    const id = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    if (id === 't-draft') {
      return gmailJson({
        id: 't-draft',
        historyId: 'd1',
        messages: [message({
          id: 'draft-1',
          at: Date.parse('2026-06-01T08:00:00.000Z'),
          messageId: '<draft@museum.example>',
          from: 'Alex Admin <alex@example.org>',
          to: 'Olena <olena@museum.example>',
          subject: 'Draft',
          body: 'Still writing this.',
          labels: ['DRAFT']
        })]
      });
    }
    return gmailJson({ threads: [], messages: [] });
  };
  try {
    const result = await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: {},
      now: Date.parse('2026-06-02T08:00:00.000Z')
    });
    assert.equal(state.contacts[0].interactions.length, 0);
    assert.equal(anthropicCalls, 0);
    assert.equal(result.stats.written, 0);
  } finally {
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('a note found in the morning run is written then, before the older queue', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const state = {
    contacts: [{
      id: 'c1',
      name: 'Olena Kovalenko',
      emails: ['olena@museum.example'],
      interactions: [{
        id: 'n-old',
        source: 'gmail',
        status: 'pending',
        sourceKey: '<old@museum.example>',
        threadUser: 'alex',
        threadId: 't-old',
        activityAt: '2026-01-01T07:00:00.000Z',
        participants: ['olena@museum.example', 'alex@example.org'],
        seenHash: 'old',
        title: ''
      }]
    }],
    settings: {}
  };
  const original = globalThis.fetch;
  const realNow = Date.now;
  let anthropicCalls = 0;
  Date.now = () => (anthropicCalls >= 2 ? realNow() + 80_000 : realNow());
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('anthropic.com')) {
      const body = JSON.parse(init.body);
      const system = String(body.system || '');
      const payload = system.includes('classify')
        ? { relevant: true }
        : {
          title: 'June catalogue dates confirmed',
          summary: 'Olena confirmed the June catalogue.',
          tasks: [],
          sourceLanguage: 'en'
        };
      anthropicCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(payload) }]
        })
      };
    }
    const parsed = new URL(href);
    const id = decodeURIComponent(parsed.pathname.split('/').pop() || '');
    if (parsed.pathname.endsWith('/threads')) {
      const q = parsed.searchParams.get('q') || '';
      if (q.includes('after:')) return gmailJson({ threads: [{ id: 'thread-new', historyId: 'h-new' }] });
      return gmailJson({ threads: [] });
    }
    if (id === 'thread-new') {
      return gmailJson(fullThread({
        id: 'thread-new',
        historyId: 'h-new',
        from: 'Olena <olena@museum.example>',
        to: 'Alex Admin <alex@example.org>',
        subject: 'Catalogue',
        body: 'The June catalogue is confirmed.',
        messageId: '<new@museum.example>'
      }));
    }
    if (id === 't-old') {
      return gmailJson(fullThread({
        id: 't-old',
        historyId: 'h-old',
        from: 'Olena <olena@museum.example>',
        to: 'Alex Admin <alex@example.org>',
        subject: 'Older mail',
        body: 'An older message that is still waiting.',
        messageId: '<old@museum.example>'
      }));
    }
    return gmailJson({ id, historyId: 'noise', messages: [], notes: [] });
  };
  try {
    const result = await runContactNotes({
      state,
      tokens: connectedAlex(),
      cursor: {},
      now: Date.parse('2026-06-02T08:00:00.000Z')
    });
    const notes = state.contacts[0].interactions;
    const fresh = notes.find((item) => item.sourceKey === '<new@museum.example>');
    const older = notes.find((item) => item.id === 'n-old');
    assert.equal(fresh.status, 'written');
    assert.equal(fresh.title, 'June catalogue dates confirmed');
    assert.equal(fresh.summary, 'Olena confirmed the June catalogue.');
    assert.equal(older.status, 'pending');
    assert.equal(older.title, '');
    assert.equal(result.stats.written, 1);
  } finally {
    Date.now = realNow;
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('a recent Granola meeting is imported even when the backfill is on an older page', async () => {
  const previous = process.env.GRANOLA_API_KEY;
  process.env.GRANOLA_API_KEY = 'test-key';
  const queries = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    queries.push(href);
    if (href.includes('created_after=')) {
      return gmailJson({
        notes: [{ id: 'not_yesterday1234' }],
        hasMore: false,
        cursor: null
      });
    }
    if (href.includes('not_yesterday1234')) {
      return gmailJson({
        id: 'not_yesterday1234',
        title: 'Studio visit with Olena',
        created_at: '2026-10-28T10:00:00.000Z',
        owner: { name: 'Alex Admin', email: 'alex@example.org' },
        attendees: [{ name: 'Olena Kovalenko', email: 'olena@museum.example' }],
        summary_markdown: 'Olena confirmed the June catalogue on 28 October 2026.'
      });
    }
    return gmailJson({ threads: [], messages: [], notes: [] });
  };
  const state = {
    contacts: [{
      id: 'c1',
      name: 'Olena Kovalenko',
      emails: ['olena@museum.example'],
      interactions: [],
      dismissedKeys: []
    }],
    settings: {}
  };
  try {
    const result = await findRecentNotes({
      state,
      tokens: connectedAlex(),
      cursor: { granolaCursor: 'old-page', seenNotes: ['not_ancient'] },
      now: Date.parse('2026-10-29T08:00:00.000Z')
    });
    assert.equal(state.contacts[0].interactions.length, 1);
    assert.equal(state.contacts[0].interactions[0].source, 'granola');
    assert.equal(state.contacts[0].interactions[0].sourceKey, 'not_yesterday1234');
    assert.ok(queries.some((item) => item.includes('created_after=')));
    assert.equal(queries.some((item) => item.includes('old-page')), false);
    assert.equal(result.cursor.granolaCursor, 'old-page');
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.GRANOLA_API_KEY;
    else process.env.GRANOLA_API_KEY = previous;
  }
});

test('a rewrite updates the title unless it was edited while the note was writing', () => {
  const before = {
    id: 'n1',
    source: 'gmail',
    sourceKey: '<m@museum.example>',
    status: 'written',
    title: 'Old thread title here',
    summary: 'Old summary.',
    seenHash: 'm1',
    sourceHash: 'm1'
  };
  const snapshot = snapshotInteractions({ contacts: [{ id: 'c1', interactions: [before] }] });
  const cron = {
    contacts: [{
      id: 'c1',
      interactions: [{
        ...before,
        title: 'June catalogue dates confirmed',
        summary: 'Olena confirmed the June catalogue.',
        seenHash: 'm1,m2',
        sourceHash: 'm1,m2'
      }]
    }]
  };
  const edited = {
    contacts: [{ id: 'c1', interactions: [{ ...before, title: 'Hand edited title here' }] }]
  };
  mergeCronNotes(edited, cron, snapshot);
  assert.equal(edited.contacts[0].interactions[0].title, 'Hand edited title here');
  assert.equal(edited.contacts[0].interactions[0].summary, 'Olena confirmed the June catalogue.');

  const untouched = { contacts: [{ id: 'c1', interactions: [{ ...before }] }] };
  mergeCronNotes(untouched, cron, snapshot);
  assert.equal(untouched.contacts[0].interactions[0].title, 'June catalogue dates confirmed');
  assert.equal(untouched.contacts[0].interactions[0].summary, 'Olena confirmed the June catalogue.');
});

test('a Granola meeting title is replaced by the note written from the enhanced summary', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousGranola = process.env.GRANOLA_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.GRANOLA_API_KEY = 'test-key';
  const state = {
    contacts: [{
      id: 'c1',
      name: 'Olena Kovalenko',
      emails: ['olena@museum.example'],
      interactions: [{
        id: 'n1',
        source: 'granola',
        sourceKey: 'not_meeting1234',
        status: 'pending',
        title: 'Kyiv residency dates agreed with',
        summary: '',
        activityAt: '2026-10-13T10:00:00.000Z',
        participants: ['olena@museum.example', 'alex@example.org']
      }]
    }]
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('anthropic.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'June catalogue dates confirmed',
              summary: 'Olena Kovalenko confirmed the catalogue for 2 June 2026.',
              tasks: [],
              sourceLanguage: 'en'
            })
          }]
        })
      };
    }
    return gmailJson({
      id: 'not_meeting1234',
      title: 'Kyiv residency dates agreed with Olena',
      created_at: '2026-10-13T10:00:00.000Z',
      owner: { name: 'Alex Admin', email: 'alex@example.org' },
      attendees: [{ name: 'Olena Kovalenko', email: 'olena@museum.example' }],
      summary_markdown: 'Olena confirmed the catalogue for 2 June 2026. The print run follows.'
    });
  };
  try {
    const result = await writeNextNote(state, connectedAlex());
    const note = state.contacts[0].interactions[0];
    assert.equal(result.written, true);
    assert.equal(note.id, 'n1');
    assert.equal(note.status, 'written');
    assert.equal(note.title, 'June catalogue dates confirmed');
    assert.equal(note.summary, 'Olena Kovalenko confirmed the catalogue for 2 June 2026.');
  } finally {
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousGranola === undefined) delete process.env.GRANOLA_API_KEY;
    else process.env.GRANOLA_API_KEY = previousGranola;
  }
});

test('a new email rewrites the same Gmail note', async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const state = {
    contacts: [{
      id: 'c1',
      name: 'Olena Kovalenko',
      emails: ['olena@museum.example'],
      interactions: [{
        id: 'n1',
        source: 'gmail',
        status: 'written',
        sourceKey: '<m@museum.example>',
        threadUser: 'alex',
        threadId: 't1',
        seenHash: 't1-m,t1-m2',
        sourceHash: 't1-m',
        title: 'Old thread title here',
        summary: 'The first message only.',
        activityAt: '2026-06-02T08:00:00.000Z',
        participants: ['olena@museum.example', 'alex@example.org']
      }]
    }]
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('anthropic.com')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{
            type: 'text',
            text: JSON.stringify({
              title: 'June catalogue dates confirmed',
              summary: 'Olena confirmed the June catalogue after a second email.',
              tasks: [],
              sourceLanguage: 'en'
            })
          }]
        })
      };
    }
    return gmailJson({
      id: 't1',
      historyId: 'h2',
      messages: [
        message({
          id: 't1-m',
          at: Date.parse('2026-06-01T08:00:00.000Z'),
          messageId: '<m@museum.example>',
          from: 'Olena <olena@museum.example>',
          to: 'Alex Admin <alex@example.org>',
          subject: 'Catalogue',
          body: 'Can we confirm the June catalogue?'
        }),
        message({
          id: 't1-m2',
          at: Date.parse('2026-06-02T08:00:00.000Z'),
          messageId: '<m2@museum.example>',
          from: 'Olena <olena@museum.example>',
          to: 'Alex Admin <alex@example.org>',
          subject: 'Catalogue',
          body: 'The June catalogue is confirmed.'
        })
      ]
    });
  };
  try {
    const result = await writeNextNote(state, connectedAlex());
    const notes = state.contacts[0].interactions;
    assert.equal(notes.length, 1);
    assert.equal(result.written, true);
    assert.equal(notes[0].id, 'n1');
    assert.equal(notes[0].title, 'June catalogue dates confirmed');
    assert.equal(notes[0].summary, 'Olena confirmed the June catalogue after a second email.');
    assert.equal(notes[0].sourceHash, notes[0].seenHash);
    assert.match(notes[0].seenHash, /t1-m2/);
  } finally {
    globalThis.fetch = original;
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test('a sync with nothing new says it finished', () => {
  assert.equal(syncResultMessage({ written: 0, errors: [] }), 'Sync finished — no new matches');
  assert.equal(syncResultMessage({ written: 1, errors: [] }), '1 interaction note');
  assert.equal(syncResultMessage({ written: 3, errors: [] }), '3 interaction notes');
  assert.equal(syncResultMessage({ written: 0, errors: ['gmail recent: Gmail could not be read.'] }), 'gmail recent: Gmail could not be read.');
});
