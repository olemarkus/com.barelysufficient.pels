const setupPlanDom = () => {
  document.body.innerHTML = `
    <div id="plan-list"></div>
    <div id="plan-empty"></div>
    <div id="plan-meta"></div>
  `;
};

const renderPlanSnapshot = (plan: unknown) => {
  jest.resetModules();
  setupPlanDom();
  const { renderPlan } = require('../settings/src/ui/plan') as typeof import('../settings/src/ui/plan');
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

const getPowerText = () => {
  const lines = Array.from(document.querySelectorAll('.plan-meta-line'));
  const powerLine = lines.find((line) => line.querySelector('.plan-label')?.textContent === 'Power');
  return powerLine?.querySelector('span:last-child')?.textContent?.trim();
};

const getBadgeClassList = (deviceId: string): DOMTokenList | null => {
  const dot = document.querySelector(`[data-device-id="${deviceId}"] .plan-state-indicator`) as HTMLElement | null;
  if (!dot) return null;
  return dot.classList;
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
  it('shows current usage and expected when measured matches expected', () => {
    renderPlanSnapshot({
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

    expect(getUsageText()).toBe('current usage: 1.23 kW / expected 1.23 kW');
  });

  it('shows current usage and expected when values differ', () => {
    renderPlanSnapshot({
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

    expect(getUsageText()).toBe('current usage: 0.00 kW / expected 1.20 kW');
  });

  it('shows current usage 0 when measured is zero and expected is positive', () => {
    renderPlanSnapshot({
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

    expect(getUsageText()).toBe('current usage: 0.00 kW / expected 1.00 kW');
  });
});

describe('plan meta usage summary', () => {
  it('shows controlled and uncontrolled usage when total is known', () => {
    renderPlanSnapshot({
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

  it('shows meta lines even when no devices are managed', () => {
    renderPlanSnapshot({
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
});

describe('plan device state', () => {
  it('shows capacity control off state for non-controllable devices', () => {
    renderPlanSnapshot({
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

  it('renders badge color classes per device plan state', () => {
    renderPlanSnapshot({
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
    expect(getBadgeClassList('dev-uncontrolled')?.contains('neutral')).toBe(true);
    expect(getBadgeClassList('dev-on-uncontrolled')?.contains('neutral')).toBe(true);
    expect(getBadgeClassList('dev-off-controllable')?.contains('neutral')).toBe(true);
  });

  it('renders temperature-managed state for devices without onoff power state', () => {
    renderPlanSnapshot({
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
    expect(getPowerText()).toBe('N/A');
    expect(getBadgeClassList('dev-temp-only')?.contains('cheap')).toBe(true);
  });
});

describe('plan meta budget display', () => {
  it('shows daily budget allocation when limited by daily budget', () => {
    renderPlanSnapshot({
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

  it('shows hourly capacity budget when limited by capacity', () => {
    renderPlanSnapshot({
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

  it('shows hourly capacity budget when no daily budget is active', () => {
    renderPlanSnapshot({
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
