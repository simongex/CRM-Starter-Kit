import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyNewsletterChoice,
  groupCsv,
  markUnsubscribed,
  normalizeContact,
  normalizeContactsState,
  scrubImportedListNotes
} from './contacts.js';
import { applyMailchimpEvent, md5Hex, memberPayload, syncPlan, tagPlan } from './mailchimp.js';
import handler from '../api/mailchimp-webhook.js';

test('old newsletter membership migrates to a status, and internal lists become groups', () => {
  const state = normalizeContactsState({
    mailingLists: [
      { id: 'newsletter', name: 'Newsletter', kind: 'newsletter' },
      { id: 'kyiv-partners', name: 'Kyiv partners', kind: 'internal' }
    ],
    contacts: [
      {
        id: 'agreed',
        emails: ['ada@example.com'],
        mailing: { lists: ['newsletter'], consent: 'email', consentDate: '2026-04-02' }
      },
      {
        id: 'asked',
        emails: ['b@example.com'],
        mailing: { lists: ['newsletter', 'kyiv-partners'] }
      },
      {
        id: 'cleaned',
        emails: ['c@example.com'],
        mailing: { lists: ['newsletter', 'kyiv-partners'], status: 'cleaned', consent: 'verbal', consentDate: '2026-01-01' }
      }
    ]
  });

  assert.deepEqual(state.groups.map((group) => group.id), ['kyiv-partners']);
  assert.equal(state.mailingLists, undefined);

  const agreed = state.contacts.find((item) => item.id === 'agreed');
  assert.equal(agreed.newsletter.status, 'agreed');
  assert.equal(agreed.newsletter.date, '2026-04-02');
  assert.equal(agreed.newsletter.history[0].event, 'agreed');
  assert.equal(agreed.newsletter.history[0].date, '2026-04-02');
  assert.deepEqual(agreed.groups, []);

  const asked = state.contacts.find((item) => item.id === 'asked');
  assert.equal(asked.newsletter.status, 'not-asked');
  assert.deepEqual(asked.groups, ['kyiv-partners']);

  const cleaned = state.contacts.find((item) => item.id === 'cleaned');
  assert.equal(cleaned.newsletter.status, 'unsubscribed');
  assert.deepEqual(cleaned.groups, ['kyiv-partners']);

  const kept = normalizeContact({
    emails: [],
    newsletter: { status: 'agreed', date: '2026-04-02', history: [{ date: '2026-04-02', event: 'agreed', by: 'alex' }] }
  });
  assert.equal(kept.newsletter.status, 'agreed');
  assert.equal(kept.newsletter.date, '2026-04-02');
});

test('Agreed, then Not asked, then Agreed records two dates and three history entries', () => {
  let newsletter = { status: 'not-asked' };
  newsletter = applyNewsletterChoice(newsletter, 'agreed', { date: '2026-10-12', by: 'alex' });
  newsletter = applyNewsletterChoice(newsletter, 'not-asked', { date: '2026-10-13', by: 'alex' });
  newsletter = applyNewsletterChoice(newsletter, 'agreed', { date: '2026-11-20', by: 'alex' });

  assert.equal(newsletter.status, 'agreed');
  assert.equal(newsletter.date, '2026-11-20');
  assert.equal(newsletter.history.length, 3);
  assert.deepEqual(newsletter.history.map((entry) => entry.event), ['agreed', 'removed', 'agreed']);
  assert.deepEqual(newsletter.history.map((entry) => entry.date), ['2026-10-12', '2026-10-13', '2026-11-20']);
  assert.notEqual(newsletter.history[0].date, newsletter.history[2].date);

  const unsubscribed = markUnsubscribed(
    { status: 'agreed', date: '2026-01-01', history: [{ date: '2026-01-01', event: 'agreed', by: 'alex' }] },
    '2026-10-14'
  );
  const stuck = applyNewsletterChoice(unsubscribed, 'agreed', { date: '2026-10-15', by: 'alex' });
  assert.equal(stuck.status, 'unsubscribed');
  assert.equal(stuck.history.length, unsubscribed.history.length);
  assert.equal(stuck.history.at(-1).event, 'unsubscribed');
});

