import test from 'node:test';
import assert from 'node:assert/strict';
import { londonHour, withinLondonWorkHours } from './cron-hours.js';

test('working hours follow London time in winter (GMT) and summer (BST)', () => {
  const winter = {
    before: '2026-01-15T07:00:00.000Z',
    open: '2026-01-15T08:00:00.000Z',
    close: '2026-01-15T19:00:00.000Z',
    after: '2026-01-15T20:00:00.000Z'
  };
  const summer = {
    before: '2026-07-15T06:00:00.000Z',
    open: '2026-07-15T07:00:00.000Z',
    close: '2026-07-15T18:00:00.000Z',
    after: '2026-07-15T19:00:00.000Z'
  };

  assert.equal(londonHour(new Date(winter.before)), 7);
  assert.equal(londonHour(new Date(winter.open)), 8);
  assert.equal(londonHour(new Date(winter.close)), 19);
  assert.equal(londonHour(new Date(winter.after)), 20);

  assert.equal(londonHour(new Date(summer.before)), 7);
  assert.equal(londonHour(new Date(summer.open)), 8);
  assert.equal(londonHour(new Date(summer.close)), 19);
  assert.equal(londonHour(new Date(summer.after)), 20);

  for (const day of [winter, summer]) {
    assert.equal(withinLondonWorkHours(new Date(day.before)), false);
    assert.equal(withinLondonWorkHours(new Date(day.open)), true);
    assert.equal(withinLondonWorkHours(new Date(day.close)), true);
    assert.equal(withinLondonWorkHours(new Date(day.after)), false);
  }
});
