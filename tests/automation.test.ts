import { describe, expect, it } from 'vitest';
import { hardPunchDecision, isScheduledExecutionTimeAllowed, reconcilePunchOutcome } from '../src/automation.js';

describe('hard punch safety checks', () => {
  it('blocks a second hard punch-in when RigoHR already has one', () => {
    const result = hardPunchDecision('check-in', { date: '2026-08-13', checkIn: '11:35a' });
    expect(result.state).toBe('skipped');
    expect(result.message).toMatch(/already recorded/);
  });

  it('blocks hard punch-out when no punch-in is recorded', () => {
    const result = hardPunchDecision('check-out', { date: '2026-08-13' });
    expect(result.state).toBe('blocked');
    expect(result.message).toMatch(/no recorded punch-in/);
  });

  it('allows hard punch-out before nine hours for early departure or partial PTO', () => {
    const result = hardPunchDecision('check-out', { date: '2026-08-13', checkIn: '10:00' });
    expect(result.state).toBe('eligible');
  });

  it('allows another hard punch-out after nine hours', () => {
    const result = hardPunchDecision('check-out', { date: '2026-08-13', checkIn: '09:00', checkOut: '17:00' });
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

describe('manual schedule execution timing', () => {
  it('allows an exact manual target to execute on a late scheduler tick', () => {
    const action = { targetWindow: { start: '13:15', end: '13:15' } };
    expect(isScheduledExecutionTimeAllowed(action, '13:14')).toBe(false);
    expect(isScheduledExecutionTimeAllowed(action, '13:15')).toBe(true);
    expect(isScheduledExecutionTimeAllowed(action, '13:16')).toBe(true);
  });

  it('keeps ordinary schedule windows bounded by their configured end', () => {
    const action = { targetWindow: { start: '09:30', end: '10:45' } };
    expect(isScheduledExecutionTimeAllowed(action, '10:45')).toBe(true);
    expect(isScheduledExecutionTimeAllowed(action, '10:46')).toBe(false);
  });
});
