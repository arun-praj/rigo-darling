import { describe, expect, it } from 'vitest';
import { isAllowedRigoUrl } from '../src/browser.js';

describe('RigoHR navigation allowlist', () => {
  it('allows only the specified app pages and authentication origin', () => {
    expect(isAllowedRigoUrl('https://app.rigohr.com/hr')).toBe(true);
    expect(isAllowedRigoUrl('https://app.rigohr.com/hr/employee')).toBe(true);
    expect(isAllowedRigoUrl('https://login.app.rigohr.com/login?ReturnUrl=x')).toBe(true);
    expect(isAllowedRigoUrl('https://app.rigohr.com/hr/employee-profile/1446/profile')).toBe(false);
    expect(isAllowedRigoUrl('https://www.youtube.com/@rigohrms')).toBe(false);
  });
});
