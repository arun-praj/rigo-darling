import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstanceLock } from '../src/instance-lock.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('attendance assistant instance lock', () => {
  it('allows one owner and rejects a live second owner', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rigohr-instance-lock-'));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, 'assistant.lock');
    const first = new InstanceLock(lockPath);
    const second = new InstanceLock(lockPath);

    first.acquire();
    expect(() => second.acquire()).toThrow(/already running/);
    first.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    second.acquire();
    second.release();
  });

  it('replaces a stale or malformed lock file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rigohr-instance-lock-'));
    temporaryDirectories.push(directory);
    const lockPath = path.join(directory, 'assistant.lock');
    fs.writeFileSync(lockPath, 'not-a-live-pid\n');

    const lock = new InstanceLock(lockPath);
    lock.acquire();
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
