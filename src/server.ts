import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { evaluate, preview, manualRequest, executeAction, cancelAction, schedulerStatus, startScheduler } from './automation.js';
import { DAYS } from './config.js';
import { checkoutGuidance, localParts, nextScheduledAction, ruleForDate, upcomingWorkdayForecast, validateRule } from './schedule.js';
import { makeId, store } from './store.js';
import { evidenceStore } from './evidence.js';
import { isValidEmail, sendTestEmail } from './mailer.js';
import { createUser, currentUser, login, logout, requireAdmin, requireAuth } from './auth.js';
import { rigoBrowser } from './browser.js';
import type { Config, DateOverride, ScheduleException, ScheduleExceptionType, UserRole } from './types.js';

const app = express();
const port = Number(process.env.PORT || 4317);
const host = process.env.HOST || '127.0.0.1';
app.use(express.json({ limit: '100kb' }));

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Unexpected error.';
  return raw.replace(/(password|authorization|cookie|token|secret)\s*[:=]\s*[^\s]+/gi, '$1=[REDACTED]');
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));
}

function exceptionType(value: unknown): ScheduleExceptionType {
  if (value !== 'leave' && value !== 'holiday' && value !== 'skip') throw new Error('Exception type must be leave, holiday, or skip.');
  return value;
}

app.get('/login', (_req, res) => res.sendFile(path.resolve('public/login.html')));

app.post('/api/auth/login', (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || email.length > 320 || password.length > 512) return res.status(401).json({ error: 'Invalid email or password.' });
  const user = login(email, password, res);
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  res.json({ user });
});

app.get('/api/auth/session', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user });
});

app.post('/api/auth/logout', (req, res) => {
  logout(req, res);
  res.status(204).end();
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path.startsWith('/api/auth/')) return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.resolve('public')));

const sendEvidence = async (key: unknown, res: express.Response) => {
  if (typeof key !== 'string' || !key) return res.status(400).end();
  try {
    const evidence = await evidenceStore.get(key);
    if (!evidence) return res.status(404).end();
    res.type(evidence.contentType).set('Cache-Control', 'private, max-age=31536000, immutable').send(evidence.data);
  } catch (error) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'NoSuchKey') return res.status(404).end();
    res.status(500).json({ error: safeError(error) });
  }
};

app.get('/evidence', async (req, res) => {
  await sendEvidence(req.query.key, res);
});

app.get('/evidence/:key', async (req, res) => {
  await sendEvidence(req.params.key, res);
});

