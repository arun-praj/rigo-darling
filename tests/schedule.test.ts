import { describe, expect, it } from 'vitest';
import { addMinutesToTime, checkoutGuidance, durationMinutes, inWindow, isWithinLeadWindow, minutes, nextScheduledAction, ruleForDate, upcomingWorkdayForecast, validateRule, getRandomPunchTimes } from '../src/schedule.js';
import { defaultConfig } from '../src/config.js';

describe('schedule safety rules', () => {
  it('rejects a minimum below nine hours', () => expect(() => validateRule({ ...defaultConfig().weekly[0], minDurationMinutes: 539 })).toThrow(/540/));
  it('allows exactly nine hours and blocks less at the caller', () => {
    expect(durationMinutes('10:00', new Date('2026-08-13T13:59:00+05:45'), 'Asia/Kathmandu')).toBe(239);
    expect(addMinutesToTime('10:00', 540)).toBe('19:00');
  });
  it('matches a time window inclusively', () => {
    expect(inWindow('09:30', { start: '09:30', end: '10:45' })).toBe(true);
    expect(inWindow('10:46', { start: '09:30', end: '10:45' })).toBe(false);
  });
  it('opens the automatic cancellation window 15 minutes before the planned punch', () => {
    expect(isWithinLeadWindow('12:45', '13:00')).toBe(true);
    expect(isWithinLeadWindow('13:00', '13:00')).toBe(false);
    expect(isWithinLeadWindow('12:44', '13:00')).toBe(false);
  });
  it('uses a date override before the weekly rule', () => {
    const config = defaultConfig();
    config.overrides.push({ date: '2026-08-13', shift: 'Evening', enabled: true, checkInWindow: { start: '12:30', end: '13:45' }, checkOutWindow: { start: '22:00', end: '23:00' }, minDurationMinutes: 540, maxDurationMinutes: 600 });
    expect(ruleForDate(config, '2026-08-13', 'thursday')?.source).toContain('date override');
  });
  it('validates time syntax', () => expect(() => minutes('25:00')).toThrow());

  it('finds the next eligible window and reports when it is open now', () => {
    const config = defaultConfig();
    const next = nextScheduledAction(config, new Date('2026-08-13T02:30:00Z'));
    expect(next?.action).toBe('check-in');
    expect(next?.date).toBe('2026-08-13');
    expect(next?.windowStart).toBe('12:55');
    expect(next?.checkInWindow).toEqual({ start: '12:30', end: '13:45' });
    expect(next?.checkOutWindow).toEqual({ start: '22:00', end: '23:00' });
    expect(next?.punchOutWindow).toEqual({ start: '22:46', end: '23:00' });
    expect(next?.availableNow).toBe(false);
  });

  it('uses a planned time override without treating it as recorded attendance', () => {
    const next = nextScheduledAction(
      defaultConfig(),
      new Date('2026-08-13T02:30:00Z'),
      {},
      undefined,
      { '2026-08-13': { 'check-out': '22:48' } },
    );

    expect(next?.punchOutWindow).toEqual({ start: '22:48', end: '23:00' });
    expect(next?.action).toBe('check-in');
  });

  it('skips dates excluded by a leave or holiday calendar', () => {
    const config = defaultConfig();
    const next = nextScheduledAction(config, new Date('2026-08-13T02:30:00Z'), undefined, new Set(['2026-08-13', '2026-08-14']));
    expect(next?.date).not.toBe('2026-08-13');
    expect(next?.date).not.toBe('2026-08-14');
  });

  it('calculates the earliest safe checkout from the verified check-in', () => {
    const config = defaultConfig();
    const guidance = checkoutGuidance(config, '2026-08-13', 'thursday', new Date('2026-08-13T13:00:00Z'), '13:02');
    expect(guidance?.earliestCheckout).toBe('22:02');
    expect(guidance?.eligibleWindow).toEqual({ start: '22:02', end: '23:00' });
    expect(guidance?.minimumReached).toBe(false);
  });

  it('randomizes punch-in and punch-out within the configured window and satisfies duration limits', () => {
    const checkInWindow = { start: '09:30', end: '10:45' };
    const checkOutWindow = { start: '19:00', end: '20:00' };

    for (let i = 1; i <= 30; i++) {
      const date = `2026-08-${String(i).padStart(2, '0')}`;
      const { checkIn, checkOut } = getRandomPunchTimes(date, checkInWindow, checkOutWindow);

      const inMins = minutes(checkIn);
      const outMins = minutes(checkOut);
      const duration = outMins - inMins;

      expect(inMins).toBeGreaterThanOrEqual(minutes(checkInWindow.start));
      expect(inMins).toBeLessThanOrEqual(minutes(checkInWindow.end));
      expect(outMins).toBeGreaterThanOrEqual(minutes(checkOutWindow.start));
      expect(outMins).toBeLessThanOrEqual(minutes(checkOutWindow.end));
      expect(duration).toBeGreaterThanOrEqual(540); // 9 hours
      expect(duration).toBeLessThanOrEqual(600); // 10 hours
    }
  });

  it('forecasts the next five workdays with configured randomized punch times', () => {
    const forecast = upcomingWorkdayForecast(defaultConfig(), new Date('2026-08-16T06:00:00Z'));
    expect(forecast).toHaveLength(5);
    expect(forecast.map((day) => day.date)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21']);
    expect(forecast[0].status).toBe('scheduled');
    expect(forecast[0].checkInWindow).toEqual({ start: '09:30', end: '10:45' });
    expect(forecast[0].checkIn).toBeTruthy();
    expect(forecast[0].checkOut).toBeTruthy();
  });

  it('marks a forecast date as a holiday without generating punches', () => {
    const forecast = upcomingWorkdayForecast(defaultConfig(), new Date('2026-08-16T06:00:00Z'), {}, [{ id: 'h', date: '2026-08-19', type: 'holiday', createdAt: '' }]);
    expect(forecast[2]).toMatchObject({ date: '2026-08-19', status: 'holiday' });
    expect(forecast[2].checkIn).toBeUndefined();
  });
});
