import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsUiPowerPayload } from '../../contracts/src/settingsUi/power.ts';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), set: vi.fn(), render: vi.fn(), renderUsage: vi.fn(),
  panelState: { activePanel: 'limits' }, scopeListeners: [] as Array<() => void>,
  scope: vi.fn(() => ({ selectedHomeId: 'main' })),
}));
vi.mock('../src/ui/homey.ts', () => ({
  getApiReadModel: mocks.get, setSetting: mocks.set, invalidateApiCache: vi.fn(),
}));
vi.mock('../src/ui/homeScope.ts', () => ({
  getHomeScope: mocks.scope,
  subscribeToHomeScope: (listener: () => void) => { mocks.scopeListeners.push(listener); },
}));
vi.mock('../src/ui/state.ts', () => ({ state: mocks.panelState }));
vi.mock('../src/ui/views/NorwayMonthlyCapacity.tsx', () => ({ renderMonthlyCapacityUsage: mocks.renderUsage }));
vi.mock('../src/ui/views/NorwayMonthlyCapacityLimits.tsx', () => ({ renderMonthlyCapacityLimits: mocks.render }));
import {
  refreshMonthlyCapacityLimits, sendMonthlyCapacityAction, notifyMonthlyCapacitySettingChanged,
  updateMonthlyCapacityUsage, captureMonthlyCapacityRead,
} from '../src/ui/norwayMonthlyCapacityActions.ts';

const payload = (): Partial<SettingsUiPowerPayload> => ({
  norwayMonthlyCapacity: {
    state: 'ready', monthKey: '2026-11', tariffIdentity: 'grid', coverage: 'complete', peaks: [],
    average: { state: 'recorded', kw: 5.3 }, tier: { lowerKw: 5, upperKw: 10 },
    targetBoundaryKw: 5, targetLost: true, remainingMonthCap: { state: 'bounded', limitKw: 9.9 },
    hardCapRecommendation: { state: 'set', limitKw: 9.9, marginKw: 0.2 },
    advice: { state: 'suggestion', limitKw: 9.9, version: 'v1', direction: 'raise', actionable: true },
  },
  norwayMonthlyCapacityChoice: { state: 'normal' }, norwayMonthlyCapacityOutcome: { state: 'idle' },
});

beforeEach(() => {
  mocks.get.mockClear(); mocks.set.mockClear(); mocks.render.mockClear(); mocks.renderUsage.mockClear();
  mocks.panelState.activePanel = 'limits';
  mocks.scope.mockReturnValue({ selectedHomeId: 'main' });
  mocks.get.mockResolvedValue(payload()); mocks.set.mockResolvedValue(undefined);
});

