import { describe, expect, it } from 'vitest';
import { hardPunchDecision, reconcilePunchOutcome } from '../src/automation.js';

describe('hard punch safety checks', () => {
  const atSixPm = new Date('2026-08-13T12:15:00Z'); // 18:00 Asia/Kathmandu

  it('blocks a second hard punch-in when RigoHR already has one', () => {
    const result = hardPunchDecision('check-in', { date: '2026-08-13', checkIn: '11:35a' }, atSixPm, 'Asia/Kathmandu', 540);
    expect(result.state).toBe('skipped');
    expect(result.message).toMatch(/already recorded/);
  });

  it('blocks hard punch-out when no punch-in is recorded', () => {
    const result = hardPunchDecision('check-out', { date: '2026-08-13' }, atSixPm, 'Asia/Kathmandu', 540);
    expect(result.state).toBe('blocked');
    expect(result.message).toMatch(/no recorded punch-in/);
  });

  it('blocks hard punch-out before nine hours', () => {
    const result = hardPunchDecision('check-out', { date: '2026-08-13', checkIn: '10:00' }, new Date('2026-08-13T13:14:00Z'), 'Asia/Kathmandu', 540);
    expect(result.state).toBe('blocked');
    expect(result.message).toMatch(/only 539 minutes/);
  });

  it('allows another hard punch-out after nine hours', () => {
    const result = hardPunchDecision('check-out', { date: '2026-08-13', checkIn: '09:00', checkOut: '17:00' }, atSixPm, 'Asia/Kathmandu', 540);
    expect(result.state).toBe('eligible');
  });

  it('verifies an uncertain punch from the reconciled attendance record without retrying', () => {
    const result = reconcilePunchOutcome('check-out', { date: '2026-08-13', checkIn: '11:35a', checkOut: '11:27p' });
    expect(result.verified).toBe(true);
    expect(result.value).toBe('11:27p');
    expect(result.message).toMatch(/not retried/);
  });

  it('fails an uncertain punch safely when reconciliation has no punch-out', () => {
    const result = reconcilePunchOutcome('check-out', { date: '2026-08-13', checkIn: '11:35a' });
    expect(result.verified).toBe(false);
    expect(result.message).toMatch(/could not be verified/);
    expect(result.message).toMatch(/not retried/);
  });
});
