import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { evidenceStore } from './evidence.js';
import type { AttendanceRecord } from './types.js';

type Evidence = { label: string; path: string };

const APP_ORIGIN = 'https://app.rigohr.com';
const LOGIN_ORIGIN = 'https://login.app.rigohr.com';
const allowedAppPaths = new Set(['/hr', '/hr/clock/in', '/hr/employee', '/login']);
const PAGE_SETTLE_MIN_MS = 1_000;
const PAGE_SETTLE_MAX_MS = 5_000;

function pageSettleDelayMs(): number {
  return PAGE_SETTLE_MIN_MS + Math.floor(Math.random() * (PAGE_SETTLE_MAX_MS - PAGE_SETTLE_MIN_MS + 1));
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
    if (!this.context) {
      const profile = path.resolve(process.env.RIGOHR_BROWSER_PROFILE || '.browser-profile');
      fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
      this.context = await chromium.launchPersistentContext(profile, {
        headless: process.env.BROWSER_HEADLESS === 'true',
        viewport: { width: 1440, height: 1000 },
      });
    }
    this.page ??= this.context.pages()[0] ?? await this.context.newPage();
    if (!this.navigationGuardAttached) {
      this.context.on('page', (popup) => void popup.close().catch(() => undefined));
      this.page.on('framenavigated', (frame) => {
        if (frame === this.page?.mainFrame() && !isAllowedRigoUrl(frame.url())) {
          void this.page?.goBack().catch(() => undefined);
        }
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

  private async waitForPostLoginState(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pathname = new URL(page.url()).pathname;
      if (pathname === '/hr/clock/in' && await page.getByText(/skip clock[- ]?in and go to (your )?hr/i).count() > 0) return;
      if (pathname === '/hr/employee' && await page.getByRole('heading', { name: /my time and attendance/i }).count() > 0) return;
      await page.waitForTimeout(500);
    }
  }

  private async waitForInitialState(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const pathname = new URL(page.url()).pathname;
      const hasLoginControl = await page.getByRole('button', { name: /continue/i }).count() > 0 || await page.getByRole('textbox', { name: /password/i }).count() > 0;
      const hasClockGate = await page.getByText(/skip clock[- ]?in and go to (your )?hr/i).count() > 0;
      const hasHome = await page.getByRole('heading', { name: /my time and attendance/i }).count() > 0;
      if (pathname === '/login' || pathname === '/hr' || pathname === '/hr/clock/in' || pathname === '/hr/employee') {
        if (hasLoginControl || hasClockGate || hasHome || pathname === '/login') return;
      }
      await page.waitForTimeout(500);
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

  async ensureAuthenticated(evidenceLabel = 'session'): Promise<{ page: Page; screenshots: Evidence[] }> {
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
      if (new URL(page.url()).pathname !== '/hr/clock/in' && new URL(page.url()).pathname !== '/hr/employee') {
        throw new Error('RigoHR login did not complete; the expected post-login page was not reached.');
      }
    }
    await this.dismissOptionalModal(page, evidenceLabel, screenshots);
    if (new URL(page.url()).pathname === '/hr/clock/in') {
      const clockGate = await this.capture(`${evidenceLabel}-03-before-skip-clock-in`);
      if (clockGate) screenshots.push(clockGate);
      const skip = page.getByText(/skip clock[- ]?in and go to (your )?hr/i).first();
      if (await skip.count() !== 1) throw new Error('Expected “Skip clock-in and go to HR” control was not found.');
      await this.settlePage(page);
      await skip.click();
      await this.waitForPostLoginState(page);
      await this.settlePage(page);
      const afterSkip = await this.capture(`${evidenceLabel}-04-after-skip-clock-in`);
      if (afterSkip) screenshots.push(afterSkip);
    }
    if (new URL(page.url()).pathname !== '/hr/employee') throw new Error(`Unexpected RigoHR state: ${new URL(page.url()).pathname}`);
    await this.dismissOptionalModal(page, evidenceLabel, screenshots);
    const afterLogin = await this.capture(`${evidenceLabel}-05-home-before-action`);
    if (afterLogin) screenshots.push(afterLogin);
    return { page, screenshots };
  }

  async readAttendance(date: string, evidenceLabel = 'attendance'): Promise<{ record?: AttendanceRecord; pageState: string; url: string; screenshots: Evidence[] }> {
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
    } finally {
      await this.close();
    }
  }

  async clickPunch(action: 'check-in' | 'check-out', evidenceLabel = 'punch'): Promise<Evidence[]> {
    try {
      const authenticated = await this.ensureAuthenticated(`${evidenceLabel}-auth`);
      const page = authenticated.page;
      const screenshots = [...authenticated.screenshots];
      const button = page.getByRole('button', { name: new RegExp(action === 'check-in' ? 'Clock In' : 'Clock Out', 'i') }).first();
      if (await button.count() !== 1 || !(await button.isVisible()) || !(await button.isEnabled())) {
        throw new Error(`Expected enabled ${action} control was not found on the dashboard.`);
      }
      const beforeClick = await this.capture(`${evidenceLabel}-06-before-${action}`);
      if (beforeClick) screenshots.push(beforeClick);
      await this.settlePage(page);
      await button.click();
      await this.settlePage(page);
      const afterClick = await this.capture(`${evidenceLabel}-07-after-${action}-before-refresh`);
      if (afterClick) screenshots.push(afterClick);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await this.settlePage(page);
      const afterRefresh = await this.capture(`${evidenceLabel}-08-after-refresh`);
      if (afterRefresh) screenshots.push(afterRefresh);
      return screenshots;
    } finally {
      await this.close();
    }
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
