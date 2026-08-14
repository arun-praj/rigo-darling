import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { evidenceStore } from './evidence.js';
import type { ActionType, AttendanceRecord } from './types.js';

type Evidence = { label: string; path: string };
type FailureAwareError = Error & { failureEvidence?: Evidence[] };
type PunchAwareError = FailureAwareError & { uncertainPunch?: boolean };

const APP_ORIGIN = 'https://app.rigohr.com';
const LOGIN_ORIGIN = 'https://login.app.rigohr.com';
const allowedAppPaths = new Set(['/hr', '/hr/clock/in', '/hr/employee', '/login']);
const PAGE_SETTLE_MIN_MS = 1_000;
const PAGE_SETTLE_MAX_MS = 2_000;
const PAGE_STATE_TIMEOUT_MS = 20_000;
const PAGE_STATE_POLL_MS = 250;
const POST_CLICK_DELAY_MS = 750;

function pageSettleDelayMs(): number {
  return PAGE_SETTLE_MIN_MS + Math.floor(Math.random() * (PAGE_SETTLE_MAX_MS - PAGE_SETTLE_MIN_MS + 1));
}

export function isBrowserClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  return /target page, context or browser has been closed|page, context or browser has been closed/i.test(message);
}

export function isUncertainPunchError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as PunchAwareError).uncertainPunch) || isBrowserClosedError(error);
}

export function hasAttendanceHomeText(value: string): boolean {
  return /\bmy\s+time\s+and\s+attendance\b/i.test(value);
}

export function hasClockConfirmationModalText(value: string, action: ActionType): boolean {
  const clockLabel = action === 'check-in' ? /clock\s*in/i : /clock\s*out/i;
  return clockLabel.test(value) && /\bsubmit\b/i.test(value);
}

export function isAllowedRigoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.origin === LOGIN_ORIGIN) return true;
    return url.origin === APP_ORIGIN && allowedAppPaths.has(url.pathname);
  } catch { return false; }
}

export class RigoBrowser {
  private context?: BrowserContext;
  private page?: Page;
  private navigationGuardAttached = false;
  private operationQueue: Promise<void> = Promise.resolve();
  private failureEvidence: Evidence[] = [];

  private async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  takeFailureEvidence(): Evidence[] {
    const evidence = [...this.failureEvidence];
    this.failureEvidence = [];
    return evidence;
  }

  failureEvidenceFrom(error: unknown): Evidence[] {
    if (error && typeof error === 'object' && Array.isArray((error as FailureAwareError).failureEvidence)) {
      return [...((error as FailureAwareError).failureEvidence || [])];
    }
    return this.takeFailureEvidence();
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.navigationGuardAttached = false;
    try {
      await context?.close();
    } catch {
      // The browser is already being torn down; the in-memory handles are cleared above.
    }
  }

  private async capture(label: string): Promise<Evidence | undefined> {
    const page = await this.getPage();
    // Give client-rendered attendance content, dialogs, and page transitions time
    // to settle before recording evidence.
    await this.settlePage(page);
    // Login screenshots are allowed only before the password field appears.
    // Never capture a page while a password input is visible.
    const passwordInputs = await page.locator('input[type="password"]').all();
    for (const passwordInput of passwordInputs) {
      if (await passwordInput.isVisible()) return undefined;
    }
    const fileName = `${Date.now()}-${label.replace(/[^a-z0-9_-]/gi, '_')}.png`;
    const image = await page.screenshot({ fullPage: false });
    return { label, path: await evidenceStore.put(fileName, Buffer.from(image)) };
  }

