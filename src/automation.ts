import { isUncertainPunchError, rigoBrowser } from './browser.js';
import { defaultConfig } from './config.js';
import { localParts, ruleForDate, inWindow, isWithinLeadWindow, minutes, durationMinutes, addMinutesToTime, validatePlannedPunchTimes, validateRule, getRandomPunchTimes } from './schedule.js';
import { makeId, store } from './store.js';
import { plannedActionContext, sendNotification } from './mailer.js';
import type { ActionType, AttendanceRecord, LogEntry, PlannedAction } from './types.js';

const timezone = () => store.config.timezone;
const AUTO_LEAD_MINUTES = 15;
const SCHEDULER_INTERVAL_MS = 15_000;
const SCHEDULER_STALE_AFTER_MS = SCHEDULER_INTERVAL_MS * 3;
const displayAction = (action: ActionType): string => action === 'check-in' ? 'Punch-in' : 'Punch-out';

export interface PunchReconciliation {
  verified: boolean;
  value?: string;
  message: string;
}

export function reconcilePunchOutcome(action: ActionType, record: AttendanceRecord | undefined): PunchReconciliation {
  const value = action === 'check-in' ? record?.checkIn : record?.checkOut;
  if (value) {
    return {
      verified: true,
      value,
      message: `${displayAction(action)} verified at ${value} after the browser session closed; the punch was not retried.`,
    };
  }
  return {
    verified: false,
    message: `${displayAction(action)} result could not be verified after the browser session closed; the punch was not retried.`,
  };
}
let schedulerStartedAt: Date | undefined;
let schedulerLastTickAt: Date | undefined;
let schedulerLastError = false;
let schedulerTickInProgress = false;
const executingActionIds = new Set<string>();

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
  const randomizedBase = getRandomPunchTimes(parts.date, selected.rule.checkInWindow, selected.rule.checkOutWindow, seedOffset, selected.rule.minDurationMinutes, selected.rule.maxDurationMinutes);
  const scheduledOverride = store.scheduleTimeOverrides[parts.date] || {};
  const randomized = { checkIn: scheduledOverride['check-in'] || randomizedBase.checkIn, checkOut: scheduledOverride['check-out'] || randomizedBase.checkOut };
  validatePlannedPunchTimes(randomized.checkIn, randomized.checkOut, selected.rule, {
    allowCheckInWindowOverride: Boolean(scheduledOverride['check-in']),
    allowCheckOutWindowOverride: Boolean(scheduledOverride['check-out']),
  });
  const targetWindow = action === 'check-in'
    ? { start: randomized.checkIn, end: scheduledOverride['check-in'] ? randomized.checkIn : selected.rule.checkInWindow.end }
    : { start: randomized.checkOut, end: scheduledOverride['check-out'] ? randomized.checkOut : selected.rule.checkOutWindow.end };
  const inPreparationWindow = isWithinLeadWindow(parts.time, targetWindow.start, AUTO_LEAD_MINUTES);
  const punchWindowOpen = inWindow(parts.time, targetWindow);
  if (!inPreparationWindow && !punchWindowOpen) return undefined;
  const existing = store.actions.find((candidate) => candidate.date === parts.date && candidate.action === action && ['scheduled', 'waiting_confirmation', 'clicked', 'verified', 'skipped', 'failed'].includes(candidate.state));
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
  const randomizedBase = getRandomPunchTimes(parts.date, selected.rule.checkInWindow, selected.rule.checkOutWindow, seedOffset, selected.rule.minDurationMinutes, selected.rule.maxDurationMinutes);
  const scheduledOverride = store.scheduleTimeOverrides[parts.date] || {};
  const randomized = { checkIn: scheduledOverride['check-in'] || randomizedBase.checkIn, checkOut: scheduledOverride['check-out'] || randomizedBase.checkOut };
  validatePlannedPunchTimes(randomized.checkIn, randomized.checkOut, selected.rule, {
    allowCheckInWindowOverride: Boolean(scheduledOverride['check-in']),
    allowCheckOutWindowOverride: Boolean(scheduledOverride['check-out']),
  });
  const targetWindow = action === 'check-in'
    ? { start: randomized.checkIn, end: scheduledOverride['check-in'] ? randomized.checkIn : selected.rule.checkInWindow.end }
    : { start: randomized.checkOut, end: scheduledOverride['check-out'] ? randomized.checkOut : selected.rule.checkOutWindow.end };
  if (!isWithinLeadWindow(parts.time, targetWindow.start, AUTO_LEAD_MINUTES) && !inWindow(parts.time, targetWindow)) return `${displayAction(action)}: current time ${parts.time} is outside the 15-minute preparation window before ${targetWindow.start}.`;
  const existing = store.actions.find((candidate) => candidate.date === parts.date && candidate.action === action && ['scheduled', 'waiting_confirmation', 'clicked', 'verified', 'skipped', 'failed'].includes(candidate.state));
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

