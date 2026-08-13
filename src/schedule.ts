import type { ActionType, Config, DateOverride, DayName, ScheduleException, ScheduleRule, ScheduleTimeOverrides } from './types.js';

export const dayNames: DayName[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const MIN_PLANNED_DURATION_MINUTES = 540;
export const MAX_PLANNED_DURATION_MINUTES = 600;

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
  if (!Number.isInteger(rule.minDurationMinutes) || rule.minDurationMinutes < MIN_PLANNED_DURATION_MINUTES) {
    throw new Error('Minimum duration must be at least 540 minutes (9 hours).');
  }
  if (!Number.isInteger(rule.maxDurationMinutes) || rule.maxDurationMinutes > MAX_PLANNED_DURATION_MINUTES || rule.maxDurationMinutes <= rule.minDurationMinutes) {
    throw new Error('Maximum planned duration must be greater than the minimum and less than or equal to 600 minutes (10 hours).');
  }
  const validOutStart = checkOutStart + 1;
  const validOutEnd = checkOutEnd - 1;
  if (validOutStart > validOutEnd) throw new Error('Punch-out window must contain a time strictly after its start and before its end.');
  const hasFeasiblePair = findPlannedPunchPair(rule.checkInWindow, rule.checkOutWindow, rule.minDurationMinutes, rule.maxDurationMinutes) !== undefined;
  if (!hasFeasiblePair) {
    throw new Error('Punch-in and punch-out windows cannot produce a planned span of at least 9 hours and less than 10 hours.');
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

function formatMinutes(total: number): string {
  const normalized = ((total % (24 * 60)) + (24 * 60)) % (24 * 60);
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function findPlannedPunchPair(
  checkInWindow: { start: string; end: string },
  checkOutWindow: { start: string; end: string },
  minDurationMinutes = MIN_PLANNED_DURATION_MINUTES,
  maxDurationMinutes = MAX_PLANNED_DURATION_MINUTES,
): { checkIn: string; checkOut: string } | undefined {
  const startIn = minutes(checkInWindow.start);
  const endIn = minutes(checkInWindow.end);
  const startOut = minutes(checkOutWindow.start) + 1;
  const endOut = minutes(checkOutWindow.end) - 1;
  if (startOut > endOut) return undefined;
  for (let checkInMin = startIn; checkInMin <= endIn; checkInMin++) {
    for (let checkOutMin = startOut; checkOutMin <= endOut; checkOutMin++) {
      const duration = checkOutMin - checkInMin;
      if (duration >= minDurationMinutes && duration < maxDurationMinutes) {
        return { checkIn: formatMinutes(checkInMin), checkOut: formatMinutes(checkOutMin) };
      }
    }
  }
  return undefined;
}

export function validatePlannedPunchTimes(
  checkIn: string,
  checkOut: string,
  rule: Pick<ScheduleRule, 'checkInWindow' | 'checkOutWindow' | 'minDurationMinutes' | 'maxDurationMinutes'>,
): void {
  const checkInMinutes = minutes(checkIn);
  const checkOutMinutes = minutes(checkOut);
  if (checkInMinutes < minutes(rule.checkInWindow.start) || checkInMinutes > minutes(rule.checkInWindow.end)) {
    throw new Error(`Punch-in time must be within ${rule.checkInWindow.start}–${rule.checkInWindow.end}.`);
  }
  if (checkOutMinutes <= minutes(rule.checkOutWindow.start) || checkOutMinutes >= minutes(rule.checkOutWindow.end)) {
    throw new Error(`Punch-out time must be after ${rule.checkOutWindow.start} and before ${rule.checkOutWindow.end}.`);
  }
  const duration = checkOutMinutes - checkInMinutes;
  if (duration < rule.minDurationMinutes || duration >= rule.maxDurationMinutes) {
    throw new Error(`Planned span must be at least ${rule.minDurationMinutes / 60} hours and less than ${rule.maxDurationMinutes / 60} hours.`);
  }
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
  seedOffset = 0,
  minDurationMinutes = MIN_PLANNED_DURATION_MINUTES,
  maxDurationMinutes = MAX_PLANNED_DURATION_MINUTES,
): { checkIn: string; checkOut: string } {
  const rng = seedRandom(`${date}-${seedOffset}`);
  const startIn = minutes(checkInWindow.start);
  const endIn = minutes(checkInWindow.end);
  const startOut = minutes(checkOutWindow.start) + 1;
  const endOut = minutes(checkOutWindow.end) - 1;

  for (let i = 0; i < 1000; i++) {
    if (startOut > endOut) break;
    const checkInMin = Math.floor(rng() * (endIn - startIn + 1)) + startIn;
    const checkOutMin = Math.floor(rng() * (endOut - startOut + 1)) + startOut;
    const duration = checkOutMin - checkInMin;
    if (duration >= minDurationMinutes && duration < maxDurationMinutes) return { checkIn: formatMinutes(checkInMin), checkOut: formatMinutes(checkOutMin) };
  }

  for (let checkInMin = startIn; checkInMin <= endIn; checkInMin++) {
    for (let checkOutMin = startOut; checkOutMin <= endOut; checkOutMin++) {
      const duration = checkOutMin - checkInMin;
      if (duration >= minDurationMinutes && duration < maxDurationMinutes) return { checkIn: formatMinutes(checkInMin), checkOut: formatMinutes(checkOutMin) };
    }
  }

  throw new Error('Punch-in and punch-out windows cannot produce a planned span of at least 9 hours and less than 10 hours.');
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
  shift: string;
  windowExpired?: boolean;
  windowStart: string;
  windowEnd: string;
  checkInWindow: { start: string; end: string };
  checkOutWindow: { start: string; end: string };
  punchOutWindow: { start: string; end: string };
  plannedCheckIn: string;
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
  validateRule(rule);
  const randomized = getRandomPunchTimes(date, rule.checkInWindow, rule.checkOutWindow, seeds[date] || 0, rule.minDurationMinutes, rule.maxDurationMinutes);
  const override = timeOverrides[date] || {};
  const planned = { checkIn: override['check-in'] || randomized.checkIn, checkOut: override['check-out'] || randomized.checkOut };
  validatePlannedPunchTimes(planned.checkIn, planned.checkOut, rule);
  return planned;
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
    let expiredToday: NextScheduledAction | undefined;
    for (const [action, window] of windows) {
      const start = minutes(window.start);
      const end = minutes(window.end);
      const result: NextScheduledAction = {
        action,
        date,
        shift: selected.rule.shift,
        windowStart: window.start,
        windowEnd: window.end,
        checkInWindow: selected.rule.checkInWindow,
        checkOutWindow: selected.rule.checkOutWindow,
        punchOutWindow: { start: randomized.checkOut, end: selected.rule.checkOutWindow.end },
        plannedCheckIn: randomized.checkIn,
        scheduleSource: selected.source,
        availableNow: offset === 0 && currentMinutes >= start && currentMinutes <= end,
      };
      if (offset === 0 && currentMinutes > end) {
        if (action === 'check-out') expiredToday = { ...result, windowExpired: true };
        continue;
      }
      return result;
    }
    if (expiredToday) return expiredToday;
  }
  return undefined;
}
