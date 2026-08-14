import type { Config, DayName, ScheduleRule } from './types.js';

export const DAYS: DayName[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

const rule = (day: DayName, shift: 'Morning' | 'Evening'): ScheduleRule => ({
  day,
  shift,
  enabled: !['saturday', 'sunday'].includes(day),
  checkInWindow: shift === 'Evening' ? { start: '12:30', end: '13:45' } : { start: '09:30', end: '10:45' },
  checkOutWindow: shift === 'Evening' ? { start: '22:00', end: '23:00' } : { start: '19:00', end: '20:00' },
  minDurationMinutes: 540,
  maxDurationMinutes: 600,
});

export function notificationRecipientsFromEnv(): string[] {
  const configured = process.env.NOTIFICATION_EMAILS || process.env.NOTIFICATION_EMAIL || '';
  return [...new Set(configured.split(/[;,]/).map((email) => email.trim()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
}

export const defaultConfig = (): Config => ({
  timezone: process.env.RIGOHR_TIMEZONE || 'Asia/Kathmandu',
  weekly: DAYS.map((day) => rule(day, ['wednesday', 'thursday'].includes(day) ? 'Evening' : 'Morning')),
  overrides: [],
  notificationEmails: notificationRecipientsFromEnv(),
});

export function withDefaultShift(config: Config): Config {
  const rules = config.weekly.map((rule) => ({ ...rule }));
  for (const rule of rules) {
    if (rule.shift === 'Evening') {
      rule.checkInWindow ??= { start: '12:30', end: '13:45' };
      rule.checkOutWindow ??= { start: '22:00', end: '23:00' };
    }
  }
  return { ...config, weekly: rules };
}
