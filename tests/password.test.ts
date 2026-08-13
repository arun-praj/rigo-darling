import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password authentication', () => {
  it('stores a salted hash and verifies only the original password', () => {
    const encoded = hashPassword('example-password-123');

    expect(encoded).not.toContain('example-password-123');
    expect(verifyPassword('example-password-123', encoded)).toBe(true);
    expect(verifyPassword('wrong-password-123', encoded)).toBe(false);
  });

  it('rejects passwords shorter than eight characters', () => {
    expect(() => hashPassword('short')).toThrow(/8 characters/);
  });
});
