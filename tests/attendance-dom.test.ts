import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readAttendanceDom } from '../src/attendance-dom.js';
import { clockActionControl, loginControl, skipToHrControl } from '../src/browser.js';

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) }); page = await browser.newPage(); });
afterAll(async () => { await browser?.close(); });
const badge = (direction: string, time: string) => `<span class="chakra-badge"><svg class="lucide lucide-${direction}"></svg><p>${time}</p></span>`;
const row = (day: string, values = badge('arrow-down-left', '9:59a'), weekday = 'Wed') => `<div dir="row"><span><div><p>${day} </p><p>${weekday}</p></div></span>${values}<button><p>Time</p></button></div>`;
async function read(rows: string, day = 9, weekday = 'Wed') {
  await page.setContent(`<div><h2>My Time and Attendance</h2><div class="chakra-card">${rows}</div></div>`);
  return page.evaluate(readAttendanceDom, { day, weekday });
}
it('reads padded and unpadded dates across the month', async () => {
  for (let day = 1; day <= 31; day++) {
    for (const label of [String(day), String(day).padStart(2, '0')]) {
      expect(await read(row(label), day)).toEqual({ checkIn: '9:59a' });
    }
  }
});
it('reads both directions independently from the inspected dashboard structure', async () => {
  expect(await read(row('08', badge('arrow-down-left', '12:17p') + badge('arrow-up-right', '10:01p'), 'Tue'), 8, 'Tue'))
    .toEqual({ checkIn: '12:17p', checkOut: '10:01p' });
  expect(await read(row('09', ''))).toEqual({});
});
it('does not match timestamp digits or the wrong weekday', async () => {
  await expect(read(row('08', badge('arrow-down-left', '9:59a')))).rejects.toThrow('date-row-not-found');
  await expect(read(row('09', '', 'Tue'))).rejects.toThrow('date-row-not-found');
  await expect(read('')).rejects.toThrow('date-row-not-found');
  await expect(read(row('09') + row('9'))).rejects.toThrow('date-row-ambiguous');
});
it('rejects unknown directions, malformed times and duplicate timestamps', async () => {
  await expect(read(row('09', badge('clock', '9:59a')))).rejects.toThrow('direction-unrecognized');
  await expect(read(row('09', badge('arrow-down-left', '29:59a')))).rejects.toThrow('time-unrecognized');
  await expect(read(row('09', badge('arrow-down-left', '9:59a').repeat(2)))).rejects.toThrow('direction-ambiguous');
});
it('finds the redesigned header controls by their accessible names', async () => {
  await page.setContent(`<header><button arialabel="Clock In Out"><span><span>Clock Out</span><p>07:05:57 PM</p></span></button></header>`);
  const checkout = clockActionControl(page, 'check-out');
  expect(await checkout.count()).toBe(1);
  expect(await checkout.isVisible()).toBe(true);
  expect(await checkout.isEnabled()).toBe(true);
  expect(await clockActionControl(page, 'check-in').count()).toBe(0);
});
it('finds the current spaced Log in button', async () => {
  await page.setContent('<button type="submit">Log in</button>');
  expect(await loginControl(page).count()).toBe(1);
});
it('finds the current semantic skip-to-HR link', async () => {
  await page.setContent('<a href="/hr/employee">Skip Clock In and go to your HR Portal</a>');
  expect(await skipToHrControl(page).count()).toBe(1);
});
it('finds the current click-handler anchor without an href', async () => {
  await page.setContent('<a class="chakra-link">Skip Clock In and go to your HR Portal</a>');
  expect(await skipToHrControl(page).count()).toBe(1);
});
