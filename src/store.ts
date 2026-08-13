import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DAYS, defaultConfig } from './config.js';
import { hashPassword } from './password.js';
import type { AttendanceRecord, AuthUser, Config, DateOverride, LogEntry, PlannedAction, PersistedState, ScheduleException, ScheduleExceptionType, ScheduleRule, ScheduleTimeOverrides, UserRole } from './types.js';

const dataDir = path.resolve('data');
const databasePath = path.resolve(process.env.RIGOHR_DB_PATH || path.join(dataDir, 'rigohr.sqlite'));

type Row = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function bool(value: unknown): boolean {
  return Number(value) === 1;
}

function ruleFromRow(row: Row): ScheduleRule {
  return {
    day: row.day as ScheduleRule['day'],
    shift: String(row.shift),
    enabled: bool(row.enabled),
    checkInWindow: { start: String(row.check_in_start), end: String(row.check_in_end) },
    checkOutWindow: { start: String(row.check_out_start), end: String(row.check_out_end) },
    minDurationMinutes: Number(row.min_duration_minutes),
    maxDurationMinutes: Number(row.max_duration_minutes),
  };
}

function overrideFromRow(row: Row): DateOverride {
  const rule = ruleFromRow(row);
  const { day: _day, ...withoutDay } = rule;
  return { date: String(row.date), ...withoutDay };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.createSchema();
    this.migrateLegacyJson();
    this.seedAdmin();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS weekly_schedule (
        day TEXT PRIMARY KEY,
        shift TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        check_in_start TEXT NOT NULL,
        check_in_end TEXT NOT NULL,
        check_out_start TEXT NOT NULL,
        check_out_end TEXT NOT NULL,
        min_duration_minutes INTEGER NOT NULL,
        max_duration_minutes INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS date_overrides (
        date TEXT PRIMARY KEY,
        shift TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        check_in_start TEXT NOT NULL,
        check_in_end TEXT NOT NULL,
        check_out_start TEXT NOT NULL,
        check_out_end TEXT NOT NULL,
        min_duration_minutes INTEGER NOT NULL,
        max_duration_minutes INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS notification_recipients (
        email TEXT PRIMARY KEY
      ) STRICT;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
        created_at TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        action TEXT NOT NULL,
        schedule_source TEXT NOT NULL,
        target_window_start TEXT NOT NULL,
        target_window_end TEXT NOT NULL,
        check_in_window_start TEXT NOT NULL,
        check_in_window_end TEXT NOT NULL,
        check_out_window_start TEXT NOT NULL,
        check_out_window_end TEXT NOT NULL,
        min_duration_minutes INTEGER NOT NULL,
        max_duration_minutes INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        check_in TEXT,
        warning TEXT,
        cancelled_at TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS actions_date_action_idx ON actions(date, action);
      CREATE INDEX IF NOT EXISTS actions_state_idx ON actions(state);
      CREATE TABLE IF NOT EXISTS attendance_records (
        date TEXT PRIMARY KEY,
        check_in TEXT,
        check_out TEXT,
        observed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS schedule_exceptions (
        id TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('skip', 'leave', 'holiday')),
        note TEXT,
        created_at TEXT NOT NULL,
        cancelled_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS schedule_exceptions_active_date_idx
        ON schedule_exceptions(date) WHERE cancelled_at IS NULL;
      CREATE INDEX IF NOT EXISTS schedule_exceptions_date_idx ON schedule_exceptions(date);
      CREATE TABLE IF NOT EXISTS random_seeds (
        date TEXT PRIMARY KEY,
        seed INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS schedule_time_overrides (
        date TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('check-in', 'check-out')),
        time TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(date, action)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        timestamp TEXT NOT NULL,
        date TEXT NOT NULL,
        action TEXT,
        status TEXT NOT NULL,
        schedule_source TEXT,
        url TEXT,
        observed_page_state TEXT,
        observed_check_in TEXT,
        observed_check_out TEXT,
        confirmation_at TEXT,
        scheduled_for TEXT,
        execution_at TEXT,
        verification_result TEXT,
        screenshot_path TEXT,
        screenshots_json TEXT,
        error_category TEXT,
        message TEXT NOT NULL,
        email_notification TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS logs_timestamp_idx ON logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS logs_date_status_idx ON logs(date, status);
    `);
  }

  private setting(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as Row | undefined;
    return text(row?.value);
  }

  private setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private migrateLegacyJson(): void {
    if (this.setting('legacy_json_migrated') === '1') {
      this.migrateLegacyRecipient();
      return;
    }
    const legacyPath = path.join(dataDir, 'state.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as PersistedState;
        const legacyConfig = legacy.config || defaultConfig();
        if ((!legacyConfig.notificationEmails || legacyConfig.notificationEmails.length === 0) && legacyConfig.notificationEmail) legacyConfig.notificationEmails = [legacyConfig.notificationEmail];
        this.setConfig(legacyConfig);
        for (const action of legacy.actions || []) this.insertAction({ ...action, scheduledFor: action.scheduledFor || action.createdAt });
        for (const record of this.extractLegacyAttendance(legacy)) this.upsertAttendance(record);
        for (const entry of legacy.logs || []) this.insertLog(entry);
        for (const [date, seed] of Object.entries(legacy.randomSeeds || {})) this.db.prepare('INSERT OR REPLACE INTO random_seeds(date, seed) VALUES (?, ?)').run(date, seed);
        for (const [date, overrides] of Object.entries(legacy.scheduleTimeOverrides || {})) {
          for (const [action, time] of Object.entries(overrides)) if (action === 'check-in' || action === 'check-out') this.setScheduleTimeOverride(date, action, time);
        }
      } catch (error) {
        throw new Error(`SQLite migration from data/state.json failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    } else {
      this.setConfig(defaultConfig());
    }
    this.setSetting('legacy_json_migrated', '1');
    this.setSetting('legacy_recipient_migrated', '1');
  }

  private migrateLegacyRecipient(): void {
    if (this.setting('legacy_recipient_migrated') === '1') return;
    const legacyPath = path.join(dataDir, 'state.json');
    if (fs.existsSync(legacyPath)) {
      const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8')) as PersistedState;
      const email = legacy.config?.notificationEmails?.[0] || legacy.config?.notificationEmail;
      const recipientCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM notification_recipients').get() as Row).count);
      if (email && recipientCount === 0) this.db.prepare('INSERT OR IGNORE INTO notification_recipients(email) VALUES (?)').run(email.trim());
    }
    this.setSetting('legacy_recipient_migrated', '1');
  }

  private seedAdmin(): void {
    if (this.countUsers() > 0) return;
    const email = (process.env.RIGO_ADMIN_USERNAME || 'arunkp1122@gmail.com').trim().toLowerCase();
    const password = process.env.RIGO_ADMIN_PASSWORD;
    if (!password) throw new Error('RIGO_ADMIN_PASSWORD is required to seed the first admin account.');
    this.createUser({ id: `user_admin_${Date.now()}`, email, passwordHash: hashPassword(password), role: 'admin', createdAt: new Date().toISOString() });
  }

  findUserByEmail(email: string): AuthUser & { passwordHash: string } | undefined {
    const row = this.db.prepare('SELECT id, email, password_hash, role, created_at FROM users WHERE email = ? COLLATE NOCASE AND disabled = 0').get(email.trim().toLowerCase()) as Row | undefined;
    return row ? { id: String(row.id), email: String(row.email), passwordHash: String(row.password_hash), role: row.role as UserRole, createdAt: String(row.created_at) } : undefined;
  }

  getUserById(id: string): AuthUser | undefined {
    const row = this.db.prepare('SELECT id, email, role, created_at FROM users WHERE id = ? AND disabled = 0').get(id) as Row | undefined;
    return row ? { id: String(row.id), email: String(row.email), role: row.role as UserRole, createdAt: String(row.created_at) } : undefined;
  }

  countUsers(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as Row).count);
  }

  createUser(user: AuthUser & { passwordHash: string }): AuthUser {
    this.db.prepare('INSERT INTO users(id, email, password_hash, role, created_at, disabled) VALUES (?, ?, ?, ?, ?, 0)').run(user.id, user.email.trim().toLowerCase(), user.passwordHash, user.role, user.createdAt);
    return { id: user.id, email: user.email.trim().toLowerCase(), role: user.role, createdAt: user.createdAt };
  }

  listUsers(): AuthUser[] {
    return (this.db.prepare('SELECT id, email, role, created_at FROM users WHERE disabled = 0 ORDER BY created_at').all() as Row[]).map((row) => ({ id: String(row.id), email: String(row.email), role: row.role as UserRole, createdAt: String(row.created_at) }));
  }

  createSession(tokenHash: string, userId: string, createdAt: string, expiresAt: string): void {
    this.db.prepare('INSERT INTO sessions(token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, userId, createdAt, expiresAt);
  }

  getSession(tokenHash: string): { userId: string; expiresAt: string } | undefined {
    const row = this.db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash) as Row | undefined;
    return row ? { userId: String(row.user_id), expiresAt: String(row.expires_at) } : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredSessions(now: string): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  private extractLegacyAttendance(legacy: PersistedState): AttendanceRecord[] {
    const records = new Map<string, AttendanceRecord>();
    for (const action of legacy.actions || []) {
      if (!action.checkIn) continue;
      const current = records.get(action.date) || { date: action.date };
      current.checkIn = action.checkIn;
      records.set(action.date, current);
    }
    return [...records.values()];
  }

  get config(): Config {
    const timezone = this.setting('timezone') || defaultConfig().timezone;
    const weeklyRows = this.db.prepare('SELECT * FROM weekly_schedule ORDER BY CASE day WHEN \'monday\' THEN 1 WHEN \'tuesday\' THEN 2 WHEN \'wednesday\' THEN 3 WHEN \'thursday\' THEN 4 WHEN \'friday\' THEN 5 WHEN \'saturday\' THEN 6 WHEN \'sunday\' THEN 7 END').all() as Row[];
    const weekly = weeklyRows.length ? weeklyRows.map(ruleFromRow) : defaultConfig().weekly;
    const overrides = (this.db.prepare('SELECT * FROM date_overrides ORDER BY date').all() as Row[]).map(overrideFromRow);
    const notificationEmails = (this.db.prepare('SELECT email FROM notification_recipients ORDER BY email').all() as Row[]).map((row) => String(row.email));
    return { timezone, weekly, overrides, notificationEmails };
  }

  setConfig(config: Config): void {
    this.db.exec('BEGIN');
    try {
      this.setSetting('timezone', config.timezone);
      this.db.exec('DELETE FROM weekly_schedule; DELETE FROM date_overrides; DELETE FROM notification_recipients;');
      const ruleSql = `INSERT INTO weekly_schedule(day, shift, enabled, check_in_start, check_in_end, check_out_start, check_out_end, min_duration_minutes, max_duration_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const overrideSql = `INSERT INTO date_overrides(date, shift, enabled, check_in_start, check_in_end, check_out_start, check_out_end, min_duration_minutes, max_duration_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      const ruleStmt = this.db.prepare(ruleSql);
      for (const rule of config.weekly) ruleStmt.run(rule.day, rule.shift, rule.enabled ? 1 : 0, rule.checkInWindow.start, rule.checkInWindow.end, rule.checkOutWindow.start, rule.checkOutWindow.end, rule.minDurationMinutes, rule.maxDurationMinutes);
      const overrideStmt = this.db.prepare(overrideSql);
      for (const override of config.overrides) overrideStmt.run(override.date, override.shift, override.enabled ? 1 : 0, override.checkInWindow.start, override.checkInWindow.end, override.checkOutWindow.start, override.checkOutWindow.end, override.minDurationMinutes, override.maxDurationMinutes);
      const recipientStmt = this.db.prepare('INSERT INTO notification_recipients(email) VALUES (?)');
      for (const email of config.notificationEmails || []) recipientStmt.run(email);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  get actions(): PlannedAction[] {
    const rows = this.db.prepare('SELECT * FROM actions ORDER BY created_at DESC LIMIT 200').all() as Row[];
    return rows.map((row) => this.actionFromRow(row));
  }

  private actionFromRow(row: Row): PlannedAction {
    return {
      id: String(row.id), date: String(row.date), action: row.action as PlannedAction['action'], scheduleSource: String(row.schedule_source),
      targetWindow: { start: String(row.target_window_start), end: String(row.target_window_end) },
      checkInWindow: { start: String(row.check_in_window_start), end: String(row.check_in_window_end) },
      checkOutWindow: { start: String(row.check_out_window_start), end: String(row.check_out_window_end) },
      minDurationMinutes: Number(row.min_duration_minutes), maxDurationMinutes: Number(row.max_duration_minutes), state: row.state as PlannedAction['state'],
      createdAt: String(row.created_at), scheduledFor: String(row.scheduled_for || row.created_at), expiresAt: String(row.expires_at), checkIn: text(row.check_in), warning: text(row.warning), cancelledAt: text(row.cancelled_at),
    };
  }

  private insertAction(action: PlannedAction): void {
    this.db.prepare(`INSERT OR REPLACE INTO actions(id, date, action, schedule_source, target_window_start, target_window_end, check_in_window_start, check_in_window_end, check_out_window_start, check_out_window_end, min_duration_minutes, max_duration_minutes, state, created_at, scheduled_for, expires_at, check_in, warning, cancelled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      action.id, action.date, action.action, action.scheduleSource, action.targetWindow.start, action.targetWindow.end, action.checkInWindow.start, action.checkInWindow.end, action.checkOutWindow.start, action.checkOutWindow.end, action.minDurationMinutes, action.maxDurationMinutes, action.state, action.createdAt, action.scheduledFor || action.createdAt, action.expiresAt, action.checkIn ?? null, action.warning ?? null, action.cancelledAt ?? null,
    );
  }

  addAction(action: PlannedAction): void { this.insertAction(action); }

  updateAction(id: string, patch: Partial<PlannedAction>): PlannedAction | undefined {
    const current = this.actions.find((action) => action.id === id);
    if (!current) return undefined;
    const updated = { ...current, ...patch };
    this.insertAction(updated);
    return updated;
  }

  get attendance(): AttendanceRecord[] {
    return (this.db.prepare('SELECT date, check_in, check_out, observed_at FROM attendance_records ORDER BY date DESC').all() as Row[]).map((row) => ({ date: String(row.date), checkIn: text(row.check_in), checkOut: text(row.check_out), observedAt: text(row.observed_at) }));
  }

  getAttendance(date: string): AttendanceRecord | undefined {
    const row = this.db.prepare('SELECT date, check_in, check_out, observed_at FROM attendance_records WHERE date = ?').get(date) as Row | undefined;
    return row ? { date: String(row.date), checkIn: text(row.check_in), checkOut: text(row.check_out), observedAt: text(row.observed_at) } : undefined;
  }

  upsertAttendance(record: AttendanceRecord): void {
    this.db.prepare('INSERT INTO attendance_records(date, check_in, check_out, observed_at) VALUES (?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET check_in = excluded.check_in, check_out = excluded.check_out, observed_at = excluded.observed_at').run(record.date, record.checkIn ?? null, record.checkOut ?? null, new Date().toISOString());
  }

  get exceptions(): ScheduleException[] {
    const rows = this.db.prepare('SELECT * FROM schedule_exceptions WHERE cancelled_at IS NULL ORDER BY date').all() as Row[];
    return rows.map((row) => this.exceptionFromRow(row));
  }

  get exceptionHistory(): ScheduleException[] {
    const rows = this.db.prepare('SELECT * FROM schedule_exceptions ORDER BY created_at DESC').all() as Row[];
    return rows.map((row) => this.exceptionFromRow(row));
  }

  getException(date: string): ScheduleException | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_exceptions WHERE date = ? AND cancelled_at IS NULL ORDER BY created_at DESC LIMIT 1').get(date) as Row | undefined;
    return row ? this.exceptionFromRow(row) : undefined;
  }

  private exceptionFromRow(row: Row): ScheduleException {
    return {
      id: String(row.id), date: String(row.date), type: row.type as ScheduleExceptionType,
      note: text(row.note), createdAt: String(row.created_at), cancelledAt: text(row.cancelled_at),
    };
  }

  addException(exception: ScheduleException): void {
    this.db.prepare('INSERT INTO schedule_exceptions(id, date, type, note, created_at, cancelled_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      exception.id, exception.date, exception.type, exception.note ?? null, exception.createdAt, exception.cancelledAt ?? null,
    );
  }

  addExceptions(exceptions: ScheduleException[]): void {
    this.db.exec('BEGIN');
    try {
      for (const exception of exceptions) this.addException(exception);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cancelException(id: string): ScheduleException | undefined {
    const row = this.db.prepare('SELECT * FROM schedule_exceptions WHERE id = ? AND cancelled_at IS NULL').get(id) as Row | undefined;
    if (!row) return undefined;
    const cancelledAt = new Date().toISOString();
    this.db.prepare('UPDATE schedule_exceptions SET cancelled_at = ? WHERE id = ?').run(cancelledAt, id);
    return { ...this.exceptionFromRow(row), cancelledAt };
  }

  cancelScheduledActionsForDate(date: string, reason: string): PlannedAction[] {
    const rows = this.db.prepare("SELECT * FROM actions WHERE date = ? AND state = 'scheduled'").all(date) as Row[];
    const cancelledAt = new Date().toISOString();
    const update = this.db.prepare('UPDATE actions SET state = ?, warning = ?, cancelled_at = ? WHERE id = ?');
    const actions = rows.map((row) => this.actionFromRow(row));
    for (const action of actions) update.run('cancelled', reason, cancelledAt, action.id);
    return actions.map((action) => ({ ...action, state: 'cancelled', warning: reason, cancelledAt }));
  }

  get logs(): LogEntry[] {
    return (this.db.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 1000').all() as Row[]).map((row) => ({
      id: String(row.id), runId: text(row.run_id), timestamp: String(row.timestamp), date: String(row.date), action: row.action as LogEntry['action'], status: row.status as LogEntry['status'], scheduleSource: text(row.schedule_source), url: text(row.url), observedPageState: text(row.observed_page_state), observedCheckIn: text(row.observed_check_in), observedCheckOut: text(row.observed_check_out), confirmationAt: text(row.confirmation_at), scheduledFor: text(row.scheduled_for), executionAt: text(row.execution_at), verificationResult: text(row.verification_result), screenshotPath: text(row.screenshot_path), screenshots: row.screenshots_json ? JSON.parse(String(row.screenshots_json)) : undefined, errorCategory: text(row.error_category), message: String(row.message), emailNotification: row.email_notification as LogEntry['emailNotification'],
    }));
  }

  insertLog(entry: LogEntry): void {
    this.db.prepare(`INSERT OR REPLACE INTO logs(id, run_id, timestamp, date, action, status, schedule_source, url, observed_page_state, observed_check_in, observed_check_out, confirmation_at, scheduled_for, execution_at, verification_result, screenshot_path, screenshots_json, error_category, message, email_notification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.id, entry.runId ?? null, entry.timestamp, entry.date, entry.action ?? null, entry.status, entry.scheduleSource ?? null, entry.url ?? null, entry.observedPageState ?? null, entry.observedCheckIn ?? null, entry.observedCheckOut ?? null, entry.confirmationAt ?? null, entry.scheduledFor ?? null, entry.executionAt ?? null, entry.verificationResult ?? null, entry.screenshotPath ?? null, entry.screenshots ? JSON.stringify(entry.screenshots) : null, entry.errorCategory ?? null, entry.message, entry.emailNotification ?? null,
    );
  }

  addLog(entry: LogEntry): void { this.insertLog(entry); }

  get randomSeeds(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT date, seed FROM random_seeds').all() as Row[]) result[String(row.date)] = Number(row.seed);
    return result;
  }

  getRandomSeed(date: string): number {
    const row = this.db.prepare('SELECT seed FROM random_seeds WHERE date = ?').get(date) as Row | undefined;
    return row ? Number(row.seed) : 0;
  }

  incrementRandomSeed(date: string): number {
    const next = this.getRandomSeed(date) + 1;
    this.db.prepare('INSERT INTO random_seeds(date, seed) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET seed = excluded.seed').run(date, next);
    return next;
  }

  get scheduleTimeOverrides(): ScheduleTimeOverrides {
    const result: ScheduleTimeOverrides = {};
    for (const row of this.db.prepare('SELECT date, action, time FROM schedule_time_overrides').all() as Row[]) {
      const date = String(row.date);
      const action = row.action as 'check-in' | 'check-out';
      result[date] ??= {};
      result[date][action] = String(row.time);
    }
    return result;
  }

  setScheduleTimeOverride(date: string, action: 'check-in' | 'check-out', time: string): void {
    this.db.prepare('INSERT INTO schedule_time_overrides(date, action, time, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(date, action) DO UPDATE SET time = excluded.time, updated_at = excluded.updated_at').run(date, action, time, new Date().toISOString());
  }

  clearScheduleTimeOverrides(date: string): void {
    this.db.prepare('DELETE FROM schedule_time_overrides WHERE date = ?').run(date);
  }
}

export const store = new Store();
export const makeId = (prefix: string): string => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
