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
  it('shows expected only when measured matches expected', () => {
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

    expect(getUsageText()).toBe('expected 1.23 kW');
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
    expect(metaLines.some((line) => line === 'Controlled 2.00kW / Uncontrolled 1.50kW')).toBe(true);
  });
});
