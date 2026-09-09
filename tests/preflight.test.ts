import { beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/config.js';
import type { PlannedAction } from '../src/types.js';
const mocks = vi.hoisted(() => ({
  actions: [] as PlannedAction[], read: vi.fn(), save: vi.fn(), config: {} as ReturnType<typeof defaultConfig>,
}));
vi.mock('../src/store.js', () => ({ makeId: () => 'test-action', store: {
  get config() { return mocks.config; }, get actions() { return mocks.actions; },
  getException: () => undefined, getRandomSeed: () => 0,
  scheduleTimeOverrides: { '2026-09-09': { 'check-in': '13:00', 'check-out': '22:15' } },
  upsertAttendance: mocks.save, addAction: (action: PlannedAction) => mocks.actions.push(action), addLog: vi.fn(),
} }));
vi.mock('../src/browser.js', () => ({ isUncertainPunchError: () => false, rigoBrowser: { readAttendance: mocks.read, failureEvidenceFrom: () => [] } }));
vi.mock('../src/mailer.js', () => ({ plannedActionContext: () => ({}), sendNotification: async () => ({ sent: false }) }));
import { evaluate } from '../src/automation.js';
beforeEach(() => { mocks.actions.length = 0; mocks.config = defaultConfig(); mocks.read.mockReset(); mocks.save.mockReset(); });
it('arms checkout from live attendance despite an earlier failed punch-in', async () => {
  mocks.actions.push({ date: '2026-09-09', action: 'check-in', state: 'failed' } as PlannedAction);
  mocks.read.mockResolvedValue({ record: { date: '2026-09-09', checkIn: '9:59a' }, screenshots: [] });
  const plans = await evaluate(new Date('2026-09-09T22:05:00+05:45'));
  expect(plans.map(p => p.action)).toEqual(['check-out']);
  expect(mocks.save).toHaveBeenCalledWith({ date: '2026-09-09', checkIn: '9:59a' });
});
it('stops an unreadable preflight without overwriting attendance or retrying', async () => {
  mocks.read.mockRejectedValue(new Error('date-row-not-found'));
  const now = new Date('2026-09-09T12:50:00+05:45');
  expect(await evaluate(now)).toEqual([]);
  expect(await evaluate(now)).toEqual([]);
  expect(mocks.read).toHaveBeenCalledTimes(1);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.actions[0].state).toBe('failed');
});
it('skips an already recorded punch-in', async () => {
  mocks.read.mockResolvedValue({ record: { date: '2026-09-09', checkIn: '9:59a' }, screenshots: [] });
  expect(await evaluate(new Date('2026-09-09T12:50:00+05:45'))).toEqual([]);
  expect(mocks.actions[0].state).toBe('skipped');
});
