import assert from 'node:assert/strict';
import test from 'node:test';
import {
  knownAccount,
  overseesTask,
  ownsAction,
  ownsTask,
  seesTask,
  sharesTask
} from './internal-auth.js';

const phases = [
  { id: 'logistics', name: 'Logistics' },
  { id: 'finance', name: 'Finance' },
  { id: 'smm', name: 'SMM / Content' },
  { id: 'smm-site', name: 'SMM / Website' }
];

test('Morgan is a known account', () => {
  assert.equal(knownAccount('morgan'), true);
  assert.equal(knownAccount('MORGAN'), true);
});

test('Morgan sees her own work, Robin, Casey, and the programme categories', () => {
  const own = { id: '1', owner: 'Morgan', phaseId: 'finance', actions: [] };
  const robin = { id: '2', owner: 'Robin', phaseId: 'finance', actions: [] };
  const annaAction = {
    id: '3',
    owner: 'Sam',
    phaseId: 'finance',
    actions: [{ text: 'Call', owner: 'Casey' }]
  };
  const logistics = { id: '4', owner: 'Alex', phaseId: 'logistics', actions: [] };
  const smm = { id: '5', owner: 'Taylor', phaseId: 'smm', actions: [] };
  const website = { id: '8', owner: 'Sam', phaseId: 'smm-site', actions: [] };
  const finance = { id: '6', owner: 'Alex', phaseId: 'finance', actions: [] };

  assert.equal(seesTask('morgan', own, phases), true);
  assert.equal(seesTask('morgan', robin, phases), true);
  assert.equal(seesTask('morgan', annaAction, phases), true);
  assert.equal(seesTask('morgan', logistics, phases), true);
  assert.equal(seesTask('morgan', smm, phases), true);
  assert.equal(seesTask('morgan', website, phases), true);
  assert.equal(seesTask('morgan', finance, phases), false);
});

test('Morgan can take ownership of overseen tasks, not private ones', () => {
  const robin = { id: '2', owner: 'Robin', phaseId: 'finance', actions: [] };
  const logistics = { id: '4', owner: 'Alex', phaseId: 'logistics', actions: [] };
  const ownFinance = { id: '1', owner: 'Morgan', phaseId: 'finance', actions: [] };

  assert.equal(overseesTask('morgan', robin, phases), true);
  assert.equal(overseesTask('morgan', logistics, phases), true);
  assert.equal(overseesTask('morgan', ownFinance, phases), false);
  assert.equal(ownsTask('morgan', ownFinance), true);
});

test('Casey and Robin see each other\'s work without overseeing it', () => {
  const robin = { id: '2', owner: 'Robin', phaseId: 'finance', actions: [] };
  const annaAction = {
    id: '3',
    owner: 'Sam',
    phaseId: 'finance',
    actions: [{ text: 'Call', owner: 'Casey' }]
  };
  const taylor = { id: '7', owner: 'Taylor', phaseId: 'logistics', actions: [] };

  assert.equal(seesTask('casey', robin, phases), true);
  assert.equal(seesTask('robin', annaAction, phases), true);
  assert.equal(sharesTask('casey', robin), true);
  assert.equal(overseesTask('casey', robin, phases), false);
  assert.equal(overseesTask('robin', annaAction, phases), false);
  assert.equal(seesTask('casey', taylor, phases), false);
});

test('ordinary collaborators still only see their own work', () => {
  const robin = { id: '2', owner: 'Robin', phaseId: 'logistics', actions: [] };
  const taylor = { id: '7', owner: 'Taylor', phaseId: 'logistics', actions: [] };
  assert.equal(seesTask('taylor', robin, phases), false);
  assert.equal(seesTask('taylor', taylor, phases), true);
  assert.equal(ownsAction('taylor', taylor, { text: 'File', owner: '' }), true);
});
