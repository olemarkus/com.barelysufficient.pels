import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyPowerHistoryRecovery, initPowerHistoryRecovery, powerHistoryRecoveryText,
  recoverPowerHistory, refreshPowerHistoryRecovery,
} from '../src/ui/powerHistoryRecovery.ts';
import { POWER_HISTORY_RECOVERY_REQUEST } from '../../shared-domain/src/settings/powerHistoryRecovery.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), invalidate: vi.fn(),
  scope: vi.fn(() => ({ selectedHomeId: 'main' })), listeners: [] as Array<() => void>,
}));
vi.mock('../src/ui/homey.ts', () => ({
  getApiReadModel: mocks.get, setSetting: mocks.set, invalidateApiCache: mocks.invalidate,
}));
vi.mock('../src/ui/homeScope.ts', () => ({
  getHomeScope: mocks.scope, subscribeToHomeScope: (callback: () => void) => { mocks.listeners.push(callback); },
}));

beforeEach(async () => {
  mocks.scope.mockReturnValue({ selectedHomeId: 'main' });
  mocks.set.mockResolvedValue(undefined);
  mocks.get.mockResolvedValue({ powerHistoryRecovery: { state: 'idle' } });
  document.body.innerHTML = '<div id="power-history-recovery"><button id="recover-power-history-button"></button>'
    + '<p id="power-history-recovery-status"></p></div>';
  await refreshPowerHistoryRecovery();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const status = (): string => document.getElementById('power-history-recovery-status')?.textContent ?? '';

describe('hourly history recovery', () => {
  it('uses a UUIDv4 fallback when randomUUID is unavailable over HTTP', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes });
    mocks.get.mockImplementation(async () => ({ powerHistoryRecovery: {
      state: 'done', requestId: mocks.set.mock.lastCall?.[1].id, addedHours: 1,
    } }));
    await recoverPowerHistory();
    expect(mocks.set.mock.lastCall?.[1].id).toBe('00000000-0000-4000-8000-000000000000');
    expect(status()).toContain('Recovered 1 missing hour');
  });
  it('handles a crypto failure without submitting a request or stranding the button', async () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new Error('Crypto unavailable'); } });
    await expect(recoverPowerHistory()).resolves.toBeUndefined();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(status()).toContain('could not be confirmed');
    expect(document.getElementById('recover-power-history-button')?.hasAttribute('disabled')).toBe(false);
  });

  it('waits for its matching result instead of showing another request as success', async () => {
    vi.useFakeTimers();
    let count = 0;
    mocks.get.mockImplementation(async () => ({ powerHistoryRecovery: {
      state: 'done', requestId: count++ === 0 ? 'other' : mocks.set.mock.lastCall?.[1].id, addedHours: 2,
    } }));
    const pending = recoverPowerHistory();
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(mocks.set.mock.lastCall?.[0]).toBe(POWER_HISTORY_RECOVERY_REQUEST);
    expect(mocks.set.mock.lastCall?.[1].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(status()).toContain('Recovered 2 missing hours');
    expect(document.getElementById('recover-power-history-button')?.hasAttribute('disabled')).toBe(false);
  });
  it('shows the runtime failure without claiming recovery succeeded', async () => {
    mocks.get.mockImplementation(async () => ({ powerHistoryRecovery: {
      state: 'failed', requestId: mocks.set.mock.lastCall?.[1].id, message: 'Insights could not be read.',
    } }));
    await recoverPowerHistory();
    expect(status()).toContain('Insights could not be read');
    expect(status()).not.toContain('Recovered');
  });
  it('hides and refuses the Main-only command when another meter area is selected', async () => {
    initPowerHistoryRecovery();
    mocks.scope.mockReturnValue({ selectedHomeId: 'area' });
    for (const callback of mocks.listeners) callback();
    await recoverPowerHistory();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(document.getElementById('power-history-recovery')?.hidden).toBe(true);
  });
  it('stops waiting after a minute without inventing a finished result', async () => {
    vi.useFakeTimers();
    mocks.get.mockImplementation(async () => ({ powerHistoryRecovery: {
      state: 'running', requestId: mocks.set.mock.lastCall?.[1].id,
    } }));
    const pending = recoverPowerHistory();
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(status()).toContain('has not confirmed');
    expect(document.getElementById('recover-power-history-button')?.hasAttribute('disabled')).toBe(true);
  });
  it('does not render malformed counts as a successful import', () => {
    expect(classifyPowerHistoryRecovery({ state: 'done', requestId: 'id', addedHours: -1 })).toBeNull();
    expect(classifyPowerHistoryRecovery({ state: 'done', requestId: 'id', addedHours: Number.NaN })).toBeNull();
    expect(powerHistoryRecoveryText({ state: 'done', requestId: 'id', addedHours: 0 }))
      .toContain('No missing hours could be recovered');
  });
});
