import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatInTz, parseTime, wallClockToDate } from '../src/tz.js';

describe('wall-clock to instant', () => {
  it('uses -07:00 for Denver in November (after DST ends)', () => {
    assert.equal(wallClockToDate('2026-11-10T09:00:00', 'America/Denver').toISOString(), '2026-11-10T16:00:00.000Z');
  });
  it('uses -06:00 for Denver in summer', () => {
    assert.equal(wallClockToDate('2026-07-01T09:00:00', 'America/Denver').toISOString(), '2026-07-01T15:00:00.000Z');
  });
  it('handles a conference spanning the fall-back change (2026-11-01 in the US)', () => {
    const fri = wallClockToDate('2026-10-30T10:00:00', 'America/Denver');
    const mon = wallClockToDate('2026-11-02T10:00:00', 'America/Denver');
    assert.equal(formatInTz(fri, 'America/Denver'), '2026-10-30T10:00:00-06:00');
    assert.equal(formatInTz(mon, 'America/Denver'), '2026-11-02T10:00:00-07:00');
  });
  it('handles the spring-forward change (2026-03-08 in the US)', () => {
    assert.equal(formatInTz(wallClockToDate('2026-03-07T12:00:00', 'America/Denver'), 'America/Denver'), '2026-03-07T12:00:00-07:00');
    assert.equal(formatInTz(wallClockToDate('2026-03-09T12:00:00', 'America/Denver'), 'America/Denver'), '2026-03-09T12:00:00-06:00');
  });
  it('moves a nonexistent spring-forward time forward by the gap', () => {
    const d = wallClockToDate('2026-03-08T02:30:00', 'America/Denver'); // 02:00-03:00 does not exist
    assert.equal(formatInTz(d, 'America/Denver'), '2026-03-08T03:30:00-06:00');
  });
  it('takes the first occurrence of a repeated fall-back time', () => {
    const d = wallClockToDate('2026-11-01T01:30:00', 'America/Denver'); // happens at -06:00 and -07:00
    assert.equal(formatInTz(d, 'America/Denver'), '2026-11-01T01:30:00-06:00');
  });
  it('works for half-hour and eastern offsets, and DST in the other hemisphere', () => {
    assert.equal(formatInTz(wallClockToDate('2026-11-10T09:00:00', 'Asia/Kolkata'), 'Asia/Kolkata'), '2026-11-10T09:00:00+05:30');
    assert.equal(formatInTz(wallClockToDate('2026-01-15T09:00:00', 'Australia/Sydney'), 'Australia/Sydney'), '2026-01-15T09:00:00+11:00');
    assert.equal(formatInTz(wallClockToDate('2026-07-15T09:00:00', 'Australia/Sydney'), 'Australia/Sydney'), '2026-07-15T09:00:00+10:00');
    assert.equal(formatInTz(wallClockToDate('2026-06-15T09:00:00', 'Europe/Berlin'), 'Europe/Berlin'), '2026-06-15T09:00:00+02:00');
  });
  it('formats UTC as +00:00', () => {
    assert.equal(formatInTz(new Date('2026-11-10T16:00:00Z'), 'UTC'), '2026-11-10T16:00:00+00:00');
  });
});

describe('parseTime', () => {
  it('treats strings with an offset as exact', () => {
    assert.equal(parseTime('2026-11-10T09:00:00+01:00', 'America/Denver').toISOString(), '2026-11-10T08:00:00.000Z');
    assert.equal(parseTime('2026-11-10T09:00:00Z').toISOString(), '2026-11-10T09:00:00.000Z');
  });
  it('treats strings without an offset as wall-clock in the timezone', () => {
    assert.equal(parseTime('2026-11-10T09:00:00', 'America/Denver').toISOString(), '2026-11-10T16:00:00.000Z');
  });
  it('needs a timezone for wall-clock strings', () => {
    assert.throws(() => parseTime('2026-11-10T09:00:00'), /No timezone/);
  });
});
