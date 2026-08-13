import { rigoBrowser } from './browser.js';
import { localParts, ruleForDate, inWindow, isWithinLeadWindow, minutes, durationMinutes, addMinutesToTime, validateRule, getRandomPunchTimes } from './schedule.js';
import { makeId, store } from './store.js';
import { plannedActionContext, sendNotification } from './mailer.js';
import type { ActionType, LogEntry, PlannedAction } from './types.js';

const timezone = () => store.config.timezone;
const AUTO_LEAD_MINUTES = 15;
const SCHEDULER_INTERVAL_MS = 15_000;
const SCHEDULER_STALE_AFTER_MS = SCHEDULER_INTERVAL_MS * 3;
const displayAction = (action: ActionType): string => action === 'check-in' ? 'Punch-in' : 'Punch-out';
let schedulerStartedAt: Date | undefined;
let schedulerLastTickAt: Date | undefined;
let schedulerLastError = false;

export function schedulerStatus(now = new Date()): { active: boolean; state: 'active' | 'starting' | 'inactive' | 'error'; startedAt?: string; lastTickAt?: string; intervalMs: number } {
  if (!schedulerStartedAt) return { active: false, state: 'inactive', intervalMs: SCHEDULER_INTERVAL_MS };
  const lastTickAge = schedulerLastTickAt ? now.getTime() - schedulerLastTickAt.getTime() : Number.POSITIVE_INFINITY;
  const state = schedulerLastError ? 'error' : lastTickAge > SCHEDULER_STALE_AFTER_MS ? 'inactive' : schedulerLastTickAt ? 'active' : 'starting';
  return { active: state === 'active', state, startedAt: schedulerStartedAt.toISOString(), lastTickAt: schedulerLastTickAt?.toISOString(), intervalMs: SCHEDULER_INTERVAL_MS };
}

function log(message: string, fields: Partial<LogEntry> = {}): void {
  store.addLog({ id: makeId('log'), timestamp: new Date().toISOString(), date: fields.date || localParts(new Date(), timezone()).date, message, status: fields.status || 'info', ...fields });
}

async function notify(action: PlannedAction, state: 'scheduled' | 'verified' | 'failed' | 'blocked' | 'skipped', message: string, extra: Partial<Parameters<typeof plannedActionContext>[3]> = {}): Promise<void> {
  try {
    const result = await sendNotification(plannedActionContext(action, state, message, extra), store.config.notificationEmails);
    log(result.sent ? `Email notification sent to ${result.recipients?.join(', ')}.` : 'Email notification not configured; no message sent.', { runId: action.id, action: action.action, date: action.date, status: 'info', emailNotification: result.sent ? 'sent' : 'not_configured' });
  } catch (error) {
    const safeMessage = error instanceof Error ? error.message : 'Email notification failed.';
    log(`Email notification failed: ${safeMessage}`, { runId: action.id, action: action.action, date: action.date, status: 'failed', errorCategory: 'email_notification', emailNotification: 'failed' });
  }
}

