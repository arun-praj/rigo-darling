import { describe, expect, it } from 'vitest';
import { hasAttendanceHomeText, hasClockConfirmationModalText, isAllowedSushiUrl, isBrowserClosedError, isUncertainPunchError } from '../src/browser.js';

describe('Sushi navigation allowlist', () => {
  it('allows only the specified app pages and authentication origin', () => {
    expect(isAllowedSushiUrl('https://app.rigohr.com/hr')).toBe(true);
    expect(isAllowedSushiUrl('https://app.rigohr.com/hr/employee')).toBe(true);
    expect(isAllowedSushiUrl('https://login.app.rigohr.com/login?ReturnUrl=x')).toBe(true);
    expect(isAllowedSushiUrl('https://app.rigohr.com/hr/employee-profile/1446/profile')).toBe(false);
    expect(isAllowedSushiUrl('https://www.youtube.com/@rigohrms')).toBe(false);
  });
});

describe('Sushi browser lifecycle errors', () => {
  it('classifies a closed page/context error without confusing it with selector failure', () => {
    expect(isBrowserClosedError(new Error('locator.click: Target page, context or browser has been closed'))).toBe(true);
    expect(isBrowserClosedError(new Error('Expected enabled Sushi check-out control was not found.'))).toBe(false);
  });

  it('treats a post-click state failure as uncertain so attendance can be reconciled', () => {
    const error = Object.assign(new Error('Sushi did not return to the attendance home after check-out refresh: /hr/employee'), { uncertainPunch: true });
    expect(isUncertainPunchError(error)).toBe(true);
  });

  it('recognizes the rendered attendance section independently of ARIA role metadata', () => {
    expect(hasAttendanceHomeText('Good Evening, Arun Prajapati\nMy Time and Attendance\n13 Thu 11:35a 11:24p')).toBe(true);
    expect(hasAttendanceHomeText('Good Evening, Arun Prajapati\nWelcome to Sushi')).toBe(false);
  });

  it('recognizes the optional Clock In/Out confirmation dialog', () => {
    expect(hasClockConfirmationModalText('Clock In\nNote optional\nClose\nSubmit', 'check-in')).toBe(true);
    expect(hasClockConfirmationModalText('Clock Out\nSubmit', 'check-out')).toBe(true);
    expect(hasClockConfirmationModalText('Clock In\nClose', 'check-in')).toBe(false);
    expect(hasClockConfirmationModalText('Clock In\nSubmit', 'check-out')).toBe(false);
  });
});
