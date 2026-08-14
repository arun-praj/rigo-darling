import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { makeId, store } from './store.js';
import { hashPassword, verifyPassword } from './password.js';
import type { AuthUser, UserRole } from './types.js';

export const SESSION_COOKIE = 'rigohr_session';
export const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function cookieValue(request: Request): string | undefined {
  const header = request.headers.cookie || '';
  const match = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)) : undefined;
}

export function shouldUseSecureCookie(request: Pick<Request, 'protocol' | 'headers'>): boolean {
  if (process.env.COOKIE_SECURE !== 'true') return false;
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = Array.isArray(forwardedProtocol) ? forwardedProtocol[0] : forwardedProtocol;
  return request.protocol === 'https' || protocol?.split(',')[0]?.trim().toLowerCase() === 'https';
}

function setSessionCookie(request: Request, response: Response, token: string, maxAge = SESSION_MAX_AGE_SECONDS): void {
  const secure = shouldUseSecureCookie(request) ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

export function publicUser(user: AuthUser): AuthUser {
  return user;
}

export function currentUser(request: Request): AuthUser | undefined {
  const token = cookieValue(request);
  if (!token) return undefined;
  const session = store.getSession(tokenHash(token));
  if (!session) return undefined;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    store.deleteSession(tokenHash(token));
    return undefined;
  }
  return store.getUserById(session.userId);
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  const user = currentUser(request);
  if (!user) {
    if (request.path.startsWith('/api/')) response.status(401).json({ error: 'Authentication required.' });
    else response.redirect('/login');
    return;
  }
  (request as Request & { user?: AuthUser }).user = user;
  next();
}

export function requireAdmin(request: Request, response: Response, next: NextFunction): void {
  const user = (request as Request & { user?: AuthUser }).user || currentUser(request);
  if (!user || user.role !== 'admin') {
    response.status(403).json({ error: 'Administrator access required.' });
    return;
  }
  next();
}

export function login(email: string, password: string, request: Request, response: Response): AuthUser | undefined {
  const user = store.findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) return undefined;
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_MAX_AGE_SECONDS * 1000);
  store.deleteExpiredSessions(createdAt.toISOString());
  store.createSession(tokenHash(token), user.id, createdAt.toISOString(), expiresAt.toISOString());
  setSessionCookie(request, response, token);
  return publicUser(user);
}

export function logout(request: Request, response: Response): void {
  const token = cookieValue(request);
  if (token) store.deleteSession(tokenHash(token));
  setSessionCookie(request, response, '', 0);
}

export function createUser(email: string, password: string, role: UserRole): AuthUser {
  return store.createUser({ id: makeId('user'), email: email.trim().toLowerCase(), passwordHash: hashPassword(password), role, createdAt: new Date().toISOString() });
}