describe('monthly capacity actions', () => {
  it('clears a failed-read message on fresh data without clearing an accepted outcome', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Unavailable'));
    await refreshMonthlyCapacityLimits();
    expect(mocks.renderUsage.mock.lastCall?.[1].message).toContain('could not be read');
    await refreshMonthlyCapacityLimits();
    expect(mocks.renderUsage.mock.lastCall?.[1].message).toBe('');
    mocks.get.mockImplementation(async () => ({ ...payload(), norwayMonthlyCapacityOutcome: {
      state: 'accepted', requestId: mocks.set.mock.calls[0][1].id, message: 'Monthly choice accepted.',
    } }));
    await sendMonthlyCapacityAction('cancel');
    await refreshMonthlyCapacityLimits();
    expect(mocks.renderUsage.mock.lastCall?.[1].message).toBe('Monthly choice accepted.');
  });
  it('refreshes Main after an action settles when the scope moved away and back', async () => {
    mocks.panelState.activePanel = 'usage';
    updateMonthlyCapacityUsage(payload() as SettingsUiPowerPayload);
    let release: (value: Partial<SettingsUiPowerPayload>) => void = () => {};
    const response = new Promise<Partial<SettingsUiPowerPayload>>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.get.mockImplementationOnce(() => { started(); return response; });
    const pending = sendMonthlyCapacityAction('cancel');
    try {
      await readStarted;
      mocks.scope.mockReturnValue({ selectedHomeId: 'area' });
      for (const listener of mocks.scopeListeners) listener();
      mocks.scope.mockReturnValue({ selectedHomeId: 'main' });
      for (const listener of mocks.scopeListeners) listener();
    } finally {
      release(payload());
      await pending;
    }
    await vi.waitFor(() => {
      expect(mocks.renderUsage.mock.lastCall?.[0]).toMatchObject({ state: 'ready' });
    });
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('shares Usage acknowledgement with Limits and rejects an older Usage read after acceptance', async () => {
    mocks.panelState.activePanel = 'usage';
    const initial = payload() as SettingsUiPowerPayload;
    const read = initial.norwayMonthlyCapacity;
    if (read?.state !== 'ready') throw new Error('Ready fixture required');
    const lower: SettingsUiPowerPayload = { ...initial, norwayMonthlyCapacity: { ...read, coverage: 'partial',
      advice: { state: 'suggestion', limitKw: 4.8, version: 'lower', direction: 'lower', actionable: true } } };
    updateMonthlyCapacityUsage(lower);
    const oldStamp = captureMonthlyCapacityRead();
    let release: (value: Partial<SettingsUiPowerPayload>) => void = () => {};
    const response = new Promise<Partial<SettingsUiPowerPayload>>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.get.mockImplementation(() => { started(); return response; });
    const pending = sendMonthlyCapacityAction('apply');
    try {
      await readStarted;
      await refreshMonthlyCapacityLimits();
      updateMonthlyCapacityUsage(initial, oldStamp);
      expect(mocks.renderUsage.mock.lastCall?.[1].busy).toBe(true);
      expect(mocks.get).toHaveBeenCalledOnce();
    } finally {
      release({ ...lower, norwayMonthlyCapacityOutcome: {
        state: 'accepted', requestId: mocks.set.mock.calls[0][1].id, message: 'Applied this month.',
      }, norwayMonthlyCapacityChoice: { state: 'active', normalLimitKw: 5,
        offer: { monthKey: '2026-11', tariffIdentity: 'grid', limitKw: 4.8, revision: 'lower' } } });
      await pending;
    }
    updateMonthlyCapacityUsage(initial, oldStamp);
    expect(mocks.renderUsage.mock.lastCall?.[1]).toMatchObject({ busy: false, message: 'Applied this month.',
      choice: { state: 'active', normalLimitKw: 5, offer: { limitKw: 4.8 } } });
    expect(mocks.render.mock.lastCall?.[0]).toMatchObject({ busy: false, choice: { state: 'active' } });
  });
  it('cancels the temporary limit directly from Usage after a matching owner acknowledgement', async () => {
    mocks.panelState.activePanel = 'usage';
    updateMonthlyCapacityUsage(payload() as SettingsUiPowerPayload);
    mocks.get.mockImplementation(async () => ({ ...payload(), norwayMonthlyCapacityOutcome: {
      state: 'accepted', requestId: mocks.set.mock.calls[0][1].id, message: 'Normal capacity limit restored.',
    } }));
    await sendMonthlyCapacityAction('cancel');
    expect(mocks.renderUsage.mock.lastCall?.[1]).toMatchObject({ busy: false,
      choice: { state: 'normal' }, message: 'Normal capacity limit restored.' });
  });

  it.each(['capacity_margin_kw', 'price_scheme', 'nettleie_orgnr', 'nettleie_tariffgruppe', 'norway_capacity_choice_state'])(
    'refreshes an open Limits card when %s changes', async (key) => {
      await refreshMonthlyCapacityLimits();
      notifyMonthlyCapacitySettingChanged(key);
      await Promise.resolve();
      expect(mocks.get).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps its acknowledgement poll when its own accepted state is published', async () => {
    await refreshMonthlyCapacityLimits();
    mocks.set.mockImplementation(async () => { notifyMonthlyCapacitySettingChanged('norway_capacity_choice_state'); });
    mocks.get.mockImplementation(async () => ({ ...payload(), norwayMonthlyCapacityOutcome: {
      state: 'accepted', requestId: mocks.set.mock.calls[0][1].id, message: 'Monthly choice accepted.',
    } }));
    await sendMonthlyCapacityAction('apply');
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.render.mock.lastCall?.[0]).toMatchObject({ busy: false, message: 'Monthly choice accepted.' });
  });

  it('drops an acknowledgement after changing home scope and stops polling Main', async () => {
    await refreshMonthlyCapacityLimits();
    let release: (value: Partial<SettingsUiPowerPayload>) => void = () => {};
    const response = new Promise<Partial<SettingsUiPowerPayload>>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    mocks.get.mockImplementation(() => { started(); return response; });
    const pending = sendMonthlyCapacityAction('cancel');
    try {
      await readStarted;
      mocks.scope.mockReturnValue({ selectedHomeId: 'area' });
      for (const listener of mocks.scopeListeners) listener();
    } finally {
      release({ ...payload(), norwayMonthlyCapacityOutcome: {
        state: 'accepted', requestId: mocks.set.mock.calls[0][1].id, message: 'Old Main acknowledgement',
      } });
      await pending;
    }
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.render.mock.lastCall?.[0]).toMatchObject({
      read: { state: 'hidden' }, choice: { state: 'normal' }, busy: false, message: '',
    });
  });

  it('does not claim success when a stored request is rejected by the runtime', async () => {
    await refreshMonthlyCapacityLimits();
    mocks.get.mockImplementation(async () => ({ ...payload(), norwayMonthlyCapacityOutcome: {
      state: 'rejected', requestId: mocks.set.mock.calls[0][1].id, message: 'The capacity advice changed.',
    } }));
    await sendMonthlyCapacityAction('apply');
    expect(mocks.set.mock.calls[0][1]).toMatchObject({ action: 'apply', offer: { limitKw: 9.9, revision: 'v1' } });
    expect(mocks.render.mock.lastCall?.[0]).toMatchObject({ busy: false, message: 'The capacity advice changed.' });
    expect(mocks.renderUsage.mock.lastCall?.[1]).toMatchObject({ busy: false, message: 'The capacity advice changed.' });
  });
  it('waits for the matching acknowledgement when cancelling a temporary choice', async () => {
    await refreshMonthlyCapacityLimits();
    mocks.get.mockImplementation(async () => ({ ...payload(), norwayMonthlyCapacityOutcome: {
      state: 'accepted', requestId: mocks.set.mock.calls[0][1].id, message: 'Normal capacity limit restored.',
    } }));
    await sendMonthlyCapacityAction('cancel');
    expect(mocks.set.mock.calls[0][1]).toMatchObject({ action: 'cancel' });
    expect(mocks.render.mock.lastCall?.[0]).toMatchObject({ busy: false, message: 'Normal capacity limit restored.' });
  });
});
