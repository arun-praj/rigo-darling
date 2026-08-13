export type DayName = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
export type ActionType = 'check-in' | 'check-out';
export type ScheduleTimeOverrides = Record<string, Partial<Record<ActionType, string>>>;
export type ScheduleExceptionType = 'skip' | 'leave' | 'holiday';
export type RunState =
  | 'scheduled'
  | 'waiting_confirmation'
  | 'skipped'
  | 'cancelled'
  | 'blocked'
  | 'clicked'
  | 'verified'
  | 'failed'
  | 'auth_required';

export interface ScheduleRule {
  day: DayName;
  shift: string;
  enabled: boolean;
  checkInWindow: { start: string; end: string };
  checkOutWindow: { start: string; end: string };
  minDurationMinutes: number;
  maxDurationMinutes: number;
}

export interface DateOverride extends Omit<ScheduleRule, 'day'> {
  date: string;
}

export interface Config {
  timezone: string;
  weekly: ScheduleRule[];
  overrides: DateOverride[];
  notificationEmails?: string[];
  /** Legacy single-recipient field accepted only for state migration. */
  notificationEmail?: string;
}

export type UserRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface AttendanceRecord {
  date: string;
  checkIn?: string;
  checkOut?: string;
  observedAt?: string;
}

export interface ScheduleException {
  id: string;
  date: string;
  type: ScheduleExceptionType;
  note?: string;
  createdAt: string;
  cancelledAt?: string;
}

export interface PlannedAction {
  id: string;
  date: string;
  action: ActionType;
  scheduleSource: string;
  targetWindow: { start: string; end: string };
  checkInWindow: { start: string; end: string };
  checkOutWindow: { start: string; end: string };
  minDurationMinutes: number;
  maxDurationMinutes: number;
  state: RunState;
  createdAt: string;
  scheduledFor: string;
  expiresAt: string;
  checkIn?: string;
  warning?: string;
  cancelledAt?: string;
}

export interface LogEntry {
  id: string;
  runId?: string;
  timestamp: string;
  date: string;
  action?: ActionType;
  status: RunState | 'dry_run' | 'info';
  scheduleSource?: string;
  url?: string;
  observedPageState?: string;
  observedCheckIn?: string;
  observedCheckOut?: string;
  confirmationAt?: string;
  scheduledFor?: string;
  executionAt?: string;
  verificationResult?: string;
  screenshotPath?: string;
  screenshots?: Array<{ label: string; path: string }>;
  errorCategory?: string;
  message: string;
  emailNotification?: 'sent' | 'not_configured' | 'failed';
}

export interface PersistedState {
  config: Config;
  actions: PlannedAction[];
  logs: LogEntry[];
  randomSeeds?: Record<string, number>;
  scheduleTimeOverrides?: ScheduleTimeOverrides;
}