async function planFor(action: ActionType, now: Date): Promise<PlannedAction | undefined> {
  const parts = localParts(now, timezone());
  const exception = store.getException(parts.date);
  if (exception) return undefined;
  const selected = ruleForDate(store.config, parts.date, parts.day);
  if (!selected || !selected.rule.enabled) return undefined;
  validateRule(selected.rule);
  const seedOffset = store.getRandomSeed(parts.date);
  const randomized = getRandomPunchTimes(parts.date, selected.rule.checkInWindow, selected.rule.checkOutWindow, seedOffset);
  const targetWindow = action === 'check-in'
    ? { start: randomized.checkIn, end: selected.rule.checkInWindow.end }
    : { start: randomized.checkOut, end: selected.rule.checkOutWindow.end };
  const inPreparationWindow = isWithinLeadWindow(parts.time, targetWindow.start, AUTO_LEAD_MINUTES);
  const punchWindowOpen = inWindow(parts.time, targetWindow);
  if (!inPreparationWindow && !punchWindowOpen) return undefined;
  const existing = store.actions.find((candidate) => candidate.date === parts.date && candidate.action === action && ['scheduled', 'waiting_confirmation', 'clicked', 'verified', 'skipped'].includes(candidate.state));
  if (existing) return undefined;
  if (action === 'check-out') {
    const verifiedCheckIn = store.actions.find((candidate) => candidate.date === parts.date && candidate.action === 'check-in' && candidate.checkIn && ['verified', 'skipped'].includes(candidate.state));
    if (!verifiedCheckIn?.checkIn) return undefined;
  }
  const scheduledFor = new Date(`${parts.date}T${targetWindow.start}:00+05:45`);
  const planned: PlannedAction = {
    id: makeId('action'), date: parts.date, action, scheduleSource: selected.source, targetWindow,
    checkInWindow: selected.rule.checkInWindow, checkOutWindow: selected.rule.checkOutWindow,
    minDurationMinutes: selected.rule.minDurationMinutes, maxDurationMinutes: selected.rule.maxDurationMinutes,
    state: 'scheduled', createdAt: now.toISOString(), scheduledFor: scheduledFor.toISOString(), expiresAt: scheduledFor.toISOString(),
  };
  if (action === 'check-in') {
    const observed = await rigoBrowser.readAttendance(parts.date, `preflight-${action}-${parts.date}`);
    if (observed.record) store.upsertAttendance(observed.record);
    log(`Preflight RigoHR check completed before arming automatic ${displayAction(action)}.`, { runId: planned.id, action, status: 'info', date: parts.date, url: observed.url, observedPageState: observed.pageState, observedCheckIn: observed.record?.checkIn, observedCheckOut: observed.record?.checkOut, screenshots: observed.screenshots });
    if (observed.record?.checkIn) {
      const warning = `Automatic punch-in not armed: RigoHR already recorded punch-in at ${observed.record.checkIn}. No punch-in was submitted.`;
      const skipped = { ...planned, state: 'skipped' as const, warning, checkIn: observed.record.checkIn };
      store.addAction(skipped);
      log(warning, { runId: planned.id, action, status: 'skipped', date: parts.date, observedCheckIn: observed.record.checkIn, observedCheckOut: observed.record.checkOut, verificationResult: 'duplicate-punch-in-detected' });
      await notify(skipped, 'skipped', warning, { record: observed.record, currentUrl: observed.url, observedPageState: observed.pageState, screenshotPaths: observed.screenshots.map((s) => s.path) });
      return undefined;
    }
  }
  store.addAction(planned);
  log(`${displayAction(action)} scheduled automatically for ${targetWindow.start}; cancellation is available until execution.`, { runId: planned.id, action, status: 'scheduled', date: parts.date, scheduleSource: selected.source, scheduledFor: planned.scheduledFor });
  const minutesUntilPunch = Math.max(0, minutes(targetWindow.start) - minutes(parts.time));
  void notify(planned, 'scheduled', `${action} is scheduled automatically for ${targetWindow.start} Nepal Time, in approximately ${minutesUntilPunch} minutes. Open the local UI and cancel this scheduled action before that time if you do not want it submitted.`, { observedPageState: 'local schedule armed' });
  return planned;
}

function eligibilityReason(action: ActionType, now: Date): string {
  const parts = localParts(now, timezone());
  const exception = store.getException(parts.date);
  if (exception) return `${displayAction(action)}: today is marked as ${exception.type}; no attendance routine will run.`;
  const selected = ruleForDate(store.config, parts.date, parts.day);
  if (!selected) return `${displayAction(action)}: no weekly rule or date override applies today.`;
  if (!selected.rule.enabled) return `${displayAction(action)}: today’s ${selected.source} is disabled.`;
  const seedOffset = store.getRandomSeed(parts.date);
  const randomized = getRandomPunchTimes(parts.date, selected.rule.checkInWindow, selected.rule.checkOutWindow, seedOffset);
  const targetWindow = action === 'check-in'
    ? { start: randomized.checkIn, end: selected.rule.checkInWindow.end }
    : { start: randomized.checkOut, end: selected.rule.checkOutWindow.end };
  if (!isWithinLeadWindow(parts.time, targetWindow.start, AUTO_LEAD_MINUTES) && !inWindow(parts.time, targetWindow)) return `${displayAction(action)}: current time ${parts.time} is outside the 15-minute preparation window before ${targetWindow.start}.`;
  const existing = store.actions.find((candidate) => candidate.date === parts.date && candidate.action === action && ['scheduled', 'waiting_confirmation', 'clicked', 'verified', 'skipped'].includes(candidate.state));
  if (existing) return `${displayAction(action)}: an action is already ${existing.state} for today.`;
  return `${displayAction(action)}: eligible for automatic scheduling; punch is planned for ${targetWindow.start}.`;
}

