import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';
import type { PlannedAction } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('scheduled action claiming', () => {
  it('allows only one store owner to claim a scheduled action', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rigohr-store-'));
    temporaryDirectories.push(directory);
    const databaseFile = path.join(directory, 'rigohr.sqlite');
    const firstStore = new Store(databaseFile, { dataDirectory: directory, seedAdmin: false });
    const secondStore = new Store(databaseFile, { dataDirectory: directory, seedAdmin: false });
    const action: PlannedAction = {
      id: 'action_claim_test',
      date: '2026-08-13',
      action: 'check-out',
      scheduleSource: 'test',
      targetWindow: { start: '22:30', end: '23:00' },
      checkInWindow: { start: '12:30', end: '13:45' },
      checkOutWindow: { start: '22:00', end: '23:00' },
      minDurationMinutes: 540,
      maxDurationMinutes: 600,
      state: 'scheduled',
      createdAt: new Date().toISOString(),
      scheduledFor: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    };

    try {
      firstStore.addAction(action);
      expect(secondStore.claimScheduledAction(action.id)).toMatchObject({ id: action.id, state: 'clicked' });
      expect(firstStore.claimScheduledAction(action.id)).toBeUndefined();
      expect(firstStore.actions.find((candidate) => candidate.id === action.id)?.state).toBe('clicked');
    } finally {
      secondStore.close();
      firstStore.close();
    }
  });

  it('seeds notification recipients from the environment when SQLite has none', () => {
    vi.stubEnv('NOTIFICATION_EMAILS', 'alerts@example.com; backup@example.com');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rigohr-store-'));
    temporaryDirectories.push(directory);
    const databaseFile = path.join(directory, 'rigohr.sqlite');
    const store = new Store(databaseFile, { dataDirectory: directory, seedAdmin: false });

    try {
      expect(store.config.notificationEmails).toEqual(['alerts@example.com', 'backup@example.com']);
    } finally {
      store.close();
    }
  });
});