export function hardPunchDecision(action: ActionType, record: AttendanceRecord | undefined, now: Date, timezoneName: string, minDurationMinutes: number): { state: 'eligible' | 'skipped' | 'blocked'; message?: string } {
  if (action === 'check-in' && record?.checkIn) {
    return { state: 'skipped', message: `Hard punch-in skipped: RigoHR already recorded punch-in at ${record.checkIn}; no punch-in was submitted.` };
  }
  if (action === 'check-out') {
    if (!record?.checkIn) return { state: 'blocked', message: 'Hard punch-out blocked because RigoHR has no recorded punch-in for today.' };
    const elapsed = durationMinutes(to24Hour(record.checkIn), now, timezoneName);
    if (elapsed < minDurationMinutes) {
      const earliest = addMinutesToTime(to24Hour(record.checkIn), minDurationMinutes);
      return { state: 'blocked', message: `Hard punch-out blocked until ${earliest}; only ${elapsed} minutes have elapsed since punch-in.` };
    }
  }
  return { state: 'eligible' };
}

const hardPunchInProgress = new Set<ActionType>();

export async function hardPunchNow(action: ActionType, now = new Date()): Promise<PlannedAction> {
  if (hardPunchInProgress.has(action)) throw new Error(`A hard ${displayAction(action).toLowerCase()} is already in progress.`);
  hardPunchInProgress.add(action);
  const parts = localParts(now, timezone());
  const selected = ruleForDate(store.config, parts.date, parts.day);
  const fallbackRule = defaultConfig().weekly.find((rule) => rule.day === parts.day) || defaultConfig().weekly[0];
  const safetyRule = selected?.rule || fallbackRule;
  validateRule(safetyRule);
  const actionId = makeId('action');
  const scheduleSource = selected?.source || `manual ${parts.day}`;
  const planned: PlannedAction = {
    id: actionId,
    date: parts.date,
    action,
    scheduleSource,
    targetWindow: { start: parts.time, end: parts.time },
    checkInWindow: safetyRule.checkInWindow,
    checkOutWindow: safetyRule.checkOutWindow,
    minDurationMinutes: safetyRule.minDurationMinutes,
    maxDurationMinutes: safetyRule.maxDurationMinutes,
    state: 'scheduled',
    createdAt: now.toISOString(),
    scheduledFor: now.toISOString(),
    expiresAt: now.toISOString(),
  };
  let before: Awaited<ReturnType<typeof rigoBrowser.readAttendance>> | undefined;
  let punchAttempted = false;
  try {
    before = await rigoBrowser.readAttendance(parts.date, `${actionId}-hard-before`);
    if (before.record) store.upsertAttendance(before.record);
    log(`Hard ${displayAction(action).toLowerCase()} preflight completed; schedule window is ignored.`, { runId: actionId, action, date: parts.date, status: 'info', scheduleSource, url: before.url, observedPageState: before.pageState, observedCheckIn: before.record?.checkIn, observedCheckOut: before.record?.checkOut, screenshots: before.screenshots });
    const decision = hardPunchDecision(action, before.record, now, timezone(), safetyRule.minDurationMinutes);
    if (decision.state !== 'eligible') {
      const finished = { ...planned, state: decision.state, warning: decision.message } as PlannedAction;
      store.addAction(finished);
      log(decision.message || `Hard ${displayAction(action).toLowerCase()} was not submitted.`, { runId: actionId, action, date: parts.date, status: decision.state, scheduleSource, observedCheckIn: before.record?.checkIn, observedCheckOut: before.record?.checkOut, verificationResult: decision.state === 'skipped' ? 'duplicate-punch-in-detected' : 'hard-punch-safety-block' });
      await notify(finished, decision.state, decision.message || `Hard ${displayAction(action).toLowerCase()} was not submitted.`, { record: before.record, currentUrl: before.url, observedPageState: before.pageState, screenshotPaths: before.screenshots.map((s) => s.path) });
      return finished;
    }

    store.addAction(planned);
    log(`Hard ${displayAction(action).toLowerCase()} requested now; the configured schedule window was ignored.`, { runId: actionId, action, date: parts.date, status: 'scheduled', scheduleSource, scheduledFor: now.toISOString() });
    if (!store.claimScheduledAction(actionId)) throw new Error('Hard punch action could not be claimed; no punch was submitted.');
    punchAttempted = true;
    const clickScreenshots = await rigoBrowser.clickPunch(action, `${actionId}-hard-now`);
    log(`Clicked hard ${displayAction(action).toLowerCase()} now, refreshed the home page, and will verify the dashboard attendance record.`, { runId: actionId, action, date: parts.date, status: 'clicked', scheduleSource, executionAt: new Date().toISOString(), screenshots: clickScreenshots });
    const verified = await rigoBrowser.readAttendance(parts.date, `${actionId}-hard-after`);
    if (verified.record) store.upsertAttendance(verified.record);
    const verifiedValue = action === 'check-in' ? verified.record?.checkIn : verified.record?.checkOut;
    if (!verifiedValue) throw new Error(`Hard post-action verification failed: no ${displayAction(action).toLowerCase()} value was visible for ${parts.date}.`);
    store.updateAction(actionId, { state: 'verified', checkIn: verified.record?.checkIn });
    const message = `Hard ${displayAction(action).toLowerCase()} verified at ${verifiedValue}.`;
    log(message, { runId: actionId, action, date: parts.date, status: 'verified', scheduleSource, url: verified.url, observedPageState: verified.pageState, observedCheckIn: verified.record?.checkIn, observedCheckOut: verified.record?.checkOut, verificationResult: verifiedValue, screenshots: verified.screenshots });
    await notify({ ...planned, state: 'verified' }, 'verified', message, { record: verified.record, currentUrl: verified.url, observedPageState: verified.pageState, screenshotPaths: [...(before?.screenshots || []), ...verified.screenshots].map((s) => s.path) });
    return { ...planned, state: 'verified', checkIn: verified.record?.checkIn };
  } catch (error) {
    if (punchAttempted && isUncertainPunchError(error)) {
      let reconciled: Awaited<ReturnType<typeof rigoBrowser.readAttendance>> | undefined;
      let reconciliationError: string | undefined;
      try {
        reconciled = await rigoBrowser.readAttendance(parts.date, `${actionId}-hard-reconcile`);
        if (reconciled.record) store.upsertAttendance(reconciled.record);
      } catch (errorDuringReconciliation) {
        reconciliationError = errorDuringReconciliation instanceof Error ? errorDuringReconciliation.message : 'Attendance reconciliation failed.';
      }
      const outcome = reconcilePunchOutcome(action, reconciled?.record);
      const message = reconciliationError ? `${outcome.message} Reconciliation failed: ${reconciliationError}` : outcome.message;
      const screenshots = [...(before?.screenshots || []), ...(reconciled?.screenshots || [])];
      if (outcome.verified) {
        store.updateAction(actionId, { state: 'verified', checkIn: reconciled?.record?.checkIn });
        log(message, { runId: actionId, action, date: parts.date, status: 'verified', scheduleSource, url: reconciled?.url, observedPageState: reconciled?.pageState, observedCheckIn: reconciled?.record?.checkIn, observedCheckOut: reconciled?.record?.checkOut, verificationResult: outcome.value, screenshots });
        await notify({ ...planned, state: 'verified' }, 'verified', message, { record: reconciled?.record, currentUrl: reconciled?.url, observedPageState: reconciled?.pageState, screenshotPaths: screenshots.map((s) => s.path) });
        return { ...planned, state: 'verified', checkIn: reconciled?.record?.checkIn };
      }
      const failureScreenshots = rigoBrowser.failureEvidenceFrom(error);
      const screenshotPath = failureScreenshots[0]?.path || undefined;
      store.updateAction(actionId, { state: 'failed', warning: message });
      log(message, { runId: actionId, action, date: parts.date, status: 'failed', scheduleSource, screenshotPath, screenshots: [...screenshots, ...failureScreenshots], errorCategory: 'uncertain_punch' });
      await notify({ ...planned, state: 'failed' }, 'failed', message, { record: reconciled?.record || before?.record, currentUrl: reconciled?.url || before?.url, observedPageState: reconciled?.pageState || before?.pageState, screenshotPaths: [...screenshots, ...failureScreenshots].map((s) => s.path) });
      throw new Error(message);
    }
    const message = error instanceof Error ? error.message : 'Unknown hard punch error.';
    const failureScreenshots = rigoBrowser.failureEvidenceFrom(error);
    const screenshotPath = failureScreenshots[0]?.path || (await rigoBrowser.evidence(`${actionId}-hard-${action}.png`).catch(() => '')) || undefined;
    store.updateAction(actionId, { state: 'failed', warning: message });
    log(message, { runId: actionId, action, date: parts.date, status: 'failed', scheduleSource, screenshotPath, screenshots: failureScreenshots.length ? failureScreenshots : undefined, errorCategory: 'hard_punch' });
    await notify({ ...planned, state: 'failed' }, 'failed', message, { record: before?.record, currentUrl: before?.url, observedPageState: before?.pageState, screenshotPaths: [...(before?.screenshots || []), ...failureScreenshots].map((s) => s.path) });
    throw new Error(message);
  } finally {
    hardPunchInProgress.delete(action);
  }
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

async function executeActionInternal(id: string): Promise<PlannedAction> {
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
  let punchAttempted = false;
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

    if (!store.claimScheduledAction(id)) {
      const current = store.actions.find((candidate) => candidate.id === id);
      if (current?.state === 'clicked' || current?.state === 'verified') return current;
      throw new Error('Scheduled action was claimed or changed by another process; no punch was submitted.');
    }
    punchAttempted = true;
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
    if (punchAttempted && isUncertainPunchError(error)) {
      let reconciled: Awaited<ReturnType<typeof rigoBrowser.readAttendance>> | undefined;
      let reconciliationError: string | undefined;
      try {
        reconciled = await rigoBrowser.readAttendance(action.date, `${id}-reconcile`);
        if (reconciled.record) store.upsertAttendance(reconciled.record);
      } catch (errorDuringReconciliation) {
        reconciliationError = errorDuringReconciliation instanceof Error ? errorDuringReconciliation.message : 'Attendance reconciliation failed.';
      }
      const outcome = reconcilePunchOutcome(action.action, reconciled?.record);
      const message = reconciliationError ? `${outcome.message} Reconciliation failed: ${reconciliationError}` : outcome.message;
      const screenshots = [...(observed?.screenshots || []), ...(reconciled?.screenshots || [])];
      if (outcome.verified) {
        store.updateAction(id, { state: 'verified', checkIn: reconciled?.record?.checkIn });
        log(message, { runId: id, action: action.action, status: 'verified', date: action.date, url: reconciled?.url, observedPageState: reconciled?.pageState, observedCheckIn: reconciled?.record?.checkIn, observedCheckOut: reconciled?.record?.checkOut, verificationResult: outcome.value, screenshots });
        await notify({ ...action, state: 'verified' }, 'verified', message, { record: reconciled?.record, currentUrl: reconciled?.url, observedPageState: reconciled?.pageState, screenshotPaths: screenshots.map((s) => s.path) });
        return { ...action, state: 'verified', checkIn: reconciled?.record?.checkIn };
      }
      const failureScreenshots = rigoBrowser.failureEvidenceFrom(error);
      const screenshotPath = failureScreenshots[0]?.path || undefined;
      store.updateAction(id, { state: 'failed', warning: message });
      log(message, { runId: id, action: action.action, status: 'failed', date: action.date, screenshotPath, screenshots: [...screenshots, ...failureScreenshots], errorCategory: 'uncertain_punch' });
      await notify(action, 'failed', message, { record: reconciled?.record || observed?.record, currentUrl: reconciled?.url || observed?.url, observedPageState: reconciled?.pageState || observed?.pageState, screenshotPaths: [...screenshots, ...failureScreenshots].map((s) => s.path) });
      throw new Error(message);
    }
    const message = error instanceof Error ? error.message : 'Unknown automation error.';
    const failureScreenshots = rigoBrowser.failureEvidenceFrom(error);
    const screenshotPath = failureScreenshots[0]?.path || (await rigoBrowser.evidence(`${id}-${action.action}.png`).catch(() => '')) || undefined;
    store.updateAction(id, { state: 'failed', warning: message });
    log(message, { runId: id, action: action.action, status: 'failed', date: action.date, screenshotPath, screenshots: failureScreenshots.length ? failureScreenshots : undefined, errorCategory: 'automation' });
    await notify(action, 'failed', message, { record: observed?.record, currentUrl: observed?.url, observedPageState: observed?.pageState, screenshotPaths: [...(observed?.screenshots.map((s) => s.path) || []), ...failureScreenshots.map((s) => s.path)] });
    throw new Error(message);
  }
}