test('a review adds the contact as agreed and records where it came from', () => {
  const newsletter = applyNewsletterChoice({ status: 'not-asked' }, 'agreed', {
    date: '2026-10-15',
    by: 'sam',
    via: 'review'
  });
  assert.equal(newsletter.status, 'agreed');
  assert.equal(newsletter.date, '2026-10-15');
  assert.equal(newsletter.history.at(-1).via, 'review');
});

test('deleting a group removes its id from every contact', () => {
  const state = normalizeContactsState({
    groups: [{ id: 'kyiv-partners', name: 'Kyiv partners' }],
    contacts: [
      { id: 'a', emails: ['a@example.com'], groups: ['kyiv-partners', 'gone'] },
      { id: 'b', emails: ['b@example.com'], groups: ['gone'] }
    ]
  });
  assert.deepEqual(state.contacts[0].groups, ['kyiv-partners']);
  assert.deepEqual(state.contacts[1].groups, []);

  const deleted = normalizeContactsState({
    groups: [],
    contacts: state.contacts
  });
  assert.deepEqual(deleted.groups, []);
  assert.deepEqual(deleted.contacts[0].groups, []);
  assert.deepEqual(deleted.contacts[1].groups, []);
});

test('only agreed contacts produce member payloads, tags match groups, and a removal archives', () => {
  const groups = [
    { id: 'kyiv-partners', name: 'Kyiv partners' },
    { id: 'donors', name: 'Donor circle' }
  ];
  const agreed = {
    id: 'a',
    name: 'Ada Lovelace',
    emails: ['ada@example.com'],
    groups: ['kyiv-partners'],
    newsletter: { status: 'agreed', date: '2026-10-12' }
  };
  const declined = {
    id: 'd',
    emails: ['d@example.com'],
    newsletter: { status: 'declined', syncedEmail: 'd@example.com' }
  };
  const never = {
    id: 'n',
    emails: ['n@example.com'],
    newsletter: { status: 'not-asked' }
  };

  const payload = memberPayload(agreed);
  assert.equal(payload.email_address, 'ada@example.com');
  assert.equal(payload.status_if_new, 'subscribed');
  assert.equal(payload.status, undefined);
  assert.equal(memberPayload(declined), null);
  assert.equal(memberPayload(never), null);

  assert.deepEqual(tagPlan(agreed, groups), [
    { name: 'Kyiv partners', status: 'active' },
    { name: 'Donor circle', status: 'inactive' }
  ]);
  assert.equal(syncPlan(agreed), 'upsert');
  assert.equal(syncPlan(declined), 'archive');
  assert.equal(syncPlan(never), 'skip');
  assert.equal(md5Hex('hello'), '5d41402abc4b2a76b9719d911017c592');
});

test('a Mailchimp unsubscribe and a later subscribe update the contact', () => {
  const state = normalizeContactsState({
    contacts: [{
      id: 'a',
      emails: ['ada@example.com'],
      newsletter: {
        status: 'agreed',
        date: '2026-10-12',
        history: [{ date: '2026-10-12', event: 'agreed', by: 'alex' }]
      }
    }]
  });

  assert.equal(applyMailchimpEvent(state, {
    type: 'unsubscribe',
    email: 'ada@example.com',
    date: '2026-10-14'
  }), true);
  assert.equal(state.contacts[0].newsletter.status, 'unsubscribed');
  assert.equal(state.contacts[0].newsletter.history.at(-1).event, 'unsubscribed');
  assert.equal(state.contacts[0].newsletter.history.at(-1).via, 'mailchimp');

  assert.equal(applyMailchimpEvent(state, {
    type: 'subscribe',
    email: 'Ada@Example.com',
    date: '2026-11-01'
  }), true);
  assert.equal(state.contacts[0].newsletter.status, 'agreed');
  assert.equal(state.contacts[0].newsletter.date, '2026-11-01');
  assert.equal(state.contacts[0].newsletter.history.at(-1).event, 'resubscribed');
  assert.equal(state.contacts[0].newsletter.history.at(-1).via, 'mailchimp');
});

