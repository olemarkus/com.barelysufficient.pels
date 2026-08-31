// The boot window at the host-API façade. `hasDailyBudgetSeam` (settings/widget
// side) can only see that the prototype methods exist — they do, from
// construction — so whether the daily budget is READABLE has to be answered
// here, by the one object that can see whether the service was wired.
//
// The split under test: the read degrades to its named `unavailable` member,
// because that member exists precisely for this window; the two writes throw,
// because a command that cannot run must fail loudly rather than report a
// state it did not reach.
import { describe, expect, it, vi } from 'vitest';
import Homey from 'homey';
import { withAppHostApi } from '../../setup/appHostApi';
import type { AppContext } from '../../lib/app/appContext';
import type { DailyBudgetUiRead } from '../../lib/dailyBudget/dailyBudgetTypes';

const createHostApi = (dailyBudgetService: AppContext['dailyBudgetService']) => {
  const Base = withAppHostApi(Homey.App);
  class TestHostApi extends Base {
    protected readonly context = { dailyBudgetService } as AppContext;

    protected readonly smartTaskApi = {} as never;

    protected readonly smartTaskPayloads = {} as never;

    protected weatherCollector = undefined;

    protected registerAppFlowCards(): void {}
  }
  return new TestHostApi();
};

describe('AppHostApi daily budget in the boot window', () => {
  it('reads unavailable while the service is not wired yet', () => {
    expect(createHostApi(undefined).getDailyBudgetUiPayload()).toEqual({ kind: 'unavailable' });
  });

  it('fails loudly on the two writes instead of reporting an apply that never ran', () => {
    const api = createHostApi(undefined);
    expect(() => api.previewDailyBudgetModel({})).toThrow('DailyBudgetService must be initialized');
    expect(() => api.applyDailyBudgetModel({})).toThrow('DailyBudgetService must be initialized');
  });

  it('serves the wired service once it exists', () => {
    const read: DailyBudgetUiRead = { kind: 'budget', payload: { days: {}, todayKey: '2026-03-03' } };
    const getUiPayload = vi.fn((): DailyBudgetUiRead => read);
    expect(createHostApi({ getUiPayload } as never).getDailyBudgetUiPayload()).toBe(read);
    expect(getUiPayload).toHaveBeenCalledTimes(1);
  });
});
