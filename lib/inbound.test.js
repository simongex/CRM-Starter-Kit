import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeProposals, normalizeContactsState } from './contacts.js';
import { classifyInbound, fallbackProposalSummary, nameFromAddress } from './inbound.js';

test('a person who wrote in is kept, and mail that is not a person is dropped', () => {
  assert.equal(classifyInbound({ email: 'casey.koval@museum.ch', name: 'Casey Koval' }).keep, true);
  assert.equal(classifyInbound({ email: 'no-reply@gallery.com', name: 'Gallery' }).reason, 'role');
  assert.equal(classifyInbound({ email: 'noreply@gallery.com' }).reason, 'role');
  assert.equal(classifyInbound({ email: 'info@gallery.com' }).reason, 'role');
  assert.equal(classifyInbound({ email: 'hello@gallery.com' }).reason, 'role');
  assert.equal(classifyInbound({ email: 'office@gallery.com' }).reason, 'role');
  assert.equal(classifyInbound({ email: 'alex@example.org', name: 'Alex Admin' }).reason, 'internal');
  assert.equal(classifyInbound({
    email: 'casey.koval@museum.ch',
    name: 'Casey Koval',
    labelIds: ['CATEGORY_PROMOTIONS', 'INBOX']
  }).reason, 'advertisement');
  assert.equal(classifyInbound({
    email: 'casey.koval@museum.ch',
    headers: { 'List-Unsubscribe': '<mailto:bye@gallery.com>' }
  }).reason, 'advertisement');
  assert.equal(classifyInbound({
    email: 'casey.koval@museum.ch',
    headers: { Precedence: 'bulk' }
  }).reason, 'advertisement');
  assert.equal(classifyInbound({
    email: 'casey.koval@museum.ch',
    headers: { 'Auto-Submitted': 'auto-replied' }
  }).reason, 'automated');
  assert.equal(classifyInbound({
    email: 'news@mail.mailchimp.com',
    name: 'Museum via Mailchimp'
  }).reason, 'advertisement');
  assert.equal(classifyInbound({
    email: 'casey.koval@museum.ch',
    subject: '20% off membership'
  }).reason, 'advertisement');
});

test('the same message is counted once, and a dismissed or known address stays out', () => {
  const once = mergeProposals([], [
    { email: 'casey.koval@museum.ch', name: 'Casey Koval', subject: 'Studio visit', date: '2026-10-13', messageIds: ['m1'] }
  ]);
  const twice = mergeProposals(once, [
    { email: 'casey.koval@museum.ch', name: 'Casey Koval', subject: 'Studio visit', date: '2026-10-13', messageIds: ['m1'] }
  ]);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].count, 1);

  const again = mergeProposals(twice, [
    { email: 'casey.koval@museum.ch', subject: 'Follow up', date: '2026-10-14', messageIds: ['m2'] }
  ]);
  assert.equal(again[0].count, 2);
  assert.equal(again[0].subject, 'Follow up');

  const hidden = mergeProposals(again, [], {
    known: ['casey.koval@museum.ch'],
    dismissed: []
  });
  assert.equal(hidden.length, 0);

  const kept = mergeProposals([], [
    { email: 'leo@press.example', name: 'Leo', date: '2026-10-01', messageIds: ['m3'] },
    { email: 'info@press.example', name: 'Press', date: '2026-10-02', messageIds: ['m4'] }
  ], { dismissed: ['info@press.example'] });
  assert.deepEqual(kept.map((item) => item.email), ['leo@press.example']);
});

test('a proposal keeps the inbox owner, and a later day moves it', () => {
  const first = mergeProposals([], [{
    email: 'casey.koval@museum.ch',
    name: 'Casey Koval',
    subject: 'Studio visit',
    date: '2026-10-12',
    owner: 'sam',
    messageIds: ['m1']
  }]);
  assert.equal(first[0].owner, 'sam');
  const later = mergeProposals(first, [{
    email: 'casey.koval@museum.ch',
    subject: 'Follow up',
    date: '2026-10-13',
    owner: 'alex',
    messageIds: ['m2']
  }]);
  assert.equal(later[0].owner, 'alex');
  assert.equal(later[0].summary, '');
  const sameDay = mergeProposals(later, [{
    email: 'casey.koval@museum.ch',
    subject: 'Follow up',
    date: '2026-10-13',
    owner: 'sam',
    summary: 'Casey Koval asked about dates for a studio visit.',
    messageIds: ['m2']
  }]);
  assert.equal(sameDay[0].owner, 'alex');
  assert.equal(sameDay[0].summary, 'Casey Koval asked about dates for a studio visit.');
});

test('a missing name comes from the address, and the summary stays to two sentences', () => {
  assert.equal(nameFromAddress('casey.koval@museum.ch', ''), 'Casey Koval');
  assert.equal(nameFromAddress('casey.koval@museum.ch', 'Casey Koval'), 'Casey Koval');
  const summary = fallbackProposalSummary({
    name: 'Casey Koval',
    subject: 'Studio visit',
    snippet: 'Could we come by next week? I can also send the floor plan. The third sentence should not remain.'
  });
  assert.match(summary, /^Casey Koval wrote about Studio visit\./);
  assert.equal(summary.split(/(?<=[.!?])\s+/).length, 2);
  assert.equal(summary.includes('\u2014'), false);
});

test('saving contacts drops a proposal once that person is in the database', () => {
  const state = normalizeContactsState({
    groups: [],
    contacts: [{ id: 'c1', name: 'Casey Koval', emails: ['casey.koval@museum.ch'] }],
    proposals: [
      { email: 'casey.koval@museum.ch', name: 'Casey Koval', messageIds: ['m1'] },
      { email: 'leo@press.example', name: 'Leo', date: '2026-10-01', messageIds: ['m3'] }
    ],
    dismissedInbound: ['leo@press.example']
  });
  assert.equal(state.proposals.length, 0);
  assert.deepEqual(state.dismissedInbound, ['leo@press.example']);
});
