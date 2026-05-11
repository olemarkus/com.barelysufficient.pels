import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_DAILY_BUDGET_KWH,
  MIN_DAILY_BUDGET_KWH,
  PRICE_FLEX_HIGH,
  PRICE_FLEX_LOW,
  PRICE_FLEX_MEDIUM,
  PRICE_SHAPING_FLEX_SHARE,
  UNMANAGED_RESERVE_BALANCED_MODE,
  UNMANAGED_RESERVE_CONSERVATIVE_MODE,
  UNMANAGED_RESERVE_MODE,
} from '../../contracts/src/dailyBudgetConstants.ts';
import {
  SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH,
  SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH,
} from '../../contracts/src/settingsUiApi.ts';

type ApiHandler = (method: string, uri: string, body: unknown) => unknown;

const setupDom = () => {
  document.body.replaceChildren();
  const toast = document.createElement('div');
  toast.id = 'toast';
  document.body.append(toast);
};

const installHomey = async (settings: Record<string, unknown>, apiHandler: ApiHandler) => {
  const homeyModule = await import('../src/ui/homey.ts');
  homeyModule.setHomeyClient({
    ready: async () => {},
    get: (key, cb) => cb(null, settings[key] ?? null),
    set: (_key, _value, cb) => cb(null),
    api: (method, uri, bodyOrCallback, cbMaybe) => {
      let callback = cbMaybe;
      let body: unknown;
      if (typeof bodyOrCallback === 'function') {
        callback = bodyOrCallback;
      } else {
        body = bodyOrCallback;
      }
      if (typeof callback !== 'function') return;
      try {
        callback(null, apiHandler(method, uri, body));
      } catch (err) {
        callback(err);
      }
    },
  } as unknown as Parameters<typeof homeyModule.setHomeyClient>[0]);
};

