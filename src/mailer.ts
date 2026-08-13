import nodemailer from 'nodemailer';
import type { ActionType, AttendanceRecord, PlannedAction, RunState } from './types.js';

export interface NotificationContext {
  action: ActionType;
  state: Extract<RunState, 'scheduled' | 'verified' | 'failed' | 'blocked' | 'skipped'>;
  date: string;
  scheduleSource: string;
  targetWindow: { start: string; end: string };
  checkInWindow?: { start: string; end: string };
  checkOutWindow?: { start: string; end: string };
  minDurationMinutes: number;
  maxDurationMinutes: number;
  record?: AttendanceRecord;
  message: string;
  errorCategory?: string;
  currentUrl?: string;
  observedPageState?: string;
  screenshotPaths?: string[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for SMTP notifications.`);
  return value;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function configured(recipientAddresses: string[] | undefined): boolean {
  return Boolean(recipientAddresses?.length && recipientAddresses.every(isValidEmail) && process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.SMTP_FROM);
}

function createTransport() {
  return nodemailer.createTransport({
    host: required('SMTP_HOST'),
    port: Number(required('SMTP_PORT')),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: required('SMTP_USER'), pass: required('SMTP_PASSWORD') },
  });
}

function escapeHtml(value: string | undefined): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] || character);
}

function formatDuration(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusLabel(state: NotificationContext['state']): string {
  return state === 'scheduled' ? 'SCHEDULED' : state === 'verified' ? 'SUCCESS' : state === 'blocked' ? 'BLOCKED' : state === 'skipped' ? 'SKIPPED' : 'FAILED';
}

export function buildNotification(context: NotificationContext): { subject: string; text: string; html: string } {
  const actionLabel = context.action === 'check-in' ? 'Punch-in' : 'Punch-out';
  const observedIn = context.record?.checkIn || 'Not observed';
  const observedOut = context.record?.checkOut || 'Not observed';
  const subject = `[RigoHR] ${statusLabel(context.state)}: ${actionLabel} · ${context.date}`;
  const fields = [
    `Result: ${statusLabel(context.state)}`,
    `Action: ${actionLabel}`,
    `Date: ${context.date}`,
    `Schedule: ${context.scheduleSource}`,
    `Configured punch-in window: ${(context.checkInWindow || (context.action === 'check-in' ? context.targetWindow : undefined))?.start || 'Not configured'}–${(context.checkInWindow || (context.action === 'check-in' ? context.targetWindow : undefined))?.end || 'Not configured'} Nepal Time`,
    `Configured punch-out window: ${(context.checkOutWindow || (context.action === 'check-out' ? context.targetWindow : undefined))?.start || 'Not configured'}–${(context.checkOutWindow || (context.action === 'check-out' ? context.targetWindow : undefined))?.end || 'Not configured'} Nepal Time`,
    `Minimum duration: ${formatDuration(context.minDurationMinutes)}`,
    `Maximum duration: ${formatDuration(context.maxDurationMinutes)}`,
    `Observed punch-in: ${observedIn}`,
    `Observed punch-out: ${observedOut}`,
    `Details: ${context.message}`,
    context.errorCategory ? `Error category: ${context.errorCategory}` : '',
    context.observedPageState ? `Observed page state: ${context.observedPageState}` : '',
    context.currentUrl ? `RigoHR page: ${context.currentUrl}` : '',
    context.screenshotPaths?.length ? `Evidence: ${context.screenshotPaths.join(', ')}` : '',
  ].filter(Boolean);
  const text = `RigoHR Attendance Notification\n\n${fields.join('\n')}`;
  const html = `<h2>RigoHR Attendance · ${escapeHtml(statusLabel(context.state))}</h2><table>${fields.map((field) => { const separator = field.indexOf(':'); const key = separator > -1 ? field.slice(0, separator) : 'Details'; const value = separator > -1 ? field.slice(separator + 1).trim() : field; return `<tr><th style="text-align:left;padding:5px 12px 5px 0">${escapeHtml(key)}</th><td style="padding:5px 0">${escapeHtml(value)}</td></tr>`; }).join('')}</table>`;
  return { subject, text, html };
}

export async function sendNotification(context: NotificationContext, recipientAddresses: string[] = []): Promise<{ sent: boolean; recipients?: string[] }> {
  if (!configured(recipientAddresses)) return { sent: false };
  const transport = createTransport();
  const to = recipientAddresses.map((recipient) => recipient.trim());
  await transport.sendMail({
    from: required('SMTP_FROM'),
    to,
    replyTo: process.env.SMTP_REPLY_TO || undefined,
    ...buildNotification(context),
  });
  return { sent: true, recipients: to };
}

export async function sendTestEmail(recipientAddresses: string[] = []): Promise<{ sent: boolean; recipients?: string[] }> {
  if (!configured(recipientAddresses)) return { sent: false };
  const transport = createTransport();
  const to = recipientAddresses.map((recipient) => recipient.trim());
  await transport.sendMail({
    from: required('SMTP_FROM'),
    to,
    replyTo: process.env.SMTP_REPLY_TO || undefined,
    subject: '[RigoHR] Test email · Attendance notifications',
    text: `RigoHR Attendance test email\n\nThis confirms that attendance notifications can be delivered to: ${to.join(', ')}.\n\nNo attendance action was performed.`,
    html: `<h2>RigoHR Attendance · Test email</h2><p>This confirms that attendance notifications can be delivered to:</p><p>${to.map(escapeHtml).join('<br>')}</p><p><strong>No attendance action was performed.</strong></p>`,
  });
  return { sent: true, recipients: to };
}

export function plannedActionContext(action: PlannedAction, state: NotificationContext['state'], message: string, extra: Partial<NotificationContext> = {}): NotificationContext {
  return { action: action.action, state, date: action.date, scheduleSource: action.scheduleSource, targetWindow: action.targetWindow, checkInWindow: action.checkInWindow, checkOutWindow: action.checkOutWindow, minDurationMinutes: action.minDurationMinutes, maxDurationMinutes: action.maxDurationMinutes, message, ...extra };
}
