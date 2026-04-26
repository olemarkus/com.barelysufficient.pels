import { normalizeUiTestPlanSnapshot, installHomeyMock } from './helpers/homeyApiMock.ts';
import { SETTINGS_UI_POWER_PATH } from '../../contracts/src/settingsUiApi.ts';
import { buildComparablePlanReason } from '../../shared-domain/src/planReasonSemantics.ts';

describe('Legacy plan UI', () => {
  
  const setupPlanDom = () => {
    document.body.innerHTML = `
      <section id="overview-panel">
        <div id="plan-list"></div>
        <div id="plan-empty"></div>
        <div id="plan-meta"></div>
      </section>
    `;
  };
  
  const renderPlanSnapshot = async (plan: unknown) => {
    vi.resetModules();
    setupPlanDom();
    const { renderPlan } = await import('../src/ui/plan.ts');
    renderPlan(normalizeUiTestPlanSnapshot(plan) as Parameters<typeof renderPlan>[0]);
  };
  
  const getUsageText = () => {
    const lines = Array.from(document.querySelectorAll('.plan-meta-line'));
    const usageLine = lines.find((line) => line.querySelector('.plan-label')?.textContent === 'Usage');
    return usageLine?.querySelector('span:last-child')?.textContent?.trim();
  };
  
  const getStateText = () => {
    const lines = Array.from(document.querySelectorAll('.plan-meta-line'));
    const stateLine = lines.find((line) => line.querySelector('.plan-label')?.textContent === 'State');
    return stateLine?.querySelector('span:last-child')?.textContent?.trim();
  };
  
  const getTemperatureText = () => {
    const lines = Array.from(document.querySelectorAll('.plan-meta-line'));
    const temperatureLine = lines.find((line) => line.querySelector('.plan-label')?.textContent === 'Temperature');
    return temperatureLine?.querySelector('span:last-child')?.textContent?.trim();
  };
  
  const getPowerText = () => {
    const lines = Array.from(document.querySelectorAll('.plan-meta-line'));
    const powerLine = lines.find((line) => line.querySelector('.plan-label')?.textContent === 'Power');
    return powerLine?.querySelector('span:last-child')?.textContent?.trim();
  };
  
  const getStatusText = () => {
    const lines = Array.from(document.querySelectorAll('.plan-meta-line'));
    const statusLine = lines.find((line) => line.querySelector('.plan-label')?.textContent === 'Status');
    return statusLine?.querySelector('span:last-child')?.textContent?.trim();
  };
  
  const getBadgeClassList = (deviceId: string): DOMTokenList | null => {
    const dot = document.querySelector(`[data-device-id="${deviceId}"] .plan-state-indicator`) as HTMLElement | null;
    if (!dot) return null;
    return dot.classList;
  };
  
  const getBadgeTooltip = (deviceId: string): string | null => {
    const dot = document.querySelector(`[data-device-id="${deviceId}"] .plan-state-indicator`) as HTMLElement | null;
    return dot?.getAttribute('data-tooltip');
  };
  
  const getPlanMetaText = () => {
    const meta = document.querySelector('#plan-meta') as HTMLElement | null;
    if (!meta) return [];
    const lineItems = Array.from(meta.querySelectorAll('.plan-meta-line-text'));
    if (lineItems.length > 0) {
      return lineItems.map((el) => el.textContent?.trim());
    }
    return Array.from(meta.children).map((el) => el.textContent?.trim());
  };
  
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (document as Document & { hidden?: boolean }).hidden;
  });
  
  describe('plan usage line', () => {
    it('shows Measured and Expected when measured matches Expected', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-1',
            name: 'Device 1',
            currentState: 'on',
            plannedState: 'keep',
            expectedPowerKw: 1.234,
            measuredPowerKw: 1.234,
          },
        ],
      });
  
      expect(getUsageText()).toBe('Measured: 1.23 kW / Expected: 1.23 kW');
    });
  
    it('shows Measured and Expected when values differ', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-2',
            name: 'Device 2',
            currentState: 'on',
            plannedState: 'keep',
            expectedPowerKw: 1.2,
            measuredPowerKw: 0,
          },
        ],
      });
  
      expect(getUsageText()).toBe('Measured: 0.00 kW / Expected: 1.20 kW');
    });
  
    it('shows Measured 0 when measured is zero and Expected is positive', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-3',
            name: 'Device 3',
            currentState: 'on',
            plannedState: 'keep',
            expectedPowerKw: 1,
            measuredPowerKw: 0,
          },
        ],
      });
  
      expect(getUsageText()).toBe('Measured: 0.00 kW / Expected: 1.00 kW');
    });
  
    it('shows stepped-load planning and live usage with target-step labeling', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-step-1',
            name: 'Water heater',
            controlModel: 'stepped_load',
            currentState: 'on',
            plannedState: 'keep',
            selectedStepId: 'max',
            desiredStepId: 'max',
            planningPowerKw: 3,
            measuredPowerKw: 0,
          },
        ],
      });
  
      expect(getPowerText()).toBeUndefined();
      expect(getUsageText()).toBe('Measured: 0.00 kW / Expected: 3.00 kW (target: max)');
    });
  
    it('shows stepped-load usage with target-step labels when no report exists', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-step-assumed',
            name: 'Water heater',
            controlModel: 'stepped_load',
            currentState: 'on',
            plannedState: 'keep',
            selectedStepId: 'max',
            assumedStepId: 'max',
            desiredStepId: 'max',
            planningPowerKw: 3,
            measuredPowerKw: 0,
          },
        ],
      });
  
      expect(getPowerText()).toBeUndefined();
      expect(getUsageText()).toBe('Measured: 0.00 kW / Expected: 3.00 kW (target: max)');
    });
  });
  
  describe('plan meta usage summary', () => {
    it('shows controlled and uncontrolled usage when total is known', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 3.5,
          softLimitKw: 5,
          headroomKw: 1.5,
          controlledKw: 2.0,
          uncontrolledKw: 1.5,
        },
        devices: [
          {
            id: 'dev-1',
            name: 'Controllable Measured',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            measuredPowerKw: 1.2,
          },
          {
            id: 'dev-2',
            name: 'Controllable Expected',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            expectedPowerKw: 0.8,
          },
        ],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line === 'Capacity-controlled 2.00kW / Other load 1.50kW')).toBe(true);
    });
  
    it('shows meta lines even when no devices are managed', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 3.5,
          softLimitKw: 5,
          headroomKw: 1.5,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line === 'Now 3.5kW (soft limit 5.0kW)')).toBe(true);
      expect(metaLines.some((line) => line === '1.5kW available')).toBe(true);
  
      const empty = document.querySelector('#plan-empty') as HTMLElement | null;
      expect(empty?.textContent?.trim()).toBe('No managed devices.');
    });
  
    it('shows hard-cap breach text for capacity shortfall', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 7.2,
          softLimitKw: 4.8,
          headroomKw: -2.4,
          capacityShortfall: true,
          shortfallBudgetThresholdKw: 6,
          shortfallBudgetHeadroomKw: -1.2,
          hardCapHeadroomKw: -1.2,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line === 'Hard limit breached by 1.2kW')).toBe(true);
      expect(metaLines.some((line) => line === 'Shortfall threshold 6.0kW (hourly budget-derived)')).toBe(true);
      expect(metaLines.some((line) => line === '2.4kW over soft limit')).toBe(false);
    });
  
    it('keeps soft-limit text when negative headroom is not a hard-cap shortfall', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.2,
          softLimitKw: 4.8,
          headroomKw: -0.4,
          capacityShortfall: false,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line === '0.4kW over soft limit')).toBe(true);
      expect(metaLines.some((line) => line.startsWith('Hard limit breached'))).toBe(false);
    });
  
    it('shows remaining hard-cap headroom while above soft limit', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.2,
          softLimitKw: 4.8,
          headroomKw: -0.4,
          capacityShortfall: false,
          shortfallBudgetThresholdKw: 8.5,
          shortfallBudgetHeadroomKw: 3.3,
          hardCapHeadroomKw: 0.8,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line === '0.4kW over soft limit')).toBe(true);
      expect(metaLines.some((line) => line === '0.8kW before hard limit')).toBe(true);
      expect(metaLines.some((line) => line === 'Shortfall-threshold headroom 3.3kW')).toBe(true);
    });
  
    it('shows hard-cap breach text before shortfall state is entered', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 7.4,
          softLimitKw: 4.8,
          headroomKw: -2.6,
          capacityShortfall: false,
          shortfallBudgetThresholdKw: 4.8,
          shortfallBudgetHeadroomKw: -2.6,
          hardCapHeadroomKw: -2.6,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line === 'Hard limit breached by 2.6kW')).toBe(true);
      expect(metaLines.some((line) => line === 'Shortfall threshold 4.8kW (hourly budget-derived)')).toBe(true);
      expect(metaLines.some((line) => line === '2.6kW over soft limit')).toBe(false);
    });
  
    it('updates the plan age text live', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:10Z'));
  
      await renderPlanSnapshot({
        meta: {
          totalKw: 3.5,
          softLimitKw: 5,
          headroomKw: 1.5,
          lastPowerUpdateMs: Date.now() - 10_000,
        },
        devices: [],
      });
  
      expect(getPlanMetaText().some((line) => line === 'Now 3.5kW (10s ago) (soft limit 5.0kW)')).toBe(true);
  
      await vi.advanceTimersByTimeAsync(1000);
  
      expect(getPlanMetaText().some((line) => line === 'Now 3.5kW (11s ago) (soft limit 5.0kW)')).toBe(true);
    });
  });
  
  describe('plan live timing', () => {
    it('updates timed status text live', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-live-status',
            name: 'Live status device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (3s remaining)',
          },
        ],
      });
  
      expect(getStatusText()).toBe('waiting for meter to settle (3s remaining)');
  
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStatusText()).toBe('waiting for meter to settle (2s remaining)');
  
      await vi.advanceTimersByTimeAsync(2000);
      expect(getStatusText()).toBe('keep');
    });
  
    it('stops the live ticker after the last countdown reaches zero', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-stop-ticker',
            name: 'Stop ticker device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (1s remaining)',
          },
        ],
      });
  
      expect(vi.getTimerCount()).toBeGreaterThan(0);
  
      await vi.advanceTimersByTimeAsync(1000);
  
      expect(getStatusText()).toBe('keep');
      expect(vi.getTimerCount()).toBe(0);
    });
  
    it('keeps the same plan row node while ticking', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-stable-row',
            name: 'Stable row device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (3s remaining)',
          },
        ],
      });
  
      const initialRow = document.querySelector('[data-device-id="dev-stable-row"]');
      expect(initialRow).toBeTruthy();
  
      await vi.advanceTimersByTimeAsync(1000);
  
      expect(document.querySelector('[data-device-id="dev-stable-row"]')).toBe(initialRow);
      expect(getStatusText()).toBe('waiting for meter to settle (2s remaining)');
    });
  
    it('anchors countdowns to snapshot generatedAtMs instead of render time', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
      await renderPlanSnapshot({
        generatedAtMs: Date.parse('2026-04-18T11:59:58Z'),
        devices: [
          {
            id: 'dev-generated-at',
            name: 'Generated-at device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (5s remaining)',
          },
        ],
      });
  
      expect(getStatusText()).toBe('waiting for meter to settle (3s remaining)');
  
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStatusText()).toBe('waiting for meter to settle (2s remaining)');
    });
  
    it('does not restart countdowns when the same stale snapshot is rendered again', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
      vi.resetModules();
      setupPlanDom();
  
      const { renderPlan } = await import('../src/ui/plan.ts');
      const staleSnapshot = normalizeUiTestPlanSnapshot({
        generatedAtMs: Date.parse('2026-04-18T11:59:58Z'),
        devices: [
          {
            id: 'dev-stale-rerender',
            name: 'Stale rerender device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (5s remaining)',
          },
        ],
      }) as Parameters<typeof renderPlan>[0];
  
      renderPlan(staleSnapshot);
      expect(getStatusText()).toBe('waiting for meter to settle (3s remaining)');
  
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStatusText()).toBe('waiting for meter to settle (2s remaining)');
  
      renderPlan(staleSnapshot);
      expect(getStatusText()).toBe('waiting for meter to settle (2s remaining)');
    });
  
    it('falls back to render-time anchoring when generatedAtMs is missing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-render-fallback',
            name: 'Render fallback device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (3s remaining)',
          },
        ],
      });
  
      expect(getStatusText()).toBe('waiting for meter to settle (3s remaining)');
  
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStatusText()).toBe('waiting for meter to settle (2s remaining)');
    });
  
    it('restarts live ticking when the document becomes visible again', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
      vi.resetModules();
      setupPlanDom();
  
      let hidden = false;
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hidden,
      });
  
      const { renderPlan } = await import('../src/ui/plan.ts');
      renderPlan(normalizeUiTestPlanSnapshot({
        devices: [
          {
            id: 'dev-visibility',
            name: 'Visibility device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (3s remaining)',
          },
        ],
      }) as Parameters<typeof renderPlan>[0]);
  
      hidden = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(getStatusText()).toBe('waiting for meter to settle (3s remaining)');
  
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
      expect(getStatusText()).toBe('waiting for meter to settle (1s remaining)');
  
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStatusText()).toBe('keep');
    });
  
    it('restarts live ticking when the overview tab becomes active again', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00Z'));
      vi.resetModules();
      setupPlanDom();
  
      const overviewPanel = document.querySelector('#overview-panel') as HTMLElement;
      const { renderPlan } = await import('../src/ui/plan.ts');
      renderPlan(normalizeUiTestPlanSnapshot({
        devices: [
          {
            id: 'dev-overview-reactivation',
            name: 'Overview reactivation device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (3s remaining)',
          },
        ],
      }) as Parameters<typeof renderPlan>[0]);
  
      overviewPanel.classList.add('hidden');
      await vi.advanceTimersByTimeAsync(2000);
      expect(getStatusText()).toBe('waiting for meter to settle (3s remaining)');
  
      overviewPanel.classList.remove('hidden');
      document.dispatchEvent(new Event('overview-tab-activated'));
      expect(getStatusText()).toBe('waiting for meter to settle (1s remaining)');
  
      await vi.advanceTimersByTimeAsync(1000);
      expect(getStatusText()).toBe('keep');
    });
  });
  
  describe('plan device state', () => {
    it('shows capacity control off state for non-controllable devices', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-1',
            name: 'Device 1',
            currentState: 'off',
            plannedState: 'keep',
            controllable: false,
          },
        ],
      });
  
      expect(getStateText()).toBe('Capacity control off');
    });
  
    it('shows stale unknown live state without calling it restoring', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-stale',
            name: 'Stale socket',
            currentState: 'unknown',
            plannedState: 'keep',
            observationStale: true,
            controllable: true,
          },
        ],
      });
  
      expect(getStateText()).toBe('State unknown');
      expect(getBadgeTooltip('dev-stale')).toBe('State unknown');
      expect(getBadgeClassList('dev-stale')?.contains('neutral')).toBe(true);
    });
  
    it('shows unavailable devices with an unavailable badge', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-missing',
            name: 'Missing device',
            currentState: 'unknown',
            plannedState: 'keep',
            observationStale: true,
            available: false,
            controllable: true,
          },
        ],
      });
  
      expect(getBadgeTooltip('dev-missing')).toBe('Unavailable');
      expect(getStateText()).toBe('Unavailable');
      expect(getBadgeClassList('dev-missing')?.contains('neutral')).toBe(true);
    });
  
    it('renders badge color classes per device plan state', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-active',
            name: 'Device Active',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
          },
          {
            id: 'dev-shed',
            name: 'Device Shed',
            currentState: 'on',
            plannedState: 'shed',
            controllable: true,
          },
          {
            id: 'dev-inactive',
            name: 'Device Inactive',
            currentState: 'off',
            plannedState: 'inactive',
            controllable: true,
          },
          {
            id: 'dev-uncontrolled',
            name: 'Device Uncontrolled',
            currentState: 'off',
            plannedState: 'keep',
            controllable: false,
          },
          {
            id: 'dev-on-uncontrolled',
            name: 'Device On Uncontrolled',
            currentState: 'on',
            plannedState: 'keep',
            controllable: false,
          },
          {
            id: 'dev-off-controllable',
            name: 'Device Off Controllable',
            currentState: 'off',
            plannedState: 'keep',
            controllable: true,
          },
        ],
      });
  
      expect(getBadgeClassList('dev-active')?.contains('cheap')).toBe(true);
      expect(getBadgeClassList('dev-shed')?.contains('expensive')).toBe(true);
      expect(getBadgeClassList('dev-inactive')?.contains('neutral')).toBe(true);
      expect(getBadgeClassList('dev-uncontrolled')?.contains('neutral')).toBe(true);
      expect(getBadgeClassList('dev-on-uncontrolled')?.contains('neutral')).toBe(true);
      expect(getBadgeClassList('dev-off-controllable')?.contains('neutral')).toBe(true);
    });
  
    it('shows a budget exempt chip next to the device name', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-budget',
            name: 'Device Budget',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            budgetExempt: true,
          },
        ],
      });
  
      const chip = document.querySelector('[data-device-id="dev-budget"] .plan-row__chip') as HTMLElement | null;
      expect(chip?.textContent?.trim()).toBe('Budget exempt');
    });
  
    it('uses the shared tooltip hook for the plan state badge', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-tip',
            name: 'Tooltip device',
            currentState: 'unknown',
            plannedState: 'keep',
            observationStale: true,
            controllable: true,
          },
        ],
      });
  
      const badge = document.querySelector('[data-device-id="dev-tip"] .plan-state-indicator') as HTMLElement | null;
      expect(badge?.getAttribute('data-tooltip')).toBe('State unknown');
      expect(badge?.getAttribute('title')).toBeNull();
    });
  
    it('keeps the state line on controllable-off devices even when the device is gray', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-gray-uncontrolled',
            name: 'Gray uncontrolled',
            currentState: 'unknown',
            plannedState: 'keep',
            controllable: false,
            observationStale: true,
            available: false,
          },
        ],
      });
  
      expect(getBadgeTooltip('dev-gray-uncontrolled')).toBe('Uncontrolled');
      expect(getStateText()).toBe('Capacity control off');
    });
  
    it('shows pending confirmation text while a target write is still unconfirmed', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-temp-pending',
            name: 'Pending Heater',
            currentState: 'on',
            plannedState: 'keep',
            currentTemperature: 21,
            currentTarget: 18,
            plannedTarget: 23,
            pendingTargetCommand: {
              desired: 23,
              retryCount: 0,
              nextRetryAtMs: Date.now() + 30_000,
              status: 'waiting_confirmation',
            },
          },
        ],
      });
  
      expect(getTemperatureText()).toBe('21.0° / target 18° → 23° (waiting for confirmation)');
    });
  
    it('shows temporary unavailable text while target retries are backed off', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-temp-unavailable',
            name: 'Pending Heater',
            currentState: 'on',
            plannedState: 'keep',
            currentTemperature: 21,
            currentTarget: 18,
            plannedTarget: 23,
            pendingTargetCommand: {
              desired: 23,
              retryCount: 0,
              nextRetryAtMs: Date.now() + 30_000,
              status: 'temporary_unavailable',
            },
          },
        ],
      });
  
      expect(getTemperatureText()).toBe('21.0° / target 18° → 23° (temporarily unavailable)');
    });
  
    it('does not show a temperature line for non-temperature devices that only expose a temperature reading', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-ev-temp-sensor',
            name: 'EV Charger',
            deviceType: 'onoff',
            deviceClass: 'evcharger',
            controlCapabilityId: 'evcharger_charging',
            currentState: 'on',
            plannedState: 'keep',
            currentTemperature: 24,
            currentTarget: null,
            plannedTarget: null,
          },
        ],
      });
  
      expect(getTemperatureText()).toBeUndefined();
    });
  
    it('shows on-like stepped mode transitions as active rather than restoring', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-step-mode-transition',
            name: 'Water heater',
            controlModel: 'stepped_load',
            currentState: 'on',
            plannedState: 'keep',
            reportedStepId: 'low',
            targetStepId: 'max',
            selectedStepId: 'low',
            desiredStepId: 'max',
            planningPowerKw: 3,
            measuredPowerKw: 0.6,
            controllable: true,
            reason: 'cooldown (restore, 40s remaining)',
          },
        ],
      });
  
      expect(getPowerText()).toBeUndefined();
      expect(getStateText()).toBe('Active (low → max)');
      expect(getUsageText()).toBe('Measured: 0.60 kW / Expected: 3.00 kW (reported: low / target: max)');
      expect(getStatusText()).toBe('cooldown (restore, 40s remaining)');
      expect(getBadgeClassList('dev-step-mode-transition')?.contains('cheap')).toBe(true);
    });
  
    it('keeps stepped restores from off in restoring state', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-step-restore',
            name: 'Water heater',
            controlModel: 'stepped_load',
            currentState: 'off',
            plannedState: 'keep',
            selectedStepId: 'off',
            desiredStepId: 'low',
            targetStepId: 'low',
            planningPowerKw: 1.25,
            measuredPowerKw: 0,
            controllable: true,
          },
        ],
      });
  
      expect(getPowerText()).toBeUndefined();
      expect(getStateText()).toBe('Restoring');
      expect(getUsageText()).toBe('Measured: 0.00 kW / Expected: 1.25 kW (target: low)');
      expect(getBadgeClassList('dev-step-restore')?.contains('neutral')).toBe(true);
    });
  
    it('shows the shed target step for stepped-load devices', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-step-shed',
            name: 'Water heater',
            controlModel: 'stepped_load',
            currentState: 'on',
            plannedState: 'shed',
            selectedStepId: 'max',
            desiredStepId: 'low',
            planningPowerKw: 1.25,
            measuredPowerKw: 1.1,
            controllable: true,
            shedAction: 'set_step',
          },
        ],
      });
  
      expect(getPowerText()).toBeUndefined();
      expect(getStateText()).toBe('Shed to low');
      expect(getUsageText()).toBe('Measured: 1.10 kW / Expected: 1.25 kW (target: low)');
      expect(getBadgeClassList('dev-step-shed')?.contains('expensive')).toBe(true);
    });
  
    it('renders inactive EV state without a fake restore power transition', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-ev-inactive',
            name: 'EV Charger',
            controlCapabilityId: 'evcharger_charging',
            evChargingState: 'plugged_out',
            currentState: 'off',
            plannedState: 'inactive',
            controllable: true,
            reason: 'inactive (charger is unplugged)',
          },
        ],
      });
  
      expect(getStateText()).toBe('Inactive (car unplugged)');
      expect(getPowerText()).toBe('off');
      expect(getStatusText()).toBe('inactive (charger is unplugged)');
      expect(getBadgeClassList('dev-ev-inactive')?.contains('neutral')).toBe(true);
    });
  
    it('renders a paused keep-state EV charger as inactive rather than active', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-ev-paused',
            name: 'EV Charger',
            controlCapabilityId: 'evcharger_charging',
            evChargingState: 'plugged_in_paused',
            currentState: 'off',
            plannedState: 'keep',
            measuredPowerKw: 0,
            expectedPowerKw: 0,
            controllable: true,
            reason: 'keep',
          },
        ],
      });
  
      expect(getStateText()).toBe('Inactive (car not charging)');
      expect(getPowerText()).toBe('off');
      expect(getStatusText()).toBe('keep');
      expect(getBadgeClassList('dev-ev-paused')?.contains('neutral')).toBe(true);
    });
  
    it('renders a shed EV charger as charging paused', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-ev-shed',
            name: 'EV Charger',
            controlCapabilityId: 'evcharger_charging',
            evChargingState: 'plugged_in_paused',
            currentState: 'off',
            plannedState: 'shed',
            measuredPowerKw: 0,
            expectedPowerKw: 1.38,
            controllable: true,
            reason: 'shed due to capacity',
          },
        ],
      });
  
      expect(getStateText()).toBe('Shed (charging paused)');
      expect(getPowerText()).toBe('off');
      expect(getStatusText()).toBe('shed due to capacity');
      expect(getBadgeClassList('dev-ev-shed')?.contains('expensive')).toBe(true);
    });
  
    it('renders a charging keep-state EV charger as active charging', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-ev-charging',
            name: 'EV Charger',
            controlCapabilityId: 'evcharger_charging',
            evChargingState: 'plugged_in_charging',
            currentState: 'on',
            plannedState: 'keep',
            measuredPowerKw: 7.2,
            expectedPowerKw: 7.2,
            controllable: true,
            reason: 'keep',
          },
        ],
      });
  
      expect(getStateText()).toBe('Active (charging)');
      expect(getPowerText()).toBe('on');
      expect(getStatusText()).toBe('keep');
      expect(getBadgeClassList('dev-ev-charging')?.contains('cheap')).toBe(true);
    });
  
    it('renders meter settling as restoring when an off keep device is waiting to restore', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-restore-off',
            name: 'Recently restored heater',
            currentState: 'off',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (40s remaining)',
          },
        ],
      });
  
      expect(getStateText()).toBe('Restoring');
      expect(getStatusText()).toBe('waiting for meter to settle (40s remaining)');
      expect(getBadgeClassList('dev-restore-off')?.contains('neutral')).toBe(true);
    });
  
    it('renders meter settling copy on keep devices without forcing a shed badge', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-restore-on',
            name: 'Recently restored heater',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'meter settling (40s remaining)',
          },
        ],
      });
  
      expect(getStateText()).toBe('Active');
      expect(getStatusText()).toBe('waiting for meter to settle (40s remaining)');
      expect(getBadgeClassList('dev-restore-on')?.contains('cheap')).toBe(true);
    });
  
    it('does not pair an active badge with stabilizing status text for shed devices', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-restore-on',
            name: 'Recently restored heater',
            currentState: 'on',
            plannedState: 'shed',
            controllable: true,
            reason: 'cooldown (restore, 40s remaining)',
          },
        ],
      });
  
      expect(getStatusText()).not.toMatch(/stabilizing after/);
      expect(getBadgeClassList('dev-restore-on')?.contains('cheap')).toBe(false);
    });
  
    it('renders legacy restore cooldown copy on keep devices', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-restore-legacy',
            name: 'Recently restored heater',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            reason: 'cooldown (restore, 40s remaining)',
          },
        ],
      });
  
      expect(getStateText()).toBe('Active');
      expect(getStatusText()).toBe('cooldown (restore, 40s remaining)');
      expect(getBadgeClassList('dev-restore-legacy')?.contains('cheap')).toBe(true);
    });
  
    it('shows restore requested when binary command is pending and device is off', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-pending',
            name: 'Pending restore device',
            currentState: 'off',
            plannedState: 'keep',
            controllable: true,
            binaryCommandPending: true,
          },
        ],
      });
  
      expect(getStateText()).toBe('Restore requested');
      expect(getBadgeClassList('dev-pending')?.contains('neutral')).toBe(true);
    });
  
    it('shows active when binary command is pending but device is already on', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-confirmed',
            name: 'Confirmed restore device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
            binaryCommandPending: true,
          },
        ],
      });
  
      expect(getStateText()).toBe('Active');
      expect(getBadgeClassList('dev-confirmed')?.contains('cheap')).toBe(true);
    });
  
    it('shows active when binary command is pending for a temperature-managed device with not_applicable state', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-temp-pending',
            name: 'Pending Temp Device',
            currentState: 'not_applicable',
            plannedState: 'keep',
            controllable: true,
            binaryCommandPending: true,
          },
        ],
      });
  
      expect(getStateText()).toBe('Active (temperature-managed)');
      expect(getBadgeClassList('dev-temp-pending')?.contains('cheap')).toBe(true);
    });
  
    it('renders temperature-managed state without a misleading power row for devices without onoff power state', async () => {
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-temp-only',
            name: 'Temp-only device',
            currentState: 'not_applicable',
            plannedState: 'keep',
            controllable: true,
          },
        ],
      });
  
      expect(getStateText()).toBe('Active (temperature-managed)');
      expect(getPowerText()).toBeUndefined();
      expect(getBadgeClassList('dev-temp-only')?.contains('cheap')).toBe(true);
    });
  
  });
  
  describe('plan meta budget display', () => {
    it('shows daily budget allocation when limited by daily budget', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 3.6,
          softLimitKw: 3.8,
          headroomKw: 0.2,
          usedKWh: 4.57,
          budgetKWh: 9.5, // hourly capacity budget
          dailyBudgetHourKWh: 5.21, // daily allocation for this hour
          softLimitSource: 'daily',
          minutesRemaining: 5,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      // Should show daily budget allocation (5.21), not hourly capacity (9.5)
      expect(metaLines.some((line) => line?.includes('Used 4.57 of 5.2'))).toBe(true);
      expect(metaLines.some((line) => line?.includes('of 9.5'))).toBe(false);
    });
  
    it('shows hourly capacity budget when limited by capacity', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.0,
          softLimitKw: 8.0,
          headroomKw: 3.0,
          usedKWh: 3.5,
          budgetKWh: 9.5, // hourly capacity budget
          dailyBudgetHourKWh: 12.0, // daily allocation is higher
          softLimitSource: 'capacity',
          minutesRemaining: 30,
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      // Should show hourly capacity (9.5), not daily allocation (12.0)
      expect(metaLines.some((line) => line?.includes('Used 3.50 of 9.5'))).toBe(true);
    });
  
    it('shows hourly capacity budget when no daily budget is active', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.0,
          softLimitKw: 8.0,
          headroomKw: 3.0,
          usedKWh: 3.5,
          budgetKWh: 9.5,
          // no dailyBudgetHourKWh or softLimitSource
        },
        devices: [],
      });
  
      const metaLines = getPlanMetaText();
      expect(metaLines.some((line) => line?.includes('Used 3.50 of 9.5'))).toBe(true);
    });
  });
  
  describe('plan row interactions', () => {
    it('opens device detail when clicking a device in the overview plan', async () => {
      const openListener = vi.fn();
      document.addEventListener('open-device-detail', openListener as EventListener, { once: true });
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-overview-1',
            name: 'Overview Device',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
          },
        ],
      });
  
      const row = document.querySelector('[data-device-id="dev-overview-1"]') as HTMLElement | null;
      if (!row) {
        throw new Error('Expected overview plan row to exist.');
      }
  
      expect(row.getAttribute('role')).toBe('button');
      expect(row.getAttribute('aria-label')).toBe('Open device details for Overview Device');
      expect(row.tabIndex).toBe(0);
      expect(row.classList.contains('device-row')).toBe(true);
      expect(row.classList.contains('clickable')).toBe(true);
  
      row.click();
  
      expect(openListener).toHaveBeenCalledTimes(1);
      const [event] = openListener.mock.calls[0] as [CustomEvent<{ deviceId: string }>];
      expect(event.detail).toEqual({ deviceId: 'dev-overview-1' });
    });
  
    it('opens device detail from keyboard activation on the overview row', async () => {
      const openListener = vi.fn();
      document.addEventListener('open-device-detail', openListener as EventListener, { once: true });
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-overview-2',
            name: 'Overview Device Keyboard',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
          },
        ],
      });
  
      const row = document.querySelector('[data-device-id="dev-overview-2"]') as HTMLElement | null;
      if (!row) {
        throw new Error('Expected keyboard overview plan row to exist.');
      }
  
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  
      expect(openListener).toHaveBeenCalledTimes(1);
      const [event] = openListener.mock.calls[0] as [CustomEvent<{ deviceId: string }>];
      expect(event.detail).toEqual({ deviceId: 'dev-overview-2' });
    });
  
    it('opens device detail on Space key release, matching button semantics', async () => {
      const openListener = vi.fn();
      document.addEventListener('open-device-detail', openListener as EventListener, { once: true });
  
      await renderPlanSnapshot({
        devices: [
          {
            id: 'dev-overview-3',
            name: 'Overview Device Space',
            currentState: 'on',
            plannedState: 'keep',
            controllable: true,
          },
        ],
      });
  
      const row = document.querySelector('[data-device-id="dev-overview-3"]') as HTMLElement | null;
      if (!row) {
        throw new Error('Expected space-key overview plan row to exist.');
      }
  
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(openListener).not.toHaveBeenCalled();
  
      row.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
  
      expect(openListener).toHaveBeenCalledTimes(1);
      const [event] = openListener.mock.calls[0] as [CustomEvent<{ deviceId: string }>];
      expect(event.detail).toEqual({ deviceId: 'dev-overview-3' });
    });
  });
});