export async function evaluate(now = new Date()): Promise<PlannedAction[]> {
  const created: PlannedAction[] = [];
  for (const action of ['check-in', 'check-out'] as ActionType[]) {
    const plan = await planFor(action, now);
    if (plan) created.push(plan);
  }
  return created;
}

export async function manualRequest(action: ActionType, now = new Date()): Promise<PlannedAction | undefined> {
  const plan = await planFor(action, now);
  const parts = localParts(now, timezone());
  log(plan ? `Automatic ${displayAction(action)} schedule prepared manually.` : `Manual request for ${displayAction(action)} was not eligible at ${parts.time}.`, { action, date: parts.date, status: plan ? 'scheduled' : 'dry_run' });
  return plan;
}

export async function preview(now = new Date()): Promise<{ plans: PlannedAction[]; state: string }> {
  const parts = localParts(now, timezone());
  const exception = store.getException(parts.date);
  if (exception) {
    log(`Dry run: today is marked as ${exception.type}; no actions are eligible.`, { status: 'dry_run', date: parts.date, errorCategory: 'schedule_exception' });
    return { plans: [], state: 'schedule_exception' };
  }
  const selected = ruleForDate(store.config, parts.date, parts.day);
  if (!selected || !selected.rule.enabled) {
    log('Dry run: no enabled schedule for today.', { status: 'dry_run', date: parts.date });
    return { plans: [], state: 'no_schedule' };
  }
  const reasons = ([ 'check-in', 'check-out' ] as ActionType[]).map((action) => eligibilityReason(action, now));
  const plans = await evaluate(now);
  log(`Dry run at ${parts.time}: ${plans.length} eligible action(s). ${reasons.join(' ')}`, { status: 'dry_run', date: parts.date, scheduleSource: selected.source });
  return { plans, state: plans.length ? 'scheduled' : 'outside_window_or_already_planned' };
}