test('a webhook with the wrong key is refused before storage is touched', async () => {
  const previous = process.env.MAILCHIMP_WEBHOOK_SECRET;
  process.env.MAILCHIMP_WEBHOOK_SECRET = 'expected-secret';
  try {
    const response = await handler(new Request('https://example.org/api/mailchimp-webhook?key=wrong'));
    assert.equal(response.status, 401);
    const missing = await handler(new Request('https://example.org/api/mailchimp-webhook'));
    assert.equal(missing.status, 401);
  } finally {
    if (previous === undefined) delete process.env.MAILCHIMP_WEBHOOK_SECRET;
    else process.env.MAILCHIMP_WEBHOOK_SECRET = previous;
  }
});

test('employees and volunteers are manager-only and appear on an existing list', () => {
  const state = normalizeContactsState({
    categories: [
      { id: 'artists', name: 'Artists', color: '#e08aa0' },
      { id: 'volunteers', name: 'Volunteers / Coordinators', color: '#b5d47a' }
    ],
    contacts: [{ id: 'ada', name: 'Ada', categories: ['artists', 'employees'] }]
  });
  const employees = state.categories.find((cat) => cat.id === 'employees');
  const volunteers = state.categories.find((cat) => cat.id === 'volunteers');
  assert.equal(employees.name, 'Employees / Applicants');
  assert.equal(employees.managersOnly, true);
  assert.equal(volunteers.managersOnly, true);
  assert.equal(state.categories.find((cat) => cat.id === 'artists').managersOnly, undefined);
  assert.deepEqual(state.contacts[0].categories, ['artists', 'employees']);
});

test('group CSV includes only agreed members and escapes commas and quotes', () => {
  const group = { id: 'friends', name: 'Friends, press' };
  const csv = groupCsv([
    {
      id: 'ada',
      name: 'Ada "A" Lovelace, Jr',
      emails: ['ada@example.com', 'other@example.com'],
      groups: ['friends'],
      newsletter: { status: 'agreed' }
    },
    {
      id: 'declined',
      name: 'Bea',
      emails: ['bea@example.com'],
      groups: ['friends'],
      newsletter: { status: 'declined' }
    },
    {
      id: 'other',
      name: 'Cee',
      emails: ['cee@example.com'],
      groups: ['other'],
      newsletter: { status: 'agreed' }
    }
  ], group);
  assert.equal(
    csv,
    'Email Address,First Name,Last Name,Tags\n'
    + 'ada@example.com,Ada,"""A"" Lovelace, Jr","Friends, press"\n'
  );
});

test('imported list markers are removed from relationship notes and interaction notes', () => {
  const state = {
    contacts: [{
      id: 'ada',
      summary: 'Met in Zurich.\n\n[Imported list: Donors 2024]',
      events: [{ id: 'e1', notes: 'Called about the catalogue. [Imported list: Press]' }],
      interactions: [{ id: 'n1', summary: '[Imported list: Board]\n\nOlena confirmed the June date.' }]
    }]
  };
  assert.equal(scrubImportedListNotes(state), true);
  assert.equal(state.contacts[0].summary, 'Met in Zurich.');
  assert.equal(state.contacts[0].events[0].notes, 'Called about the catalogue.');
  assert.equal(state.contacts[0].interactions[0].summary, 'Olena confirmed the June date.');
  assert.equal(scrubImportedListNotes(state), false);

  const contact = normalizeContact({
    id: 'ada',
    summary: 'Kept. [Imported list: Friends]',
    events: [{ notes: '[Imported list: Friends]' }],
    interactions: [{ summary: 'A real note. [Imported list: Friends]', status: 'written', source: 'gmail', sourceKey: 'm1' }]
  });
  assert.equal(contact.summary, 'Kept.');
  assert.equal(contact.events[0].notes, '');
  assert.equal(contact.interactions[0].summary, 'A real note.');
});
