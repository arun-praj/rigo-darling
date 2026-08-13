import { describe, expect, it } from 'vitest';
import { isAllowedRigoUrl, isBrowserClosedError } from '../src/browser.js';

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
});