export async function executeAction(id: string): Promise<PlannedAction> {
  const action = store.actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error('Action was not found.');
  if (action.state !== 'scheduled') {
    if (action.state === 'skipped') return action;
    const message = `This action is not scheduled; current state is ${action.state}.`;
    await notify(action, 'failed', message);
    throw new Error(message);
  }
  const now = new Date();
  if (new Date(action.scheduledFor).getTime() > now.getTime()) {
    const message = `This action is scheduled for ${action.scheduledFor}.`;
    throw new Error(message);
  }
  const parts = localParts(now, timezone());
  if (parts.date !== action.date) {
    const message = 'The action is no longer for today.';
    await notify(action, 'failed', message);
    throw new Error(message);
  }
  const exception = store.getException(action.date);
  if (exception) {
    const warning = `Skipped ${displayAction(action.action).toLowerCase()}; ${action.date} is marked as ${exception.type}.`;
    store.updateAction(id, { state: 'skipped', warning, cancelledAt: now.toISOString() });
    log(warning, { runId: id, action: action.action, status: 'skipped', date: action.date, errorCategory: 'schedule_exception' });
    return { ...action, state: 'skipped', warning, cancelledAt: now.toISOString() };
  }
  const selected = ruleForDate(store.config, action.date, parts.day);
  if (!selected || !selected.rule.enabled) {
    const message = 'The schedule is no longer enabled.';
    await notify(action, 'failed', message);
    throw new Error(message);
  }
  if (!inWindow(parts.time, action.targetWindow)) {
    const message = 'The current time is outside the configured window.';
    await notify(action, 'failed', message);
    throw new Error(message);
  }

  let observed: Awaited<ReturnType<typeof rigoBrowser.readAttendance>> | undefined;
  try {
    observed = await rigoBrowser.readAttendance(action.date, `${id}-before-action`);
    if (observed.record) store.upsertAttendance(observed.record);
    store.updateAction(id, { checkIn: observed.record?.checkIn });
    log(`Pre-action RigoHR check completed before ${displayAction(action.action)}.`, { runId: id, action: action.action, status: 'info', date: action.date, url: observed.url, observedPageState: observed.pageState, observedCheckIn: observed.record?.checkIn, observedCheckOut: observed.record?.checkOut, screenshots: observed.screenshots });
    if (action.action === 'check-in' && observed.record?.checkIn) {
      const warning = `Automatic punch-in skipped: RigoHR already recorded punch-in at ${observed.record.checkIn}; no punch-in was submitted.`;
      store.updateAction(id, { state: 'skipped', warning, checkIn: observed.record.checkIn });
      log(warning, { runId: id, action: action.action, status: 'skipped', date: action.date, observedCheckIn: observed.record.checkIn, observedCheckOut: observed.record.checkOut, verificationResult: 'duplicate-punch-in-detected' });
      await notify(action, 'skipped', warning, { record: observed.record, currentUrl: observed.url, observedPageState: observed.pageState, screenshotPaths: observed.screenshots.map((s) => s.path) });
      return { ...action, state: 'skipped', warning, checkIn: observed.record.checkIn };
    }
    if (action.action === 'check-out') {
      if (!observed.record?.checkIn) {
        const warning = 'Punch-out blocked because a verified punch-in was not found.';
        store.updateAction(id, { state: 'blocked', warning });
        log(warning, { runId: id, action: action.action, status: 'blocked', date: action.date, errorCategory: 'missing_check_in' });
        await notify(action, 'blocked', warning, { record: observed.record, currentUrl: observed.url, observedPageState: observed.pageState, screenshotPaths: observed.screenshots.map((s) => s.path) });
        return { ...action, state: 'blocked', warning };
      }
      if (observed.record.checkOut) {
        store.updateAction(id, { state: 'skipped' });
        log('Skipped duplicate punch-out; attendance already contains punch-out.', { runId: id, action: action.action, status: 'skipped', date: action.date, observedCheckIn: observed.record.checkIn, observedCheckOut: observed.record.checkOut });
        return { ...action, state: 'skipped' };
      }
      const elapsed = durationMinutes(to24Hour(observed.record.checkIn), now, timezone());
      if (elapsed < action.minDurationMinutes) {
        const earliest = addMinutesToTime(to24Hour(observed.record.checkIn), action.minDurationMinutes);
        store.updateAction(id, { state: 'blocked', warning: `Minimum duration not reached; earliest punch-out is ${earliest}.` });
        log(`Punch-out blocked until ${earliest}; only ${elapsed} minutes elapsed.`, { runId: id, action: action.action, status: 'blocked', date: action.date, observedCheckIn: observed.record.checkIn, errorCategory: 'minimum_duration' });
        await notify(action, 'blocked', `Punch-out blocked until ${earliest}; only ${elapsed} minutes elapsed.`, { record: observed.record, currentUrl: observed.url, observedPageState: observed.pageState, screenshotPaths: observed.screenshots.map((s) => s.path) });
        return { ...action, state: 'blocked', warning: `Minimum duration not reached; earliest punch-out is ${earliest}.` };
      }
      if (elapsed > action.maxDurationMinutes) {
        log(`Punch-out is beyond configured maximum duration (${action.maxDurationMinutes} minutes); automatic execution continues with a warning.`, { runId: id, action: action.action, status: 'info', date: action.date, observedCheckIn: observed.record.checkIn, errorCategory: 'maximum_duration_warning' });
      }
    }

    store.updateAction(id, { state: 'clicked' });
    const clickScreenshots = await rigoBrowser.clickPunch(action.action, `${id}-${action.action}`);
    log(`Clicked ${displayAction(action.action)} automatically, refreshed the home page, and will verify the dashboard attendance record.`, { runId: id, action: action.action, status: 'clicked', date: action.date, scheduledFor: action.scheduledFor, executionAt: now.toISOString(), screenshots: clickScreenshots });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const verified = await rigoBrowser.readAttendance(action.date, `${id}-after-action`);
    if (verified.record) store.upsertAttendance(verified.record);
    const verifiedValue = action.action === 'check-in' ? verified.record?.checkIn : verified.record?.checkOut;
    if (!verifiedValue) throw new Error(`Post-action verification failed: no ${action.action} value was visible for ${action.date}.`);
    store.updateAction(id, { state: 'verified', checkIn: verified.record?.checkIn });
    log(`Verified ${displayAction(action.action)} at ${verifiedValue}.`, { runId: id, action: action.action, status: 'verified', date: action.date, url: verified.url, observedPageState: verified.pageState, observedCheckIn: verified.record?.checkIn, observedCheckOut: verified.record?.checkOut, verificationResult: verifiedValue, screenshots: verified.screenshots });
    await notify(action, 'verified', `Verified ${displayAction(action.action)} at ${verifiedValue}.`, { record: verified.record, currentUrl: verified.url, observedPageState: verified.pageState, screenshotPaths: [...observed.screenshots, ...verified.screenshots].map((s) => s.path) });
    return { ...action, state: 'verified', checkIn: verified.record?.checkIn };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown automation error.';
    const screenshotPath = (await rigoBrowser.evidence(`${id}-${action.action}.png`).catch(() => '')) || undefined;
    store.updateAction(id, { state: 'failed', warning: message });
    log(message, { runId: id, action: action.action, status: 'failed', date: action.date, screenshotPath, errorCategory: 'automation' });
    await notify(action, 'failed', message, { record: observed?.record, currentUrl: observed?.url, observedPageState: observed?.pageState, screenshotPaths: observed?.screenshots.map((s) => s.path) });
    throw new Error(message);
  }
}

