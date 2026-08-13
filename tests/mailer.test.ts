import { describe, expect, it } from 'vitest';
import { buildNotification, isValidEmail, plannedActionContext } from '../src/mailer.js';

describe('attendance email notifications', () => {
  it('includes the schedule, windows, observed punches, and result', () => {
    const message = buildNotification(plannedActionContext({ id: 'a', date: '2026-08-13', action: 'check-in', scheduleSource: 'weekly thursday', targetWindow: { start: '12:30', end: '13:45' }, checkInWindow: { start: '12:30', end: '13:45' }, checkOutWindow: { start: '22:00', end: '23:00' }, minDurationMinutes: 540, maxDurationMinutes: 600, state: 'waiting_confirmation', createdAt: '', scheduledFor: '', expiresAt: '' }, 'verified', 'Verified check-in at 1:02p.', { record: { date: '2026-08-13', checkIn: '1:02p', checkOut: undefined } }));
    expect(message.subject).toContain('SUCCESS');
    expect(message.text).toContain('Configured punch-in window: 12:30–13:45 Nepal Time');
    expect(message.text).toContain('Configured punch-out window: 22:00–23:00 Nepal Time');
    expect(message.text).toContain('Observed punch-in: 1:02p');
    expect(message.html).toContain('weekly thursday');
  });

  it('labels pre-action notices as scheduled', () => {
    const message = buildNotification({ action: 'check-out', state: 'scheduled', date: '2026-08-13', scheduleSource: 'weekly thursday', targetWindow: { start: '22:31', end: '23:00' }, checkInWindow: { start: '12:30', end: '13:45' }, checkOutWindow: { start: '22:00', end: '23:00' }, minDurationMinutes: 540, maxDurationMinutes: 600, message: 'Punch-out is scheduled in 15 minutes at 22:31 Nepal Time.' });
    expect(message.subject).toContain('SCHEDULED');
    expect(message.text).toContain('Punch-out is scheduled in 15 minutes at 22:31 Nepal Time.');
  });

  it('labels duplicate punch prevention notices as skipped', () => {
    const message = buildNotification({ action: 'check-in', state: 'skipped', date: '2026-08-13', scheduleSource: 'weekly thursday', targetWindow: { start: '12:30', end: '13:45' }, checkInWindow: { start: '12:30', end: '13:45' }, checkOutWindow: { start: '22:00', end: '23:00' }, minDurationMinutes: 540, maxDurationMinutes: 600, record: { date: '2026-08-13', checkIn: '11:35a' }, message: 'RigoHR already recorded punch-in at 11:35a; no punch-in was submitted.' });
    expect(message.subject).toContain('SKIPPED');
    expect(message.text).toContain('no punch-in was submitted');
  });

  it('escapes error content in HTML', () => {
    const message = buildNotification({ action: 'check-out', state: 'failed', date: '2026-08-13', scheduleSource: 'weekly thursday', targetWindow: { start: '22:00', end: '23:00' }, checkInWindow: { start: '12:30', end: '13:45' }, checkOutWindow: { start: '22:00', end: '23:00' }, minDurationMinutes: 540, maxDurationMinutes: 600, message: '<password=secret>' });
    expect(message.html).not.toContain('<password=secret>');
    expect(message.html).toContain('&lt;password=secret&gt;');
  });

  it('requires an explicit UI recipient and never uses the login address as a fallback', () => {
    expect(isValidEmail('recipient@example.com')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });
});
