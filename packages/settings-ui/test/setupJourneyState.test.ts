import { describe, expect, it, beforeEach, vi } from 'vitest';
import { shellRouteUrl } from '../src/ui/shellRoutes.ts';
import { setupJourneyFromSearch } from '../src/ui/setupJourneyState.ts';

describe('setup navigation', () => {
  it('keeps the Homey fragment through the steps and drops the step leaving setup', () => {
    const initial = { pathname: '/', search: '?page=settings/devices&setup=devices', hash: '#homey=bridge' };
    const limits = shellRouteUrl('limits', initial, 'hardCap');
    expect(limits).toContain('setup=hardCap');
    expect(limits).toContain('#homey=bridge');
    expect(shellRouteUrl('devices', initial, 'goals')).toContain('setup=goals');
    expect(shellRouteUrl('overview', initial)).not.toContain('setup');
  });

  it('ignores unknown setup contexts, the retired solar one among them', () => {
    expect(setupJourneyFromSearch('?setup=anything')).toBeNull();
    expect(setupJourneyFromSearch('?setup=solar')).toBeNull();
    expect(setupJourneyFromSearch('?setup=goals')).toBe('goals');
  });
});

describe('setup write handoff', () => {
  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/?setup=devices');
  });

  it('waits for a chained device save before allowing navigation', async () => {
    const saves = await import('../src/ui/setupJourneyState.ts');
    let finish!: () => void;
    const first = saves.trackSetupSave('device', () => new Promise<void>((resolve) => { finish = resolve; }));
    let continued = false;
    const wait = saves.waitForSetupSaves().then(() => { continued = true; });
    await Promise.resolve();
    expect(saves.setupSavePending()).toBe(true);
    expect(continued).toBe(false);
    finish();
    await first;
    await wait;
    expect(continued).toBe(true);
  });

  it('stops at a failed save even when the field handler already showed its error, and permits a retry', async () => {
    const saves = await import('../src/ui/setupJourneyState.ts');
    await saves.trackSetupSave('device', () => Promise.reject(new Error('offline'))).catch(() => undefined);
    await expect(saves.waitForSetupSaves()).rejects.toThrow('could not be saved');
    await saves.trackSetupSave('device', () => Promise.resolve());
    await expect(saves.waitForSetupSaves()).resolves.toBeUndefined();
  });

  it('does not carry failures from ordinary settings into a later setup journey', async () => {
    const saves = await import('../src/ui/setupJourneyState.ts');
    window.history.replaceState(null, '', '/?page=settings/devices');
    await saves.trackSetupSave('device', () => Promise.reject(new Error('offline'))).catch(() => undefined);
    window.history.replaceState(null, '', '/?setup=devices');
    await expect(saves.waitForSetupSaves()).resolves.toBeUndefined();
  });
});