export function cancelAction(id: string): PlannedAction {
  const action = store.actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error('Action was not found.');
  if (action.state !== 'scheduled') throw new Error(`Only scheduled actions can be cancelled; current state is ${action.state}.`);
  const cancelledAt = new Date().toISOString();
  const updated = store.updateAction(id, { state: 'skipped', cancelledAt, warning: 'Cancelled by user before automatic execution.' });
  log(`Cancelled scheduled ${displayAction(action.action)} before automatic execution.`, { runId: id, action: action.action, status: 'skipped', date: action.date, errorCategory: 'user_cancelled' });
  if (!updated) throw new Error('Action could not be cancelled.');
  return updated;
}

function to24Hour(value: string): string {
  const match = /^(\d{1,2}):(\d{2})([ap])$/i.exec(value.replace(/\s/g, ''));
  if (!match) return value;
  let hour = Number(match[1]);
  if (match[3].toLowerCase() === 'p' && hour !== 12) hour += 12;
  if (match[3].toLowerCase() === 'a' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

async function schedulerTick(): Promise<void> {
  schedulerLastTickAt = new Date();
  schedulerLastError = false;
  try {
    await evaluate();
    const due = store.actions.filter((action) => action.state === 'scheduled' && new Date(action.scheduledFor).getTime() <= Date.now());
    for (const action of due) {
      try { await executeAction(action.id); } catch (error) { log(error instanceof Error ? error.message : 'Automatic action failed.', { runId: action.id, action: action.action, date: action.date, status: 'failed', errorCategory: 'scheduler_execution' }); }
    }
  } catch (error) {
    schedulerLastError = true;
    log(error instanceof Error ? error.message : 'Scheduler error.', { status: 'failed', errorCategory: 'scheduler' });
  }
}

export function startScheduler(): NodeJS.Timeout {
  schedulerStartedAt = new Date();
  void schedulerTick();
  return setInterval(() => { void schedulerTick(); }, SCHEDULER_INTERVAL_MS);
}