  async getPage(): Promise<Page> {
    if (this.page?.isClosed()) await this.close();
    if (this.context) {
      try { this.context.pages(); } catch { await this.close(); }
    }
    if (!this.context) {
      const profile = path.resolve(process.env.RIGOHR_BROWSER_PROFILE || '.browser-profile');
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      this.context = await chromium.launchPersistentContext(profile, {
        headless: process.env.BROWSER_HEADLESS === 'true',
        ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
        viewport: { width: 1440, height: 1000 },
      });
    }
    this.page ??= this.context.pages()[0] ?? await this.context.newPage();
    if (!this.navigationGuardAttached) {
      const context = this.context;
      context.on('close', () => {
        if (this.context !== context) return;
        this.context = undefined;
        this.page = undefined;
        this.navigationGuardAttached = false;
      });
      context.on('page', (popup) => void popup.close().catch(() => undefined));
      const page = this.page;
      if (!page) throw new Error('RigoHR browser page could not be initialized.');
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame() && !isAllowedRigoUrl(frame.url())) {
          void page.goBack().catch(() => undefined);
        }
      });
      page.on('close', () => {
        if (this.page !== page) return;
        this.page = undefined;
        this.navigationGuardAttached = false;
      });
      this.navigationGuardAttached = true;
    }
    return this.page;
  }

  async openHome(): Promise<Page> {
    const page = await this.getPage();
    await this.safeGoto('https://app.rigohr.com/hr');
    return page;
  }

  async safeGoto(url: string): Promise<void> {
    if (!isAllowedRigoUrl(url)) throw new Error(`Navigation blocked by allowlist: ${new URL(url).origin}${new URL(url).pathname}`);
    const page = await this.getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.settlePage(page);
  }

  private async settlePage(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(pageSettleDelayMs());
  }

  private async settleAfterClick(page: Page): Promise<void> {
    await page.waitForTimeout(POST_CLICK_DELAY_MS);
    await this.settlePage(page);
  }

  private async waitForPostLoginState(page: Page): Promise<void> {
    const deadline = Date.now() + PAGE_STATE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isAttendanceHome(page) || await this.isClockLanding(page)) return;
      await page.waitForTimeout(PAGE_STATE_POLL_MS);
    }
  }

  private async isAttendanceHome(page: Page): Promise<boolean> {
    const heading = page.locator('h1, h2, h3').filter({ hasText: /my\s+time\s+and\s+attendance/i }).first();
    if (await heading.count() > 0 && await heading.isVisible().catch(() => false)) return true;
    const bodyText = await page.locator('body').innerText().catch(() => '');
    return hasAttendanceHomeText(bodyText);
  }

  private async waitForAttendanceHome(page: Page): Promise<boolean> {
    const deadline = Date.now() + PAGE_STATE_TIMEOUT_MS;
    const heading = page.locator('h1, h2, h3').filter({ hasText: /my\s+time\s+and\s+attendance/i }).first();
    while (Date.now() < deadline) {
      if (await this.isAttendanceHome(page)) return true;
      try { await heading.waitFor({ state: 'visible', timeout: PAGE_STATE_POLL_MS }); } catch { /* React may still be committing the dashboard. */ }
      if (await this.isAttendanceHome(page)) return true;
      await page.waitForTimeout(PAGE_STATE_POLL_MS);
    }
    return false;
  }

  private async isClockLanding(page: Page): Promise<boolean> {
    const skipToHr = await this.skipToHrControl(page).count() > 0;
    const clockControl = await this.clockActionControl(page, 'check-in').count() > 0 || await this.clockActionControl(page, 'check-out').count() > 0;
    return skipToHr || clockControl;
  }

  private skipToHrControl(page: Page): ReturnType<Page['locator']> {
    return page.locator('a, button').filter({ hasText: /skip[\s\S]*go to[\s\S]*hr/i, visible: true }).first();
  }

  private clockActionControl(page: Page, action: ActionType): ReturnType<Page['locator']> {
    return page.locator('button, a').filter({ hasText: new RegExp(action === 'check-in' ? 'clock[- ]?in' : 'clock[- ]?out', 'i'), visible: true }).first();
  }

  private clockConfirmationModal(page: Page, action: ActionType): ReturnType<Page['locator']> {
    const clockLabel = action === 'check-in' ? /clock\s*in/i : /clock\s*out/i;
    return page.locator('dialog, [role="dialog"], [aria-modal="true"], [data-state="open"], [class*="modal"]').filter({ hasText: clockLabel, visible: true }).filter({ hasText: /\bsubmit\b/i, visible: true }).first();
  }

  private async submitClockConfirmationIfPresent(page: Page, action: ActionType, evidenceLabel: string, screenshots: Evidence[]): Promise<boolean> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (hasClockConfirmationModalText(bodyText, action)) {
        const modal = this.clockConfirmationModal(page, action);
        const scopedSubmit = await modal.count() > 0
          ? modal.getByRole('button', { name: /submit/i }).filter({ visible: true }).first()
          : undefined;
        const pageSubmit = page.getByRole('button', { name: /submit/i }).filter({ visible: true }).first();
        const textSubmit = page.locator('button').filter({ hasText: /^\s*submit\s*$/i, visible: true }).first();
        const submit = scopedSubmit && await scopedSubmit.count() > 0 ? scopedSubmit : await pageSubmit.count() > 0 ? pageSubmit : textSubmit;
        if (await submit.count() > 0) {
          if (!(await submit.isEnabled())) {
            throw new Error(`RigoHR showed a ${action} confirmation dialog, but its Submit button was disabled.`);
          }
          const beforeSubmit = await this.capture(`${evidenceLabel}-07-clock-confirmation-before-submit`);
          if (beforeSubmit) screenshots.push(beforeSubmit);
          await this.settlePage(page);
          await submit.click();
          await this.settleAfterClick(page);
          const afterSubmit = await this.capture(`${evidenceLabel}-08-after-clock-confirmation-submit`);
          if (afterSubmit) screenshots.push(afterSubmit);
          return true;
        }
      }
      await page.waitForTimeout(250);
    }
    return false;
  }

  private async waitForInitialState(page: Page): Promise<void> {
    const deadline = Date.now() + PAGE_STATE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const pathname = new URL(page.url()).pathname;
      const hasLoginControl = await page.getByRole('button', { name: /continue/i }).count() > 0 || await page.getByRole('textbox', { name: /password/i }).count() > 0;
      const hasClockGate = await this.isClockLanding(page);
      const hasHome = await this.isAttendanceHome(page);
      if (pathname === '/login' || pathname === '/hr' || pathname === '/hr/clock/in' || pathname === '/hr/employee') {
        if (hasLoginControl || hasClockGate || hasHome || pathname === '/login') return;
      }
      await page.waitForTimeout(PAGE_STATE_POLL_MS);
    }
  }

  private async dismissOptionalModal(page: Page, evidenceLabel: string, screenshots: Evidence[]): Promise<void> {
    const dialogs = await page.locator('dialog, [role="dialog"][aria-modal="true"], [role="alertdialog"]').all();
    for (const dialog of dialogs) {
      if (!(await dialog.isVisible())) continue;
      const closeButtons: Array<ReturnType<Page['locator']>> = [];
      for (const button of await dialog.locator('button').all()) {
        const text = `${await button.innerText().catch(() => '')} ${await button.getAttribute('aria-label').catch(() => '') || ''} ${await button.getAttribute('title').catch(() => '') || ''}`.trim();
        if (/^(close|dismiss|cancel|×|x)$/i.test(text) || /close|dismiss/i.test(text)) closeButtons.push(button);
      }
      if (closeButtons.length === 0) throw new Error('An unexpected RigoHR modal is open and has no close control.');
      if (closeButtons.length !== 1) throw new Error('An unexpected RigoHR modal has multiple possible close controls.');
      const beforeClose = await this.capture(`${evidenceLabel}-modal-before-close`);
      if (beforeClose) screenshots.push(beforeClose);
      await this.settlePage(page);
      await closeButtons[0].click();
      await this.settlePage(page);
      const afterClose = await this.capture(`${evidenceLabel}-modal-after-close`);
      if (afterClose) screenshots.push(afterClose);
    }
  }

  async ensureAuthenticated(evidenceLabel = 'session', action?: 'check-in' | 'check-out'): Promise<{ page: Page; screenshots: Evidence[] }> {
    const page = await this.openHome();
    const screenshots: Evidence[] = [];
    await this.waitForInitialState(page);
    const currentUrl = new URL(page.url());
    const continueButton = page.getByRole('button', { name: /continue/i });
    const passwordBox = page.getByRole('textbox', { name: /password/i });
    const isLoginPage = currentUrl.origin === LOGIN_ORIGIN || (await continueButton.count() > 0) || (currentUrl.pathname === '/login' && await passwordBox.count() > 0);
    if (isLoginPage) {
      const beforeEmail = await this.capture(`${evidenceLabel}-01-before-email`);
      if (beforeEmail) screenshots.push(beforeEmail);
      const username = process.env.RIGOHR_USERNAME;
      const password = process.env.RIGOHR_PASSWORD;
      if (!username || !password) throw new Error('RIGOHR_USERNAME and RIGOHR_PASSWORD are required.');
      if (await passwordBox.count() === 0) {
        const email = page.getByRole('textbox').first();
        await this.settlePage(page);
        await email.fill(username);
        const emailEntered = await this.capture(`${evidenceLabel}-02-email-entered-before-continue`);
        if (emailEntered) screenshots.push(emailEntered);
        await this.settlePage(page);
        await continueButton.first().click();
        await passwordBox.waitFor({ state: 'visible', timeout: 10000 });
        await this.settlePage(page);
      }
      // Do not capture after this point: the password field is visible and may contain a secret.
      await this.settlePage(page);
      await passwordBox.first().fill(password);
      await this.settlePage(page);
      await page.getByRole('button', { name: /login/i }).click();
      await this.waitForPostLoginState(page);
      await this.settlePage(page);
      if (!(await this.waitForAttendanceHome(page)) && !(await this.isClockLanding(page))) {
        const pathname = new URL(page.url()).pathname;
        const passwordStillVisible = await passwordBox.isVisible().catch(() => false);
        throw new Error(`RigoHR login did not complete; current page is ${pathname}${passwordStillVisible ? ' and the password step is still visible' : ''}.`);
      }
    }
    await this.dismissOptionalModal(page, evidenceLabel, screenshots);
    const skipToHr = this.skipToHrControl(page);
    const hasVisibleSkipToHr = await skipToHr.count() > 0 && await skipToHr.isVisible().catch(() => false);
    if (hasVisibleSkipToHr) {
      const clockGate = await this.capture(`${evidenceLabel}-03-clock-landing-before-skip`);
      if (clockGate) screenshots.push(clockGate);
      await this.settlePage(page);
      await skipToHr.click();
      await this.waitForPostLoginState(page);
      await this.settleAfterClick(page);
      if (!(await this.waitForAttendanceHome(page))) {
        throw new Error(`RigoHR did not reach the attendance home after skipping the clock gate: ${new URL(page.url()).pathname}`);
      }
      const afterSkip = await this.capture(`${evidenceLabel}-04-after-skip-to-hr`);
      if (afterSkip) screenshots.push(afterSkip);
    } else if (!(await this.isAttendanceHome(page))) {
      const clockGate = await this.capture(`${evidenceLabel}-03-clock-landing-before-action`);
      if (clockGate) screenshots.push(clockGate);
      const actionButton = action ? this.clockActionControl(page, action) : undefined;
      if (actionButton && await actionButton.count() === 1 && await actionButton.isVisible() && await actionButton.isEnabled()) {
        // Punch actions can be submitted directly from the clock landing page.
      } else {
        if (!action) {
          await this.safeGoto(`${APP_ORIGIN}/hr/employee`);
          if (!(await this.waitForAttendanceHome(page))) {
            throw new Error(`Unexpected RigoHR state after attendance navigation: ${new URL(page.url()).pathname}`);
          }
        } else {
          throw new Error('RigoHR showed a clock landing page, but no usable clock control or skip-to-HR link was found.');
        }
      }
    }
    if (!action && !(await this.waitForAttendanceHome(page))) throw new Error(`Unexpected RigoHR state after attendance navigation: ${new URL(page.url()).pathname}`);
    await this.dismissOptionalModal(page, evidenceLabel, screenshots);
    const afterLogin = await this.capture(`${evidenceLabel}-05-home-before-action`);
    if (afterLogin) screenshots.push(afterLogin);
    return { page, screenshots };
  }

  private async readAttendanceInternal(date: string, evidenceLabel = 'attendance'): Promise<{ record?: AttendanceRecord; pageState: string; url: string; screenshots: Evidence[] }> {
    this.failureEvidence = [];
    try {
      const authenticated = await this.ensureAuthenticated(evidenceLabel);
      const page = authenticated.page;
      const screenshots = [...authenticated.screenshots];
      const dashboard = await this.capture(`${evidenceLabel}-attendance-state`);
      if (dashboard) screenshots.push(dashboard);
      const body = await page.locator('body').innerText();
      const heading = body.includes('My Time and Attendance') ? 'dashboard-attendance-present' : 'dashboard-attendance-missing';
      const dateParts = new Intl.DateTimeFormat('en-US', { timeZone: process.env.RIGOHR_TIMEZONE || 'Asia/Kathmandu', day: 'numeric', weekday: 'short' }).format(new Date(`${date}T00:00:00+05:45`));
      const dayNumber = dateParts.match(/\d+/)?.[0];
      const weekday = dateParts.match(/(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/)?.[1];
      const row = await page.evaluate(({ dayNumber: targetDay, weekday: targetWeekday }) => {
        const headingElement = [...document.querySelectorAll('h1, h2, h3')].find((element) => element.textContent?.includes('My Time and Attendance'));
        const section = headingElement?.parentElement;
        const rows = section ? [...section.querySelectorAll('[dir="row"]')] : [];
        const matching = rows.filter((candidate) => {
          const text = candidate.textContent || '';
          return Boolean(targetDay && targetWeekday && new RegExp(`\\b${targetDay}\\b`).test(text) && text.includes(targetWeekday));
        });
        if (matching.length !== 1) return { rowCount: matching.length };
        const badges = [...matching[0].querySelectorAll('span')].filter((badge) => badge.querySelector('svg') && badge.querySelector('p'));
        const values = badges.map((badge) => ({
          time: badge.querySelector('p')?.textContent?.trim() || '',
          direction: badge.querySelector('svg')?.getAttribute('class') || '',
        })).filter((value) => /\d{1,2}:\d{2}\s*[ap]/i.test(value.time));
        return {
          rowCount: matching.length,
          checkIn: values.find((value) => value.direction.includes('arrow-down-left'))?.time,
          checkOut: values.find((value) => value.direction.includes('arrow-up-right'))?.time,
        };
      }, { dayNumber, weekday });
      if (row.rowCount !== 1) return { pageState: `${heading}; ${row.rowCount === 0 ? 'date-row-not-found' : 'date-row-ambiguous'}`, url: page.url(), screenshots };
      return { record: { date, checkIn: row.checkIn, checkOut: row.checkOut }, pageState: `${heading}; date-row-found`, url: page.url(), screenshots };
    } catch (error) {
      const browserClosed = isBrowserClosedError(error);
      const failure = browserClosed ? undefined : await this.capture(`${evidenceLabel}-failure-state`).catch(() => undefined);
      const evidence = failure ? [failure] : [];
      this.failureEvidence = evidence;
      if (browserClosed) await this.close();
      if (error instanceof Error) {
        (error as PunchAwareError).failureEvidence = evidence;
      }
      throw error;
    } finally {
      await this.close();
    }
  }

  async readAttendance(date: string, evidenceLabel = 'attendance'): Promise<{ record?: AttendanceRecord; pageState: string; url: string; screenshots: Evidence[] }> {
    return this.runExclusive(() => this.readAttendanceInternal(date, evidenceLabel));
  }

  private async clickPunchInternal(action: 'check-in' | 'check-out', evidenceLabel = 'punch'): Promise<Evidence[]> {
    this.failureEvidence = [];
    try {
      const authenticated = await this.ensureAuthenticated(`${evidenceLabel}-auth`, action);
      const page = authenticated.page;
      const screenshots = [...authenticated.screenshots];
      const button = this.clockActionControl(page, action);
      if (await button.count() !== 1 || !(await button.isVisible()) || !(await button.isEnabled())) {
        throw new Error(`Expected enabled RigoHR ${action} control was not found.`);
      }
      const beforeClick = await this.capture(`${evidenceLabel}-06-before-${action}`);
      if (beforeClick) screenshots.push(beforeClick);
      await this.settlePage(page);
      await button.click();
      await this.settleAfterClick(page);
      const modalSubmitted = await this.submitClockConfirmationIfPresent(page, action, evidenceLabel, screenshots);
      const afterClick = await this.capture(`${evidenceLabel}-07-after-${modalSubmitted ? `${action}-submit` : `${action}-click`}-before-refresh`);
      if (afterClick) screenshots.push(afterClick);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await this.settlePage(page);
      await this.waitForPostLoginState(page);
      if (!(await this.isAttendanceHome(page))) {
        const skipToHr = this.skipToHrControl(page);
        if (await skipToHr.count() > 0 && await skipToHr.isVisible().catch(() => false)) {
          await skipToHr.click();
          await this.settleAfterClick(page);
        }
      }
      if (!(await this.isAttendanceHome(page))) {
        throw new Error(`RigoHR did not return to the attendance home after ${action} refresh: ${new URL(page.url()).pathname}`);
      }
      const afterRefresh = await this.capture(`${evidenceLabel}-08-after-refresh`);
      if (afterRefresh) screenshots.push(afterRefresh);
      return screenshots;
    } catch (error) {
      const browserClosed = isBrowserClosedError(error);
      const failure = browserClosed ? undefined : await this.capture(`${evidenceLabel}-failure-state`).catch(() => undefined);
      const evidence = failure ? [failure] : [];
      this.failureEvidence = evidence;
      if (browserClosed) await this.close();
      if (error instanceof Error) {
        (error as PunchAwareError).failureEvidence = evidence;
        if (browserClosed) (error as PunchAwareError).uncertainPunch = true;
      }
      throw error;
    } finally {
      await this.close();
    }
  }

  async clickPunch(action: 'check-in' | 'check-out', evidenceLabel = 'punch'): Promise<Evidence[]> {
    return this.runExclusive(() => this.clickPunchInternal(action, evidenceLabel));
  }

  async evidence(fileName: string): Promise<string> {
    if (!this.page) return '';
    const page = this.page;
    await this.settlePage(page);
    const passwordInputs = await page.locator('input[type="password"]').all();
    for (const passwordInput of passwordInputs) if (await passwordInput.isVisible()) return '';
    const image = await page.screenshot({ fullPage: false });
    return evidenceStore.put(fileName, Buffer.from(image));
  }
}

export const rigoBrowser = new RigoBrowser();
