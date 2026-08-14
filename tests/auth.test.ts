import { afterEach, describe, expect, it } from 'vitest';
import { shouldUseSecureCookie } from '../src/auth.js';

const originalCookieSecure = process.env.COOKIE_SECURE;

afterEach(() => {
  if (originalCookieSecure === undefined) delete process.env.COOKIE_SECURE;
  else process.env.COOKIE_SECURE = originalCookieSecure;
});

describe('session cookie transport security', () => {
  it('does not mark cookies Secure for local HTTP even when secure mode is enabled', () => {
    process.env.COOKIE_SECURE = 'true';
    expect(shouldUseSecureCookie({ protocol: 'http', headers: {} })).toBe(false);
  });

  it('marks cookies Secure for HTTPS and trusted forwarded HTTPS', () => {
    process.env.COOKIE_SECURE = 'true';
    expect(shouldUseSecureCookie({ protocol: 'https', headers: {} })).toBe(true);
    expect(shouldUseSecureCookie({ protocol: 'http', headers: { 'x-forwarded-proto': 'https' } })).toBe(true);
  });

  it('never marks cookies Secure when secure mode is disabled', () => {
    process.env.COOKIE_SECURE = 'false';
    expect(shouldUseSecureCookie({ protocol: 'https', headers: {} })).toBe(false);
  });
});