app.get('/api/config', (_req, res) => res.json(store.config));
app.put('/api/config', (req, res) => {
  try {
    const next = req.body as Config;
    if (!next || next.timezone !== 'Asia/Kathmandu') throw new Error('Timezone must remain Asia/Kathmandu.');
    next.notificationEmails = Array.isArray(next.notificationEmails) ? [...new Set(next.notificationEmails.map((email) => String(email).trim()).filter(Boolean))] : [];
    if (next.notificationEmails.some((email) => !isValidEmail(email))) throw new Error('Every notification recipient must be a valid email address.');
    delete next.notificationEmail;
    if (!Array.isArray(next.weekly) || next.weekly.length !== DAYS.length) throw new Error('All seven weekly day rules are required.');
    next.weekly.forEach(validateRule);
    next.overrides.forEach((override) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(override.date)) throw new Error('Invalid override date.'); validateRule(override); });
    store.setConfig(next); res.json(next);
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.post('/api/email/test', async (req, res) => {
  try {
    const rawEmails: unknown[] = Array.isArray(req.body?.emails) ? req.body.emails : [];
    const emails: string[] = [...new Set(rawEmails.map((email: unknown) => String(email).trim()).filter((email: string) => Boolean(email)))];
    if (!emails.length) throw new Error('Add at least one recipient before sending a test email.');
    if (emails.some((email) => !isValidEmail(email))) throw new Error('Every test recipient must be a valid email address.');
    const result = await sendTestEmail(emails);
    if (!result.sent) return res.status(503).json({ error: 'SMTP notifications are not configured.' });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json(store.listUsers());
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'user';
    if (!isValidEmail(email)) throw new Error('Enter a valid email address.');
    if (password.length < 8 || password.length > 512) throw new Error('Password must be between 8 and 512 characters.');
    const user = createUser(email, password, role);
    res.status(201).json(user);
  } catch (error) {
    const message = error instanceof Error && /UNIQUE|constraint/i.test(error.message) ? 'A user with that email already exists.' : safeError(error);
    res.status(400).json({ error: message });
  }
});

app.post('/api/overrides', (req, res) => {
  try {
    const override = req.body as DateOverride;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(override.date)) throw new Error('Override date must use YYYY-MM-DD.');
    validateRule(override);
    const config = store.config;
    config.overrides = [...config.overrides.filter((candidate) => candidate.date !== override.date), override].sort((a, b) => a.date.localeCompare(b.date));
    store.setConfig(config); res.json(override);
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.delete('/api/overrides/:date', (req, res) => {
  const config = store.config; config.overrides = config.overrides.filter((candidate) => candidate.date !== req.params.date); store.setConfig(config); res.status(204).end();
});

app.get('/api/exceptions', (req, res) => {
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  res.json(store.exceptions.filter((exception) => (!from || exception.date >= from) && (!to || exception.date <= to)));
});

app.get('/api/forecast', (_req, res) => {
  res.json(upcomingWorkdayForecast(store.config, new Date(), store.randomSeeds, store.exceptions));
});

app.post('/api/exceptions', (req, res) => {
  try {
    const type = exceptionType(req.body?.type);
    if (type === 'skip') throw new Error('Use the skip-today action for a skip exception.');
    const dates: string[] = Array.isArray(req.body?.dates) ? Array.from(new Set(req.body.dates.map((date: unknown) => String(date)))) : [];
    if (!dates.length || dates.some((date) => !validDate(date))) throw new Error('At least one valid date is required.');
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : undefined;
    const conflicts = dates.map((date) => ({ date, existing: store.getException(date) })).filter((item) => item.existing);
    if (conflicts.length) throw new Error(`These dates already have an exception: ${conflicts.map((item) => item.date).join(', ')}.`);
    const createdAt = new Date().toISOString();
    const exceptions: ScheduleException[] = dates.sort().map((date) => ({ id: `${type}_${date}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, date, type, note, createdAt }));
    store.addExceptions(exceptions);
    for (const exception of exceptions) {
      const cancelled = store.cancelScheduledActionsForDate(exception.date, `Skipped because ${exception.date} is marked as ${exception.type}.`);
      store.addLog({ id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), date: exception.date, status: 'skipped', errorCategory: 'schedule_exception', message: `${exception.type === 'leave' ? 'Planned leave' : 'Holiday'} saved; attendance routine disabled for this date.${cancelled.length ? ` ${cancelled.length} scheduled action(s) canceled.` : ''}` });
    }
    res.status(201).json(exceptions);
  } catch (error) { res.status(409).json({ error: safeError(error) }); }
});

app.post('/api/exceptions/skip-today', (req, res) => {
  try {
    const now = new Date();
    const parts = localParts(now, store.config.timezone);
    const existing = store.getException(parts.date);
    if (existing) throw new Error(`Today is already marked as ${existing.type}.`);
    const exception: ScheduleException = { id: `skip_${parts.date}_${Date.now()}`, date: parts.date, type: 'skip', note: 'Skipped by user from the dashboard.', createdAt: now.toISOString() };
    store.addException(exception);
    const cancelled = store.cancelScheduledActionsForDate(parts.date, 'Skipped by the user for today.');
    store.addLog({ id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: now.toISOString(), date: parts.date, status: 'skipped', errorCategory: 'schedule_exception', message: `Today’s punch-in and punch-out were skipped.${cancelled.length ? ` ${cancelled.length} scheduled action(s) canceled.` : ''}` });
    res.status(201).json({ exception, cancelledActions: cancelled });
  } catch (error) { res.status(409).json({ error: safeError(error) }); }
});

app.post('/api/exceptions/unskip-today', async (req, res) => {
  try {
    const now = new Date();
    const parts = localParts(now, store.config.timezone);
    const existing = store.getException(parts.date);
    if (!existing) throw new Error('Today is not currently skipped.');
    if (existing.type !== 'skip') throw new Error(`Today is marked as ${existing.type}; only a skip can be undone here.`);
    const attendance = store.getAttendance(parts.date);
    if (attendance?.checkOut) throw new Error('Today cannot be unskipped after punch-out has already been recorded.');
    const cancelled = store.cancelException(existing.id);
    if (!cancelled) throw new Error('Today’s skip could not be removed.');
    const rearmed = await evaluate(now);
    store.addLog({ id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, timestamp: now.toISOString(), date: parts.date, status: 'info', errorCategory: 'schedule_exception', message: 'Today’s skip was removed; the attendance routine is enabled again.' });
    res.json({ exception: cancelled, rearmed });
  } catch (error) { res.status(409).json({ error: safeError(error) }); }
});

app.delete('/api/exceptions/:id', (req, res) => {
  const cancelled = store.cancelException(req.params.id);
  if (!cancelled) return res.status(404).json({ error: 'Exception was not found.' });
  res.json(cancelled);
});

app.get('/api/attendance', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  res.json(store.attendance.filter((record) => !date || record.date === date));
});

app.put('/api/attendance/:date', (req, res) => {
  try {
    const date = req.params.date;
    if (!validDate(date)) throw new Error('Attendance date must use YYYY-MM-DD.');
    const today = localParts(new Date(), store.config.timezone).date;
    if (date !== today) throw new Error('Only today’s attendance can be manually edited.');
    const time = (value: unknown, label: string): string | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) throw new Error(`${label} must use HH:MM.`);
      const [hour, minute] = value.split(':').map(Number);
      if (hour > 23 || minute > 59) throw new Error(`${label} must be a valid time.`);
      return value;
    };
    const checkIn = time(req.body?.checkIn, 'Punch-in');
    const checkOut = time(req.body?.checkOut, 'Punch-out');
    if (checkIn === undefined && checkOut === undefined) throw new Error('Provide a punch-in or punch-out time.');
    const updated = store.updateAttendance(date, { checkIn, checkOut });
    store.addLog({ id: makeId('log'), timestamp: updated.observedAt || new Date().toISOString(), date, status: 'info', errorCategory: 'manual_attendance_edit', message: `Manual attendance record updated: punch-in ${updated.checkIn || 'not recorded'}, punch-out ${updated.checkOut || 'not recorded'}.`, observedCheckIn: updated.checkIn, observedCheckOut: updated.checkOut });
    res.json({ date, record: updated, stored: true, storedAt: updated.observedAt });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/attendance/check-live', async (_req, res) => {
  const checkedAt = new Date();
  const date = localParts(checkedAt, store.config.timezone).date;
  try {
    const observed = await rigoBrowser.readAttendance(date, `manual-live-attendance-${date}`);
    if (observed.record) store.upsertAttendance(observed.record);
    const storedRecord = store.getAttendance(date);
    const punchIn = observed.record?.checkIn;
    const punchOut = observed.record?.checkOut;
    const message = `Live RigoHR attendance checked and stored in SQLite: punch-in ${punchIn || 'not recorded'}, punch-out ${punchOut || 'not recorded'}.`;
    store.addLog({
      id: makeId('log'), timestamp: checkedAt.toISOString(), date, status: 'info', message,
      url: observed.url, observedPageState: observed.pageState, observedCheckIn: punchIn,
      observedCheckOut: punchOut, verificationResult: observed.pageState, screenshots: observed.screenshots,
    });
    res.json({ date, checkedAt: checkedAt.toISOString(), record: storedRecord || {}, stored: true, storedAt: storedRecord?.observedAt, pageState: observed.pageState });
  } catch (error) {
    const message = safeError(error);
    const failureScreenshots = rigoBrowser.failureEvidenceFrom(error);
    store.addLog({ id: makeId('log'), timestamp: checkedAt.toISOString(), date, status: 'failed', errorCategory: 'live_attendance_check', message: `Live RigoHR attendance check failed: ${message}`, screenshotPath: failureScreenshots[0]?.path, screenshots: failureScreenshots.length ? failureScreenshots : undefined });
    res.status(502).json({ error: 'RigoHR attendance could not be checked.', detail: message });
  }
});

app.get('/api/logs', (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const requestedPage = Number(req.query.page || 1);
  const pageSize = Math.min(5, Math.max(1, Number(req.query.pageSize || 5)));
  const filteredLogs = store.logs.filter((entry) => (!date || entry.date === date) && (!status || entry.status === status) && (!action || entry.action === action));
  const total = filteredLogs.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1), totalPages);
  res.json({ logs: filteredLogs.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total, totalPages });
});

app.get('/api/history', (_req, res) => {
  res.json({ logs: store.logs, attendance: store.attendance, exceptions: store.exceptions });
});

app.get('/api/status', (_req, res) => {
  const now = new Date();
  const parts = localParts(now, store.config.timezone);
  const exception = store.getException(parts.date);
  const selected = ruleForDate(store.config, parts.date, parts.day);
  const dailyAttendance = store.getAttendance(parts.date);
  const checkout = dailyAttendance?.checkIn ? checkoutGuidance(store.config, parts.date, parts.day, now, dailyAttendance.checkIn) : undefined;
  res.json({ now: now.toISOString(), local: parts, scheduler: schedulerStatus(now), schedule: exception ? `${exception.type} today` : selected?.source || 'none', exception, nextAction: nextScheduledAction(store.config, now, store.randomSeeds, new Set(store.exceptions.map((item) => item.date))), checkoutGuidance: checkout, attendance: dailyAttendance, actions: store.actions.slice(0, 20), logs: store.logs.slice(0, 20) });
});

app.post('/api/refresh-schedule/:date', (req, res) => {
  try {
    const date = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
    store.incrementRandomSeed(date);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: safeError(error) });
  }
});

app.post('/api/preview', async (_req, res) => {
  try { res.json(await preview()); } catch (error) { res.status(500).json({ error: safeError(error) }); }
});

app.post('/api/manual/:action', async (req, res) => {
  try {
    if (req.params.action !== 'check-in' && req.params.action !== 'check-out') throw new Error('Invalid manual action.');
    const plan = await manualRequest(req.params.action);
    res.json(plan ? { state: 'scheduled', action: plan } : { state: 'outside_window_or_already_planned' });
  } catch (error) { res.status(400).json({ error: safeError(error) }); }
});

app.post('/api/actions/:id/execute', async (req, res) => {
  try { res.json(await executeAction(req.params.id)); } catch (error) { res.status(409).json({ error: safeError(error) }); }
});

app.post('/api/actions/:id/cancel', (req, res) => {
  try { res.json(cancelAction(req.params.id)); } catch (error) { res.status(409).json({ error: safeError(error) }); }
});

app.use((_req, res) => res.sendFile(path.resolve('public/index.html')));

app.listen(port, host, () => {
  console.log(`RigoHR Attendance Assistant listening at http://${host}:${port}`);
  startScheduler();
});