describe('Redesign plan UI', () => {
  
  const setupPlanDom = () => {
    document.body.innerHTML = `
      <section id="overview-panel">
        <div id="plan-hero"></div>
        <div id="plan-hour-strip"></div>
        <div id="plan-cards"></div>
        <div id="plan-empty"></div>
      </section>
    `;
  };
  
  const DEFAULT_REASON = { code: 'status_ok', message: '' };
  
  const normalizePlanSnapshot = (plan: unknown): unknown => {
    if (!plan || typeof plan !== 'object') return plan;
    const snapshot = plan as { devices?: Array<Record<string, unknown>> };
    if (!Array.isArray(snapshot.devices)) return plan;
    return {
      ...snapshot,
      devices: snapshot.devices.map((device) => {
        if (typeof device.reason === 'string') {
          return { ...device, reason: buildComparablePlanReason(device.reason) };
        }
        if (device.reason && typeof device.reason === 'object') return device;
        return { ...device, reason: DEFAULT_REASON };
      }),
    };
  };
  
  const renderPlanSnapshot = async (plan: unknown) => {
    vi.resetModules();
    setupPlanDom();
    const { renderPlan, setOverviewRedesignEnabled } = await import('../src/ui/plan.ts');
    setOverviewRedesignEnabled(true);
    renderPlan(normalizePlanSnapshot(plan) as Parameters<typeof renderPlan>[0]);
  };
  
  const getFirstPlanCard = (): HTMLElement | null => (
    document.querySelector('[data-device-id]') as HTMLElement | null
  );
  
  const getReasonText = (deviceId: string): string | undefined => (
    (document.querySelector(`[data-device-id="${deviceId}"] .plan-card__reason`) as HTMLElement | null)
      ?.textContent
      ?.trim()
  );
  
  const getMetricText = (deviceId: string): string | undefined => (
    (document.querySelector(`[data-device-id="${deviceId}"] .plan-card__metric-label`) as HTMLElement | null)
      ?.textContent
      ?.trim()
  );
  
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    delete (document as Document & { hidden?: boolean }).hidden;
  });
  
  describe('Overview plan UI', () => {
    it('renders the hero, hour strip, and priority-sorted cards', async () => {
      await renderPlanSnapshot({
        meta: {
          totalKw: 5.2,
          softLimitKw: 11,
          headroomKw: 5.8,
          hardCapLimitKw: 14,
          hardCapHeadroomKw: 3,
          controlledKw: 3.1,
          uncontrolledKw: 2.1,
          powerFreshnessState: 'fresh',
          usedKWh: 4.2,
          budgetKWh: 12,
          softLimitSource: 'capacity',
          minutesRemaining: 8,
        },
        devices: [
          { id: 'dev-2', name: 'Second', priority: 2, currentState: 'on', plannedState: 'keep' },
          { id: 'dev-1', name: 'First', priority: 1, currentState: 'off', plannedState: 'shed' },
        ],
      });
  
      expect((document.querySelector('.plan-hero__value') as HTMLElement | null)?.textContent?.trim()).toBe('5.2 kW');
      expect((document.querySelector('.plan-hero__limit') as HTMLElement | null)?.textContent?.trim())
        .toBe('of 11.0 kW limit');
      expect((document.querySelector('.plan-hero__message') as HTMLElement | null)?.textContent?.trim())
        .toBe('5.8 kW to spare');
      expect((document.querySelector('#plan-hero .plan-chip') as HTMLElement | null)?.textContent?.trim()).toBe('Live');
      expect((document.querySelector('.plan-hour-strip__primary') as HTMLElement | null)?.textContent?.trim())
        .toBe('4.20 of 12.0 kWh');
      expect((document.querySelector('.plan-hour-strip__secondary') as HTMLElement | null)?.textContent?.trim())
        .toBe('Keeping under the power limit');
  
      const deviceNames = Array.from(document.querySelectorAll('.plan-card__title'))
        .map((el) => el.textContent?.trim());
      expect(deviceNames).toEqual(['First', 'Second']);
    });
  
    it('renders three-row cards with state chip, load bar, and real reason text', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [
          {
            id: 'dev-heat',
            name: 'Living Room Heat Pump',
            currentState: 'on',
            plannedState: 'keep',
            expectedPowerKw: 1.6,
            measuredPowerKw: 1.2,
            reason: {
              code: 'restore_need',
              fromTarget: '21°',
              toTarget: '22°',
              needKw: 0.4,
              headroomKw: 2.1,
            },
            stateKind: 'active',
            stateTone: 'active',
          },
        ],
      });
  
      const card = getFirstPlanCard();
      expect(
        card?.querySelectorAll(':scope > *:not(md-elevation):not(md-ripple)'),
      ).toHaveLength(3);
      expect((card?.querySelector('.plan-state-chip') as HTMLElement | null)?.textContent?.trim()).toBe('Running');
      expect(getMetricText('dev-heat')).toBe('1.2 kW');
      expect(getReasonText('dev-heat')).toBe('Raising target 21° to 22°');
      expect(card?.querySelector('.plan-card__metric--power')).toBeTruthy();
    });
  
    it('prefers structured state presentation from the snapshot payload', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [
          {
            id: 'dev-held',
            name: 'Water Heater',
            currentState: 'off',
            plannedState: 'shed',
            stateKind: 'held',
            stateTone: 'held',
          },
        ],
      });
  
      const chip = document.querySelector('[data-device-id="dev-held"] .plan-state-chip') as HTMLElement | null;
      expect(chip?.textContent?.trim()).toBe('Limited');
      expect(chip?.className).toContain('plan-state-chip--held');
    });
  
    it('surfaces starvation badges and overrides the reason line for capacity starvation', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 4.2, softLimitKw: 5, headroomKw: 0.8 },
        devices: [
          {
            id: 'dev-starved',
            name: 'Bathroom Floor',
            currentState: 'off',
            plannedState: 'shed',
            starvation: {
              isStarved: true,
              accumulatedMs: 23 * 60 * 1000,
              cause: 'capacity',
              startedAtMs: Date.UTC(2026, 3, 20, 11, 0, 0),
            },
          },
        ],
      });
  
      const badgeTexts = Array.from(document.querySelectorAll('[data-device-id="dev-starved"] .plan-chip'))
        .map((el) => el.textContent?.trim());
      expect(badgeTexts).toContain('Starved 23m');
      expect(getReasonText('dev-starved')).toBe('Waiting for room to reopen — 23 min below target');
      expect((document.querySelector('#plan-hero .plan-chip--muted') as HTMLElement | null)?.textContent?.trim())
        .toBe('1 device below target');
    });
  
    it('updates countdown-based reasons during live ticks', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));
      await renderPlanSnapshot({
        generatedAtMs: Date.now(),
        meta: {
          totalKw: 2.2,
          softLimitKw: 6,
          headroomKw: 3.8,
          lastPowerUpdateMs: Date.now(),
        },
        devices: [
          {
            id: 'dev-cooldown',
            name: 'EV Charger',
            currentState: 'off',
            plannedState: 'keep',
            reason: { code: 'meter_settling', remainingSec: 10 },
          },
        ],
      });
  
      const timer = document.querySelector(
        '[data-device-id="dev-cooldown"] .plan-state-chip__timer',
      ) as (HTMLElement & { value?: number }) | null;
      expect(timer?.hidden).toBe(false);
      expect(timer?.value).toBeCloseTo(1, 2);

      vi.advanceTimersByTime(4_000);
      await Promise.resolve();

      expect(timer?.value).toBeCloseTo(0.6, 2);
    });

    it('hides expired cooldown timers and hero cooldown chips on initial render', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:02Z'));

      await renderPlanSnapshot({
        generatedAtMs: Date.parse('2026-04-20T12:00:00Z'),
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [
          {
            id: 'dev-expired-cooldown',
            name: 'EV Charger',
            currentState: 'on',
            plannedState: 'keep',
            reason: { code: 'cooldown_restore', remainingSec: 1 },
          },
        ],
      });

      const timer = document.querySelector(
        '[data-device-id="dev-expired-cooldown"] .plan-state-chip__timer',
      ) as HTMLElement | null;
      const heroChips = Array.from(document.querySelectorAll('#plan-hero .plan-chip'))
        .map((el) => el.textContent?.trim());

      expect(timer?.hidden).toBe(true);
      expect(heroChips).not.toContain('1 cooling down');
      expect(getReasonText('dev-expired-cooldown')).toBe('');
    });

    it('clears live-expiring cooldown UI across the card and hero', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:00Z'));

      await renderPlanSnapshot({
        generatedAtMs: Date.now(),
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [
          {
            id: 'dev-live-cooldown',
            name: 'EV Charger',
            currentState: 'on',
            plannedState: 'keep',
            reason: { code: 'cooldown_restore', remainingSec: 2 },
          },
        ],
      });

      const timer = document.querySelector(
        '[data-device-id="dev-live-cooldown"] .plan-state-chip__timer',
      ) as (HTMLElement & { value?: number }) | null;
      expect(timer?.hidden).toBe(false);
      expect(getReasonText('dev-live-cooldown')).toBe('Waiting before switching again (2s)');
      expect(Array.from(document.querySelectorAll('#plan-hero .plan-chip'))
        .map((el) => el.textContent?.trim())).toContain('1 cooling down');

      await vi.advanceTimersByTimeAsync(2_000);

      expect(timer?.hidden).toBe(true);
      expect(getReasonText('dev-live-cooldown')).toBe('');
      expect(Array.from(document.querySelectorAll('#plan-hero .plan-chip'))
        .map((el) => el.textContent?.trim())).not.toContain('1 cooling down');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps expired cooldown display consistent for non-keep plan states', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:02Z'));

      await renderPlanSnapshot({
        generatedAtMs: Date.parse('2026-04-20T12:00:00Z'),
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [
          {
            id: 'dev-shed-expired-cooldown',
            name: 'Water Heater',
            currentState: 'off',
            plannedState: 'shed',
            stateKind: 'held',
            stateTone: 'held',
            reason: { code: 'cooldown_shedding', remainingSec: 1 },
          },
        ],
      });

      const timer = document.querySelector(
        '[data-device-id="dev-shed-expired-cooldown"] .plan-state-chip__timer',
      ) as HTMLElement | null;
      const chip = document.querySelector(
        '[data-device-id="dev-shed-expired-cooldown"] .plan-state-chip',
      ) as HTMLElement | null;

      expect(chip?.textContent?.trim()).toBe('Limited');
      expect(timer?.hidden).toBe(true);
      expect(getReasonText('dev-shed-expired-cooldown')).toBe('Reducing load now');
      expect(getReasonText('dev-shed-expired-cooldown')).not.toMatch(/0s|cooldown|switching/);
    });

    it('preserves expired activation-backoff semantics for shed devices', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-20T12:00:02Z'));

      await renderPlanSnapshot({
        generatedAtMs: Date.parse('2026-04-20T12:00:00Z'),
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [
          {
            id: 'dev-shed-expired-backoff',
            name: 'Water Heater',
            currentState: 'off',
            plannedState: 'shed',
            stateKind: 'held',
            stateTone: 'held',
            reason: { code: 'activation_backoff', remainingSec: 1 },
          },
        ],
      });

      const timer = document.querySelector(
        '[data-device-id="dev-shed-expired-backoff"] .plan-state-chip__timer',
      ) as HTMLElement | null;

      expect(timer?.hidden).toBe(true);
      expect(getReasonText('dev-shed-expired-backoff')).toBe('Waiting before turning more devices on');
      expect(getReasonText('dev-shed-expired-backoff')).not.toMatch(/0s|capacity|switching/);
    });

    it('does not count up absolute countdown metadata under client clock skew', async () => {
      const { resolveDisplayPlanDeviceSnapshot } = await import('../src/ui/planLiveData.ts');
      const generatedAtMs = Date.parse('2026-04-20T12:00:00Z');
      const device = {
        id: 'dev-skewed-countdown',
        plannedState: 'keep',
        reason: {
          code: 'cooldown_restore',
          remainingSec: 45,
          countdownStartedAtMs: generatedAtMs,
          countdownTotalSec: 60,
        },
      } as const;
      const displayDevice = resolveDisplayPlanDeviceSnapshot(
        { generatedAtMs, devices: [device] },
        device,
        generatedAtMs,
        generatedAtMs - 5_000,
      );

      expect(displayDevice.reason).toEqual(device.reason);
      expect(displayDevice.displayCountdownTotalSec).toBe(60);
    });
  
    it('adds dim and dashed treatments from the structured state kind', async () => {
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [
          { id: 'idle', name: 'Idle device', currentState: 'off', plannedState: 'inactive', stateKind: 'idle' },
          { id: 'missing', name: 'Missing device', currentState: 'unknown', plannedState: 'keep', stateKind: 'unavailable' },
        ],
      });
  
      expect(document.querySelector('[data-device-id="idle"]')?.className).toContain('plan-card--dim');
      expect(document.querySelector('[data-device-id="missing"]')?.className).toContain('plan-card--unavailable');
    });
  
    it('opens device details on click and keyboard activation', async () => {
      const detailEvents: string[] = [];
      document.addEventListener('open-device-detail', ((event: Event) => {
        detailEvents.push((event as CustomEvent<{ deviceId: string }>).detail.deviceId);
      }) as EventListener);
  
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [{ id: 'dev-open', name: 'Overview Device', currentState: 'on', plannedState: 'keep' }],
      });
  
      const row = document.querySelector('[data-device-id="dev-open"]') as HTMLElement;
      row.click();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      row.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
  
      expect(detailEvents).toEqual(['dev-open', 'dev-open', 'dev-open']);
      expect(row.getAttribute('aria-label')).toBe('Open device details for Overview Device');
    });
  
    it('shows empty states for missing plans and missing devices', async () => {
      await renderPlanSnapshot(null);
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No plan available yet');
  
      await renderPlanSnapshot({
        meta: { totalKw: 0, softLimitKw: 5, headroomKw: 5 },
        devices: [],
      });
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No managed devices');
    });

    it('clears previously rendered cards when the plan later becomes unavailable', async () => {
      vi.resetModules();
      setupPlanDom();
      const { renderPlan, setOverviewRedesignEnabled } = await import('../src/ui/plan.ts');
      setOverviewRedesignEnabled(true);

      renderPlan(normalizePlanSnapshot({
        meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
        devices: [{ id: 'dev-clear', name: 'Device to clear', currentState: 'on', plannedState: 'keep' }],
      }) as Parameters<typeof renderPlan>[0]);

      expect(document.querySelector('[data-device-id="dev-clear"]')).not.toBeNull();

      renderPlan(null);

      expect(document.querySelector('[data-device-id="dev-clear"]')).toBeNull();
      expect((document.querySelector('#plan-empty') as HTMLElement | null)?.textContent)
        .toContain('No plan available yet');
    });

    it('refreshes the plan when the power endpoint fails', async () => {
      vi.resetModules();
      setupPlanDom();
      const homey = installHomeyMock({
        uiState: {
          plan: normalizePlanSnapshot({
            meta: { totalKw: 2.2, softLimitKw: 6, headroomKw: 3.8 },
            devices: [{ id: 'dev-refresh', name: 'Refreshed device', currentState: 'on', plannedState: 'keep' }],
          }),
        },
        apiHandlers: {
          [`GET ${SETTINGS_UI_POWER_PATH}`]: async () => {
            throw new Error('power unavailable');
          },
        },
      });
      const { setHomeyClient } = await import('../src/ui/homey.ts');
      const { refreshPlan, setOverviewRedesignEnabled } = await import('../src/ui/plan.ts');
      setHomeyClient(homey);
      setOverviewRedesignEnabled(true);

      await refreshPlan();

      expect(document.querySelector('[data-device-id="dev-refresh"]')).not.toBeNull();
      expect((document.querySelector('.plan-card__title') as HTMLElement | null)?.textContent?.trim())
        .toBe('Refreshed device');
    });

    it('uses plan freshness when a cached power status is stale and the power endpoint fails', async () => {
      vi.resetModules();
      setupPlanDom();
      const homey = installHomeyMock({
        uiState: {
          plan: normalizePlanSnapshot({
            meta: {
              totalKw: 2.2,
              softLimitKw: 6,
              headroomKw: 3.8,
              powerFreshnessState: 'stale_fail_closed',
            },
            devices: [],
          }),
        },
        apiHandlers: {
          [`GET ${SETTINGS_UI_POWER_PATH}`]: async () => {
            throw new Error('power unavailable');
          },
        },
      });
      const { setHomeyClient } = await import('../src/ui/homey.ts');
      const {
        refreshPlan,
        setOverviewRedesignEnabled,
        updatePlanPower,
      } = await import('../src/ui/plan.ts');
      setHomeyClient(homey);
      setOverviewRedesignEnabled(true);
      updatePlanPower({ powerFreshnessState: 'fresh' });

      await refreshPlan();

      expect((document.querySelector('#plan-hero .plan-chip') as HTMLElement | null)?.textContent?.trim())
        .toBe('No data');
    });
  });
});
