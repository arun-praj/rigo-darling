import type { ActionType, Config, DateOverride, DayName, ScheduleException, ScheduleRule, ScheduleTimeOverrides } from './types.js';

export const dayNames: DayName[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export function minutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid time: ${value}`);
  return hour * 60 + minute;
}

export function validateRule(rule: ScheduleRule | Omit<DateOverride, 'date'>): void {
  const checkInStart = minutes(rule.checkInWindow.start);
  const checkInEnd = minutes(rule.checkInWindow.end);
  const checkOutStart = minutes(rule.checkOutWindow.start);
  const checkOutEnd = minutes(rule.checkOutWindow.end);
  if (checkInStart > checkInEnd) throw new Error('Punch-in window must not cross midnight.');
  if (checkOutStart > checkOutEnd) throw new Error('Punch-out window must not cross midnight.');
  if (!Number.isInteger(rule.minDurationMinutes) || rule.minDurationMinutes < 540) {
    throw new Error('Minimum duration must be at least 540 minutes (9 hours).');
  }
  if (!Number.isInteger(rule.maxDurationMinutes) || rule.maxDurationMinutes < rule.minDurationMinutes) {
    throw new Error('Maximum duration must be at least the minimum duration.');
  }
}

export function localParts(date: Date, timezone: string): { date: string; time: string; day: DayName } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const dateValue = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date).toLowerCase() as DayName;
  return { date: dateValue, time: `${hour}:${parts.minute}`, day: weekday };
}

export function ruleForDate(config: Config, date: string, day: DayName): { rule: ScheduleRule | DateOverride; source: string } | undefined {
  const override = config.overrides.find((candidate) => candidate.date === date);
  if (override) return { rule: override, source: `date override ${date}` };
  const rule = config.weekly.find((candidate) => candidate.day === day);
  return rule ? { rule, source: `weekly ${day}` } : undefined;
}

export function inWindow(time: string, window: { start: string; end: string }): boolean {
  const current = minutes(time);
  return current >= minutes(window.start) && current <= minutes(window.end);
}

export function isWithinLeadWindow(time: string, target: string, leadMinutes = 15): boolean {
  const current = minutes(time);
  const targetMinutes = minutes(target);
  return current >= targetMinutes - leadMinutes && current < targetMinutes;
}

export function addMinutesToTime(time: string, amount: number): string {
  const total = minutes(time) + amount;
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function to24Hour(value: string): string {
  const match = /^(\d{1,2}):(\d{2})([ap])$/i.exec(value.replace(/\s/g, ''));
  if (!match) return value;
  let hour = Number(match[1]);
  if (match[3].toLowerCase() === 'p' && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === 'a' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

export interface CheckoutGuidance {
  verifiedCheckIn: string;
  earliestCheckout: string;
  configuredWindow: { start: string; end: string };
  eligibleWindow: { start: string; end: string };
  minimumReached: boolean;
  blockedReason?: string;
}

function seedRandom(seedStr: string): () => number {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(31, h) + seedStr.charCodeAt(i) | 0;
  }
  return function() {
    h = Math.imul(h ^ h >>> 16, 2246822507);
    h = Math.imul(h ^ h >>> 13, 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

export function getRandomPunchTimes(
  date: string,
  checkInWindow: { start: string; end: string },
  checkOutWindow: { start: string; end: string },
  seedOffset = 0
): { checkIn: string; checkOut: string } {
  const rng = seedRandom(`${date}-${seedOffset}`);
  const startIn = minutes(checkInWindow.start);
  const endIn = minutes(checkInWindow.end);
  const startOut = minutes(checkOutWindow.start);
  const endOut = minutes(checkOutWindow.end);

  for (let i = 0; i < 1000; i++) {
    const checkInMin = Math.floor(rng() * (endIn - startIn + 1)) + startIn;
    const checkOutMin = Math.floor(rng() * (endOut - startOut + 1)) + startOut;
    const duration = checkOutMin - checkInMin;
    if (duration >= 540 && duration <= 600) {
      return {
        checkIn: `${String(Math.floor(checkInMin / 60)).padStart(2, '0')}:${String(checkInMin % 60).padStart(2, '0')}`,
        checkOut: `${String(Math.floor(checkOutMin / 60)).padStart(2, '0')}:${String(checkOutMin % 60).padStart(2, '0')}`,
      };
    }
  }

  for (let checkInMin = startIn; checkInMin <= endIn; checkInMin++) {
    for (let checkOutMin = startOut; checkOutMin <= endOut; checkOutMin++) {
      const duration = checkOutMin - checkInMin;
      if (duration >= 540 && duration <= 600) {
        return {
          checkIn: `${String(Math.floor(checkInMin / 60)).padStart(2, '0')}:${String(checkInMin % 60).padStart(2, '0')}`,
          checkOut: `${String(Math.floor(checkOutMin / 60)).padStart(2, '0')}:${String(checkOutMin % 60).padStart(2, '0')}`,
        };
      }
    }
  }

  const fallbackCheckIn = startIn;
  const fallbackCheckOut = Math.min(endOut, startIn + 540);
  return {
    checkIn: `${String(Math.floor(fallbackCheckIn / 60)).padStart(2, '0')}:${String(fallbackCheckIn % 60).padStart(2, '0')}`,
    checkOut: `${String(Math.floor(fallbackCheckOut / 60)).padStart(2, '0')}:${String(fallbackCheckOut % 60).padStart(2, '0')}`,
  };
}

export function checkoutGuidance(config: Config, date: string, day: DayName, now: Date, checkIn: string): CheckoutGuidance | undefined {
  const selected = ruleForDate(config, date, day);
  if (!selected || !selected.rule.enabled) return undefined;
  const configuredWindow = selected.rule.checkOutWindow;
  const earliestCheckout = addMinutesToTime(to24Hour(checkIn), selected.rule.minDurationMinutes);
  const eligibleStart = minutes(earliestCheckout) > minutes(configuredWindow.start) ? earliestCheckout : configuredWindow.start;
  const minimumReached = durationMinutes(to24Hour(checkIn), now, config.timezone) >= selected.rule.minDurationMinutes;
  const blockedReason = minutes(eligibleStart) > minutes(configuredWindow.end)
    ? `The 9-hour minimum reaches ${earliestCheckout}, after the configured window ends at ${configuredWindow.end}.`
    : undefined;
  return { verifiedCheckIn: checkIn, earliestCheckout, configuredWindow, eligibleWindow: { start: eligibleStart, end: configuredWindow.end }, minimumReached, blockedReason };
}

export function durationMinutes(checkIn: string, now: Date, timezone: string): number {
  const current = localParts(now, timezone).time;
  let delta = minutes(current) - minutes(checkIn);
  if (delta < 0) delta += 24 * 60;
  return delta;
}

export interface NextScheduledAction {
  action: ActionType;
  date: string;
  windowStart: string;
  windowEnd: string;
  checkInWindow: { start: string; end: string };
  checkOutWindow: { start: string; end: string };
  punchOutWindow: { start: string; end: string };
  scheduleSource: string;
  availableNow: boolean;
}

export interface ForecastDay {
  date: string;
  day: DayName;
  shift?: string;
  status: 'scheduled' | 'holiday' | 'leave' | 'skip' | 'off';
  checkIn?: string;
  checkOut?: string;
  checkInWindow?: { start: string; end: string };
  checkOutWindow?: { start: string; end: string };
  scheduleSource?: string;
}

function addCalendarDays(date: string, amount: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function dayForDate(date: string): DayName {
  return dayNames[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function punchTimesForDate(date: string, rule: ScheduleRule | DateOverride, seeds: Record<string, number>, timeOverrides: ScheduleTimeOverrides): { checkIn: string; checkOut: string } {
  const randomized = getRandomPunchTimes(date, rule.checkInWindow, rule.checkOutWindow, seeds[date] || 0);
  const override = timeOverrides[date] || {};
  return { checkIn: override['check-in'] || randomized.checkIn, checkOut: override['check-out'] || randomized.checkOut };
}

export function upcomingWorkdayForecast(config: Config, now: Date, seeds: Record<string, number> = {}, exceptions: ScheduleException[] = [], timeOverrides: ScheduleTimeOverrides = {}): ForecastDay[] {
  const current = localParts(now, config.timezone);
  const exceptionByDate = new Map(exceptions.map((exception) => [exception.date, exception]));
  const forecast: ForecastDay[] = [];
  for (let offset = 1; offset <= 21 && forecast.length < 5; offset += 1) {
    const date = addCalendarDays(current.date, offset);
    const day = dayForDate(date);
    if (day === 'saturday' || day === 'sunday') continue;
    const exception = exceptionByDate.get(date);
    const selected = ruleForDate(config, date, day);
    if (exception) {
      forecast.push({ date, day, status: exception.type });
      continue;
    }
    if (!selected || !selected.rule.enabled) {
      forecast.push({ date, day, status: 'off', shift: selected?.rule.shift, scheduleSource: selected?.source });
      continue;
    }
    const randomized = punchTimesForDate(date, selected.rule, seeds, timeOverrides);
    forecast.push({ date, day, shift: selected.rule.shift, status: 'scheduled', checkIn: randomized.checkIn, checkOut: randomized.checkOut, checkInWindow: selected.rule.checkInWindow, checkOutWindow: selected.rule.checkOutWindow, scheduleSource: selected.source });
  }
  return forecast;
}

export function nextScheduledAction(config: Config, now: Date, seeds?: Record<string, number>, excludedDates?: Set<string>, timeOverrides: ScheduleTimeOverrides = {}): NextScheduledAction | undefined {
  const current = localParts(now, config.timezone);
  const currentMinutes = minutes(current.time);
  for (let offset = 0; offset <= 14; offset += 1) {
    const date = addCalendarDays(current.date, offset);
    if (excludedDates?.has(date)) continue;
    const selected = ruleForDate(config, date, dayForDate(date));
    if (!selected || !selected.rule.enabled) continue;
    const seedOffset = seeds ? (seeds[date] || 0) : 0;
    const randomized = punchTimesForDate(date, selected.rule, seeds || {}, timeOverrides);
    const windows: Array<[ActionType, { start: string; end: string }]> = [
      ['check-in', { start: randomized.checkIn, end: selected.rule.checkInWindow.end }],
      ['check-out', { start: randomized.checkOut, end: selected.rule.checkOutWindow.end }],
    ];
    for (const [action, window] of windows) {
      const start = minutes(window.start);
      const end = minutes(window.end);
      if (offset === 0 && currentMinutes > end) continue;
      return {
        action,
        date,
        windowStart: window.start,
        windowEnd: window.end,
        checkInWindow: selected.rule.checkInWindow,
        checkOutWindow: selected.rule.checkOutWindow,
        punchOutWindow: { start: randomized.checkOut, end: selected.rule.checkOutWindow.end },
        scheduleSource: selected.source,
        availableNow: offset === 0 && currentMinutes >= start && currentMinutes <= end,
      };
    }
  }
  return undefined;
}