describe('budgetAdjustController', () => {
  beforeEach(() => {
    setupDom();
    vi.resetModules();
  });

  it('seeds drafts from settings on load', async () => {
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: 60,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_CONSERVATIVE_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_HIGH,
      },
      () => null,
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.status).toBe('clean');
    expect(view.draft).toEqual({
      enabled: true,
      dailyBudgetKWh: 60,
      priceShaping: true,
      controlledWeight: UNMANAGED_RESERVE_CONSERVATIVE_MODE,
      priceFlexShare: PRICE_FLEX_HIGH,
    });
    expect(view.candidate).toBeNull();
  });

  it('clamps kWh to bounds and falls back to defaults for missing settings', async () => {
    await installHomey(
      {
        daily_budget_enabled: false,
        daily_budget_kwh: MAX_DAILY_BUDGET_KWH + 100,
      },
      () => null,
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.draft.dailyBudgetKWh).toBe(MAX_DAILY_BUDGET_KWH);
    expect(view.draft.priceShaping).toBe(true);
    expect(view.draft.controlledWeight).toBe(UNMANAGED_RESERVE_MODE);
    expect(view.draft.priceFlexShare).toBe(PRICE_SHAPING_FLEX_SHARE);
    expect(view.draft.enabled).toBe(false);
  });

  it('flips status to dirty when a field changes and back to clean when reverted', async () => {
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      () => null,
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();

    controller.updateBudgetAdjustField({ dailyBudgetKWh: 100 });
    expect(controller.getBudgetAdjustView().status).toBe('dirty');

    controller.updateBudgetAdjustField({ dailyBudgetKWh: MIN_DAILY_BUDGET_KWH });
    expect(controller.getBudgetAdjustView().status).toBe('clean');
  });

  it('previews via API and exposes candidate + payload', async () => {
    const previewHandler = vi.fn<(body: unknown) => unknown>(() => ({
      active: { days: {}, todayKey: 't' },
      candidate: { days: {}, todayKey: 't' },
      settings: {
        enabled: true,
        dailyBudgetKWh: 100,
        priceShapingEnabled: false,
        controlledUsageWeight: UNMANAGED_RESERVE_CONSERVATIVE_MODE,
        priceShapingFlexShare: PRICE_FLEX_LOW,
      },
    }));
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri, body) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          return previewHandler(body);
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();

    controller.updateBudgetAdjustField({ dailyBudgetKWh: 100 });
    await controller.previewBudgetAdjust();

    const view = controller.getBudgetAdjustView();
    expect(view.status).toBe('pending');
    expect(view.candidate).toEqual({
      enabled: true,
      dailyBudgetKWh: 100,
      priceShaping: false,
      controlledWeight: UNMANAGED_RESERVE_CONSERVATIVE_MODE,
      priceFlexShare: PRICE_FLEX_LOW,
    });
    expect(controller.getBudgetAdjustCandidatePayload()).not.toBeNull();
    expect(previewHandler).toHaveBeenCalledTimes(1);
  });

  it('applies via API, clears preview, and refreshes the active plan', async () => {
    const refreshSpy = vi.fn(async () => {});
    const applyHandler = vi.fn<(body: unknown) => unknown>(() => ({ days: {}, todayKey: 'today' }));
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri, body) => {
        if (method === 'POST' && uri === SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH) {
          return applyHandler(body);
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    controller.setBudgetAdjustRefresh(refreshSpy);
    await controller.loadBudgetAdjust();

    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80, priceShaping: false });
    await controller.applyBudgetAdjust();

    const view = controller.getBudgetAdjustView();
    expect(view.status).toBe('clean');
    expect(view.draft.dailyBudgetKWh).toBe(80);
    expect(view.draft.priceShaping).toBe(false);
    expect(view.candidate).toBeNull();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(applyHandler).toHaveBeenCalledTimes(1);
  });

  it('discards a pending preview and reverts the working draft', async () => {
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          return {
            active: { days: {}, todayKey: 't' },
            candidate: { days: {}, todayKey: 't' },
            settings: {
              enabled: true,
              dailyBudgetKWh: 75,
              priceShapingEnabled: true,
              controlledUsageWeight: UNMANAGED_RESERVE_BALANCED_MODE,
              priceShapingFlexShare: PRICE_FLEX_MEDIUM,
            },
          };
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();

    controller.updateBudgetAdjustField({ dailyBudgetKWh: 75 });
    await controller.previewBudgetAdjust();
    expect(controller.getBudgetAdjustView().status).toBe('pending');

    controller.discardBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.status).toBe('clean');
    expect(view.draft.dailyBudgetKWh).toBe(MIN_DAILY_BUDGET_KWH);
    expect(view.candidate).toBeNull();
  });

  it('tolerates stringified persisted settings', async () => {
    await installHomey(
      {
        daily_budget_enabled: 'true',
        daily_budget_kwh: '75',
        daily_budget_price_shaping_enabled: 0,
        daily_budget_controlled_weight: '1',
        daily_budget_price_flex_share: '0.85',
      },
      () => null,
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.draft.enabled).toBe(true);
    expect(view.draft.dailyBudgetKWh).toBe(75);
    expect(view.draft.priceShaping).toBe(false);
    expect(view.draft.controlledWeight).toBe(UNMANAGED_RESERVE_CONSERVATIVE_MODE);
    expect(view.draft.priceFlexShare).toBe(PRICE_FLEX_HIGH);
  });

  it('returns to dirty when preview API throws', async () => {
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          throw new Error('boom');
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 100 });
    await controller.previewBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.status).toBe('dirty');
    expect(view.candidate).toBeNull();
    expect(view.busy).toBe(false);
  });

  it('refreshes active state from fresh settings when apply throws', async () => {
    const refreshSpy = vi.fn<(payload?: unknown) => Promise<void>>(async () => {});
    const settings: Record<string, unknown> = {
      daily_budget_enabled: true,
      daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
      daily_budget_price_shaping_enabled: true,
      daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
      daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
    };
    await installHomey(
      settings,
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH) {
          // Simulate a partial-success: backend persisted the new value before
          // the post-apply step failed.
          settings.daily_budget_kwh = 80;
          throw new Error('apply blew up');
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    controller.setBudgetAdjustRefresh(refreshSpy);
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    await controller.applyBudgetAdjust();
    expect(refreshSpy).toHaveBeenCalled();
    expect(refreshSpy.mock.calls[0]?.[0]).toBeUndefined();
    const view = controller.getBudgetAdjustView();
    expect(view.busy).toBe(false);
    // Recovery must observe the post-apply backend value (80), not the
    // cached pre-apply read.
    expect(view.active.dailyBudgetKWh).toBe(80);
    expect(view.draft.dailyBudgetKWh).toBe(80);
  });

  it('rejects preview when no candidate is returned', async () => {
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          return { active: null, candidate: null, settings: null };
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 100 });
    await controller.previewBudgetAdjust();
    expect(controller.getBudgetAdjustView().status).toBe('dirty');
  });

  it('discards in-flight preview response when user edits during the await', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          // Defer resolution so the test can edit the draft mid-flight.
          return new Promise((resolve) => { resolveCall = resolve; });
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    const previewPromise = controller.previewBudgetAdjust();
    // user edits while preview is still in flight
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 90 });
    resolveCall({
      active: { days: {}, todayKey: 't' },
      candidate: { days: {}, todayKey: 't' },
      settings: {
        enabled: true,
        dailyBudgetKWh: 80,
        priceShapingEnabled: true,
        controlledUsageWeight: UNMANAGED_RESERVE_BALANCED_MODE,
        priceShapingFlexShare: PRICE_FLEX_MEDIUM,
      },
    });
    await previewPromise;
    const view = controller.getBudgetAdjustView();
    expect(view.draft.dailyBudgetKWh).toBe(90);
    expect(view.status).toBe('dirty');
    expect(view.candidate).toBeNull();
  });

  it('passes applied settings through to the refresh hook on success', async () => {
    const refreshSpy = vi.fn<(args?: { appliedSettings?: unknown; payload?: unknown }) => Promise<void>>(async () => {});
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_APPLY_DAILY_BUDGET_MODEL_PATH) {
          return { days: {}, todayKey: 't' };
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    controller.setBudgetAdjustRefresh(refreshSpy);
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 100 });
    await controller.applyBudgetAdjust();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    const args = refreshSpy.mock.calls[0]?.[0];
    expect(args?.appliedSettings).toMatchObject({ dailyBudgetKWh: 100, enabled: true });
  });

  it('refreshBudgetAdjust replaces clean draft from settings', async () => {
    const settings: Record<string, unknown> = {
      daily_budget_enabled: true,
      daily_budget_kwh: 50,
      daily_budget_price_shaping_enabled: true,
      daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
      daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
    };
    await installHomey(settings, () => null);
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    expect(controller.getBudgetAdjustView().draft.dailyBudgetKWh).toBe(50);

    settings.daily_budget_kwh = 90;
    settings.daily_budget_controlled_weight = UNMANAGED_RESERVE_CONSERVATIVE_MODE;
    await controller.refreshBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.draft.dailyBudgetKWh).toBe(90);
    expect(view.draft.controlledWeight).toBe(UNMANAGED_RESERVE_CONSERVATIVE_MODE);
    expect(view.active.dailyBudgetKWh).toBe(90);
    expect(view.status).toBe('clean');
  });

  it('refreshBudgetAdjust clears a pending preview because the candidate is now stale', async () => {
    const settings: Record<string, unknown> = {
      daily_budget_enabled: true,
      daily_budget_kwh: 50,
      daily_budget_price_shaping_enabled: true,
      daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
      daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
    };
    await installHomey(settings, (method, uri) => {
      if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
        return {
          active: { days: {}, todayKey: 't' },
          candidate: { days: {}, todayKey: 't' },
          settings: {
            enabled: true,
            dailyBudgetKWh: 80,
            priceShapingEnabled: true,
            controlledUsageWeight: UNMANAGED_RESERVE_BALANCED_MODE,
            priceShapingFlexShare: PRICE_FLEX_MEDIUM,
          },
        };
      }
      throw new Error(`unexpected ${method} ${uri}`);
    });
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    await controller.previewBudgetAdjust();
    expect(controller.getBudgetAdjustView().status).toBe('pending');
    expect(controller.getBudgetAdjustCandidatePayload()).not.toBeNull();

    settings.daily_budget_kwh = 60;
    await controller.refreshBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.candidate).toBeNull();
    expect(controller.getBudgetAdjustCandidatePayload()).toBeNull();
    expect(view.status).toBe('dirty');
    expect(view.draft.dailyBudgetKWh).toBe(80);
    expect(view.active.dailyBudgetKWh).toBe(60);
  });

  it('refreshBudgetAdjust preserves user draft when dirty and updates active baseline', async () => {
    const settings: Record<string, unknown> = {
      daily_budget_enabled: true,
      daily_budget_kwh: 50,
      daily_budget_price_shaping_enabled: true,
      daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
      daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
    };
    await installHomey(settings, () => null);
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    expect(controller.getBudgetAdjustView().status).toBe('dirty');

    settings.daily_budget_kwh = 60;
    await controller.refreshBudgetAdjust();
    const view = controller.getBudgetAdjustView();
    expect(view.draft.dailyBudgetKWh).toBe(80);
    expect(view.active.dailyBudgetKWh).toBe(60);
    expect(view.status).toBe('dirty');
  });

  it('drops in-flight preview response after discardBudgetAdjust', async () => {
    let resolveCall: (value: unknown) => void = () => {};
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          return new Promise((resolve) => { resolveCall = resolve; });
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    const previewPromise = controller.previewBudgetAdjust();
    controller.discardBudgetAdjust();
    resolveCall({
      active: { days: {}, todayKey: 't' },
      candidate: { days: {}, todayKey: 't' },
      settings: {
        enabled: true,
        dailyBudgetKWh: 80,
        priceShapingEnabled: true,
        controlledUsageWeight: UNMANAGED_RESERVE_BALANCED_MODE,
        priceShapingFlexShare: PRICE_FLEX_MEDIUM,
      },
    });
    await previewPromise;
    const view = controller.getBudgetAdjustView();
    expect(view.status).toBe('clean');
    expect(view.candidate).toBeNull();
    expect(controller.getBudgetAdjustCandidatePayload()).toBeNull();
  });

  it('drops in-flight preview response after refreshBudgetAdjust', async () => {
    const settings: Record<string, unknown> = {
      daily_budget_enabled: true,
      daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
      daily_budget_price_shaping_enabled: true,
      daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
      daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
    };
    let resolveCall: (value: unknown) => void = () => {};
    await installHomey(settings, (method, uri) => {
      if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
        return new Promise((resolve) => { resolveCall = resolve; });
      }
      throw new Error(`unexpected ${method} ${uri}`);
    });
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    const previewPromise = controller.previewBudgetAdjust();
    settings.daily_budget_kwh = 60;
    await controller.refreshBudgetAdjust();
    resolveCall({
      active: { days: {}, todayKey: 't' },
      candidate: { days: {}, todayKey: 't' },
      settings: {
        enabled: true,
        dailyBudgetKWh: 80,
        priceShapingEnabled: true,
        controlledUsageWeight: UNMANAGED_RESERVE_BALANCED_MODE,
        priceShapingFlexShare: PRICE_FLEX_MEDIUM,
      },
    });
    await previewPromise;
    const view = controller.getBudgetAdjustView();
    expect(view.candidate).toBeNull();
    expect(controller.getBudgetAdjustCandidatePayload()).toBeNull();
    expect(view.status).not.toBe('pending');
  });

  it('exposes the active and candidate payloads as independent values', async () => {
    const activePayload = { days: { t: { id: 'active' } }, todayKey: 't' };
    const candidatePayload = { days: { t: { id: 'candidate' } }, todayKey: 't' };
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: 60,
        daily_budget_price_shaping_enabled: true,
        daily_budget_controlled_weight: UNMANAGED_RESERVE_BALANCED_MODE,
        daily_budget_price_flex_share: PRICE_FLEX_MEDIUM,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          return {
            active: activePayload,
            candidate: candidatePayload,
            settings: {
              enabled: true,
              dailyBudgetKWh: 80,
              priceShapingEnabled: true,
              controlledUsageWeight: UNMANAGED_RESERVE_BALANCED_MODE,
              priceShapingFlexShare: PRICE_FLEX_MEDIUM,
            },
          };
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();

    controller.updateBudgetAdjustField({ dailyBudgetKWh: 80 });
    await controller.previewBudgetAdjust();

    // The "Current plan" chart must read the active baseline, not the candidate.
    expect(controller.getBudgetAdjustActivePayload()).toBe(activePayload);
    expect(controller.getBudgetAdjustCandidatePayload()).toBe(candidatePayload);
    expect(controller.getBudgetAdjustActivePayload())
      .not.toBe(controller.getBudgetAdjustCandidatePayload());
  });

  it('does not preview while clean', async () => {
    const previewSpy = vi.fn();
    await installHomey(
      {
        daily_budget_enabled: true,
        daily_budget_kwh: MIN_DAILY_BUDGET_KWH,
        daily_budget_price_shaping_enabled: true,
      },
      (method, uri) => {
        if (method === 'POST' && uri === SETTINGS_UI_PREVIEW_DAILY_BUDGET_MODEL_PATH) {
          previewSpy();
          return { active: {}, candidate: {}, settings: {} };
        }
        throw new Error(`unexpected ${method} ${uri}`);
      },
    );
    const controller = await import('../src/ui/budgetAdjustController.ts');
    await controller.loadBudgetAdjust();
    await controller.previewBudgetAdjust();
    expect(previewSpy).not.toHaveBeenCalled();
    expect(controller.getBudgetAdjustView().status).toBe('clean');
  });
});
