import { describe, expect, it } from 'vitest';
import { hasAttendanceHomeText, hasClockConfirmationModalText, isAllowedRigoUrl, isBrowserClosedError } from '../src/browser.js';

describe('RigoHR navigation allowlist', () => {
  it('allows only the specified app pages and authentication origin', () => {
    expect(isAllowedRigoUrl('https://app.rigohr.com/hr')).toBe(true);
    expect(isAllowedRigoUrl('https://app.rigohr.com/hr/employee')).toBe(true);
    expect(isAllowedRigoUrl('https://login.app.rigohr.com/login?ReturnUrl=x')).toBe(true);
    expect(isAllowedRigoUrl('https://app.rigohr.com/hr/employee-profile/1446/profile')).toBe(false);
    expect(isAllowedRigoUrl('https://www.youtube.com/@rigohrms')).toBe(false);
  });
});

describe('RigoHR browser lifecycle errors', () => {
  it('classifies a closed page/context error without confusing it with selector failure', () => {
    expect(isBrowserClosedError(new Error('locator.click: Target page, context or browser has been closed'))).toBe(true);
    expect(isBrowserClosedError(new Error('Expected enabled RigoHR check-out control was not found.'))).toBe(false);
  });

  it('recognizes the rendered attendance section independently of ARIA role metadata', () => {
    expect(hasAttendanceHomeText('Good Evening, Arun Prajapati\nMy Time and Attendance\n13 Thu 11:35a 11:24p')).toBe(true);
    expect(hasAttendanceHomeText('Good Evening, Arun Prajapati\nWelcome to RigoHR')).toBe(false);
  });

  it('recognizes the optional Clock In/Out confirmation dialog', () => {
    expect(hasClockConfirmationModalText('Clock In\nNote optional\nClose\nSubmit', 'check-in')).toBe(true);
    expect(hasClockConfirmationModalText('Clock Out\nSubmit', 'check-out')).toBe(true);
    expect(hasClockConfirmationModalText('Clock In\nClose', 'check-in')).toBe(false);
    expect(hasClockConfirmationModalText('Clock In\nSubmit', 'check-out')).toBe(false);
  });
});
