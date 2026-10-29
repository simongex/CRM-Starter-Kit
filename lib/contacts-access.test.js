import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contactsStateFor,
  emptyContactsState,
  mergeTeamContactsEdit,
  normalizeContactsState
} from './contacts.js';

function stored() {
  const state = emptyContactsState();
  state.contacts = [
    { id: 'c1', name: 'Gallery Owner', emails: ['owner@gallery.ch'], categories: ['venues'] },
    { id: 'c2', name: 'Job Applicant', emails: ['applicant@mail.ch'], categories: ['employees'] },
    { id: 'c3', name: 'Helper', emails: ['helper@mail.ch'], categories: ['volunteers', 'alumni'] }
  ];
  state.sources.emails = { m1: { subject: 'Application' } };
  state.proposals = [{ id: 'p1', type: 'inbound', email: 'new@mail.ch', name: 'New person' }];
  state.dismissedInbound = ['spam@mail.ch'];
  return normalizeContactsState(state);
}

test('team members see every contact except employees and volunteers', () => {
  const state = stored();
  const team = contactsStateFor(state, false);
  assert.deepEqual(team.contacts.map((c) => c.id), ['c1']);
  assert.deepEqual(team.proposals, []);
  assert.deepEqual(team.dismissedInbound, []);
  assert.deepEqual(team.sources.emails, {});
  assert.equal(contactsStateFor(state, true), state);
});

test('a team member save keeps the hidden contacts and the Review inbox', () => {
  const state = stored();
  const team = contactsStateFor(state, false);
  team.contacts[0].summary = 'Met at the opening';
  team.contacts.push({ id: 'c4', name: 'New Curator', emails: [], categories: ['venues', 'employees'] });

  const saved = normalizeContactsState(mergeTeamContactsEdit(state, team));
  const byId = Object.fromEntries(saved.contacts.map((c) => [c.id, c]));
  assert.equal(byId.c1.summary, 'Met at the opening');
  assert.ok(byId.c2, 'applicant kept');
  assert.ok(byId.c3, 'volunteer kept');
  assert.deepEqual(byId.c4.categories, ['venues']);
  assert.equal(saved.proposals.length, state.proposals.length);
  assert.deepEqual(saved.dismissedInbound, state.dismissedInbound);
  assert.deepEqual(saved.sources.emails, state.sources.emails);
});