export async function executeAction(id: string): Promise<PlannedAction> {
  const action = store.actions.find((candidate) => candidate.id === id);
  if (!action) throw new Error('Action was not found.');
  if (executingActionIds.has(id)) return action;
  executingActionIds.add(id);
  try {
    return await executeActionInternal(id);
  } finally {
    executingActionIds.delete(id);
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
  if (schedulerTickInProgress) return;
  schedulerTickInProgress = true;
  schedulerLastTickAt = new Date();
  schedulerLastError = false;
  try {
    await evaluate();
    const dueCandidates = store.actions.filter((action) => action.state === 'scheduled' && new Date(action.scheduledFor).getTime() <= Date.now());
    const dueByKey = new Map<string, PlannedAction>();
    for (const candidate of dueCandidates) {
      const key = `${candidate.date}:${candidate.action}`;
      const current = dueByKey.get(key);
      if (!current || candidate.createdAt < current.createdAt) dueByKey.set(key, candidate);
    }
    const due = [...dueByKey.values()];
    for (const duplicate of dueCandidates.filter((candidate) => due.every((action) => action.id !== candidate.id))) {
      const warning = `Duplicate scheduled ${displayAction(duplicate.action).toLowerCase()} suppressed; only one automatic attempt is allowed for ${duplicate.date}.`;
      store.updateAction(duplicate.id, { state: 'skipped', warning });
      log(warning, { runId: duplicate.id, action: duplicate.action, date: duplicate.date, status: 'skipped', errorCategory: 'duplicate_action_suppressed' });
    }
    for (const action of due) {
      try { await executeAction(action.id); } catch (error) { log(error instanceof Error ? error.message : 'Automatic action failed.', { runId: action.id, action: action.action, date: action.date, status: 'failed', errorCategory: 'scheduler_execution' }); }
    }
  } catch (error) {
    schedulerLastError = true;
    const failureScreenshots = rigoBrowser.failureEvidenceFrom(error);
    log(error instanceof Error ? error.message : 'Scheduler error.', { status: 'failed', errorCategory: 'scheduler', screenshotPath: failureScreenshots[0]?.path, screenshots: failureScreenshots.length ? failureScreenshots : undefined });
  } finally {
    schedulerTickInProgress = false;
  }
}

export function startScheduler(): NodeJS.Timeout {
  schedulerStartedAt = new Date();
  void schedulerTick();
  return setInterval(() => { void schedulerTick(); }, SCHEDULER_INTERVAL_MS);
}
