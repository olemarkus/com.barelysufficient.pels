const setupPlanDom = () => {
  document.body.innerHTML = `
    <div id="plan-list"></div>
    <div id="plan-empty"></div>
    <div id="plan-meta"></div>
  `;
};

const renderPlanSnapshot = async (plan: unknown) => {
  vi.resetModules();
  setupPlanDom();
  const { renderPlan } = await import('../src/ui/plan.ts');
  renderPlan(plan as Parameters<typeof renderPlan>[0]);
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
    expect(metaLines.some((line) => line === 'Hard cap breached by 1.2kW')).toBe(true);
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
    expect(metaLines.some((line) => line.startsWith('Hard cap breached'))).toBe(false);
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
    expect(metaLines.some((line) => line === '0.8kW before hard cap')).toBe(true);
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
    expect(metaLines.some((line) => line === 'Hard cap breached by 2.6kW')).toBe(true);
    expect(metaLines.some((line) => line === 'Shortfall threshold 4.8kW (hourly budget-derived)')).toBe(true);
    expect(metaLines.some((line) => line === '2.6kW over soft limit')).toBe(false);
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

  it('shows stepped-load restore state and step transition in the overview row', async () => {
    await renderPlanSnapshot({
      devices: [
        {
          id: 'dev-step-restore',
          name: 'Water heater',
          controlModel: 'stepped_load',
          currentState: 'on',
          plannedState: 'keep',
          selectedStepId: 'low',
          desiredStepId: 'max',
          planningPowerKw: 3,
          measuredPowerKw: 0.6,
          controllable: true,
        },
      ],
    });

    expect(getPowerText()).toBeUndefined();
    expect(getStateText()).toBe('Restoring');
    expect(getUsageText()).toBe('Measured: 0.60 kW / Expected: 3.00 kW (target: max)');
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
          currentState: 'off',
          plannedState: 'inactive',
          controllable: true,
          reason: 'inactive (charger is unplugged)',
        },
      ],
    });

    expect(getStateText()).toBe('Inactive');
    expect(getPowerText()).toBe('off');
    expect(getStatusText()).toBe('inactive (charger is unplugged)');
    expect(getBadgeClassList('dev-ev-inactive')?.contains('neutral')).toBe(true);
  });

  it('renders restore cooldown as restoring when the device is currently off', async () => {
    await renderPlanSnapshot({
      devices: [
        {
          id: 'dev-restore-off',
          name: 'Recently restored heater',
          currentState: 'off',
          plannedState: 'shed',
          controllable: true,
          reason: 'cooldown (restore, 40s remaining)',
        },
      ],
    });

    expect(getStateText()).toBe('Shed (restore cooldown)');
    expect(getStatusText()).toBe('cooldown (restore, 40s remaining)');
    expect(getBadgeClassList('dev-restore-off')?.contains('neutral')).toBe(true);
  });

  it('renders restore cooldown as active when the device is already back on', async () => {
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

    expect(getStateText()).toBe('Active');
    expect(getStatusText()).toBe('stabilizing after restore (40s remaining)');
    expect(getBadgeClassList('dev-restore-on')?.contains('cheap')).toBe(true);
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

  it('renders headroom cooldown status text without changing the active state UI', async () => {
    await renderPlanSnapshot({
      devices: [
        {
          id: 'dev-1',
          name: 'EV Charger',
          currentState: 'on',
          plannedState: 'keep',
          controllable: true,
          reason: 'headroom cooldown (45s remaining; usage 6.00 -> 3.50kW)',
        },
      ],
    });

    expect(getStateText()).toBe('Active');
    expect(getStatusText()).toBe('stabilizing after recent step-down (45s remaining; usage 6.00 -> 3.50kW)');
    expect(getBadgeClassList('dev-1')?.contains('cheap')).toBe(true);
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
