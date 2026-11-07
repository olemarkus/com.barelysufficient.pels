import {
  formatSetupProgress,
  isSetupStepOpen,
  resolveSetupPath,
  resolveSetupSteps,
  type SetupPathFacts,
} from '../src/ui/setupPathModel.ts';

const NEVER = {
  state: 'never' as const,
  remedy: 'No power readings yet. Pick a whole-home meter under Limits & safety, or set up a Flow '
    + 'with the Report power usage action.',
};

// A brand-new install: no reading ever received, the built-in 10 kW running,
// nothing managed, simulation on (the boot defaults).
const freshInstall: SetupPathFacts = {
  power: NEVER,
  hardCap: { state: 'unset', runningLimitKw: 10, periodMinutes: 60 },
  actionableDeviceCount: 0,
  limitableDeviceCount: 0,
  simulating: true,
  market: { state: 'unavailable' },
  prices: { state: 'unused' },
};

// Everything the path asks for, with simulation still on: a cautious owner who
// has finished setting up and is watching before going live.
const configuredAndSimulating: SetupPathFacts = {
  power: { state: 'received' },
  hardCap: { state: 'saved', limitKw: 8, marginKw: 0.4, periodMinutes: 60 },
  actionableDeviceCount: 3,
  limitableDeviceCount: 1,
  simulating: true,
  market: { state: 'unavailable' },
  prices: { state: 'unused' },
};

// An owner who manages thermostats for their price response and nothing else:
// readings arriving, devices managed, none PELS may limit, no hard cap saved.
const priceOnlyOwner: SetupPathFacts = {
  power: { state: 'received' },
  hardCap: { state: 'unset', runningLimitKw: 10, periodMinutes: 60 },
  actionableDeviceCount: 2,
  limitableDeviceCount: 0,
  simulating: false,
  market: { state: 'unavailable' },
  prices: { state: 'unused' },
};

const statuses = (facts: SetupPathFacts) => (
  pathOf(facts)?.steps.map((step) => `${step.id}:${step.status}`)
);

const detailOf = (facts: SetupPathFacts, id: 'power' | 'hardCap' | 'devices' | 'priority') => (
  pathOf(facts)?.steps.find((step) => step.id === id)?.detail
);

const pathOf = (facts: SetupPathFacts) => {
  const resolved = resolveSetupPath(facts);
  return resolved.state === 'open' ? resolved.path : undefined;
};

describe('setup path', () => {

  it('completes Limits with grid control or an explicit choice to turn both off', () => {
    const configured = { ...freshInstall, power: { state: 'received' as const }, actionableDeviceCount: 1, limitableDeviceCount: 1 };
    expect(resolveSetupPath({ ...configured, hardCap: { state: 'grid', limitKw: 3.3, capacity: { state: 'off' } } })).toEqual({ state: 'complete' });
    expect(resolveSetupPath({ ...configured, hardCap: { state: 'disabled' } })).toEqual({ state: 'complete' });
  });
  it('shows all four stages before device choices make limits and prices applicable', () => {
    // Later stages keep their place while the owner chooses devices.
    expect(statuses(freshInstall)).toEqual(['power:next', 'devices:later', 'hardCap:later', 'prices:later']);
    const path = pathOf(freshInstall);
    expect(path && formatSetupProgress(path)).toBe('0 of 4');
  });

  describe('a stage only asks for settings that apply', () => {
    it('completes the limits stage for an owner PELS may not limit anything for', () => {
      // Asking them to set a capacity cap would be asking for something that
      // never touches their home. Their setup is complete.
      expect(resolveSetupPath(priceOnlyOwner)).toEqual({ state: 'complete' });
    });

    it('never keeps the path open over an unsaved cap that is not in force', () => {
      expect(statuses({ ...priceOnlyOwner, power: NEVER })).toEqual(['power:next', 'devices:done', 'hardCap:done', 'prices:done']);
    });

    it('shows the hard cap once a device may be limited, naming the number it is running on', () => {
      // Now the cap IS in force, tariff or no tariff: every home runs one, and
      // this device will be held to 10 kW until the owner says otherwise.
      const facts = { ...priceOnlyOwner, limitableDeviceCount: 1 };
      expect(statuses(facts)).toEqual(['power:done', 'devices:done', 'hardCap:next', 'prices:done']);
      expect(detailOf(facts, 'hardCap')).toContain('10 kW hard cap (hourly average) until you set yours');
    });

    it('puts Devices before Hard cap: what may be limited, then to what', () => {
      const path = pathOf({ ...freshInstall, actionableDeviceCount: 1, limitableDeviceCount: 1 });
      expect(path?.steps.map((step) => step.id)).toEqual(['power', 'devices', 'hardCap', 'prices']);
      expect(path && formatSetupProgress(path)).toBe('2 of 4');
    });
  });

  it('says the no-readings banner\'s own sentence while no reading has ever arrived', () => {
    // The step stands in for that banner where the card is on screen, so it
    // must lose nothing the banner said: both remedies, and the names to look for.
    expect(detailOf(freshInstall, 'power')).toBe(NEVER.remedy);
    expect(detailOf({ ...freshInstall, power: { state: 'received' } }, 'power')).toBe('Meter connected');
  });

  it('names the capacity period, so a quarter-hour tariff on the hourly default is visible', () => {
    // Flanders bills the 15-minute peak. An owner who saves a kW value and
    // leaves the default period gets the wrong control, and only the period
    // named beside the number shows it.
    const saved = (periodMinutes: 15 | 60): SetupPathFacts => ({
      ...freshInstall,
      actionableDeviceCount: 1,
      limitableDeviceCount: 1,
      hardCap: { state: 'saved', limitKw: 2.5, marginKw: 0.2, periodMinutes },
    });
    expect(detailOf(saved(15), 'hardCap')).toBe('2.5 kW hard cap (15-minute average), 0.2 kW safety margin');
    expect(detailOf(saved(60), 'hardCap')).toBe('2.5 kW hard cap (hourly average), 0.2 kW safety margin');
  });

  it.each(['BE', 'SE', 'DE'])('asks about measured peaks in %s without choosing a target', (country) => {
    const facts = { ...freshInstall, actionableDeviceCount: 1, limitableDeviceCount: 1,
      market: { state: 'resolved' as const, country } };
    expect(detailOf(facts, 'hardCap')).toContain('Charged for your highest hourly or 15-minute average grid import?');
    expect(detailOf(facts, 'hardCap')).toContain('10 kW hard cap (hourly average) until you set yours');
    expect(statuses(facts)).toContain('hardCap:later');
  });

  it('names the running default in Norway without asking, since every household pays for measured peaks', () => {
    const facts: SetupPathFacts = { ...freshInstall, actionableDeviceCount: 1, limitableDeviceCount: 1,
      market: { state: 'resolved', country: 'NO' } };
    expect(detailOf(facts, 'hardCap')).toBe('10 kW hard cap (hourly average) until you set yours');
    expect(statuses(facts)).toContain('hardCap:later');
  });

  it('asks about measured peaks while the market is unknown', () => {
    const facts: SetupPathFacts = { ...freshInstall, actionableDeviceCount: 1, limitableDeviceCount: 1,
      market: { state: 'unavailable' } };
    expect(detailOf(facts, 'hardCap')).toContain('Charged for your highest hourly or 15-minute average grid import?');
  });

  it('explains the Dutch connection tariff while preserving the explicit limits choice', () => {
    const facts: SetupPathFacts = { ...freshInstall, actionableDeviceCount: 1, limitableDeviceCount: 1,
      market: { state: 'resolved', country: 'NL' } };
    expect(detailOf(facts, 'hardCap')).toContain('Dutch household grid charges depend on connection size');
    expect(detailOf(facts, 'hardCap')).toContain('turn off Capacity limit and still use prices and solar');
    expect(detailOf(facts, 'hardCap')).toContain('10 kW hard cap (hourly average) until you set yours');
    expect(statuses(facts)).toContain('hardCap:later');
    expect(detailOf({ ...facts, hardCap: { state: 'saved', limitKw: 4, marginKw: 0.2, periodMinutes: 60 } },
      'hardCap')).toBe('4 kW hard cap (hourly average), 0.2 kW safety margin');
    expect(statuses({ ...facts, hardCap: { state: 'disabled' } })).toContain('hardCap:done');
  });

  it('sells no single market in its lede', () => {
    // The first setup supports either solar use or measured-peak control.
    expect(pathOf(freshInstall)?.lede).toBe(
      'Connect your meter, choose a device, then review your settings.',
    );
  });

  it('asks for prices last, only once something uses them, naming what PELS prices with meanwhile', () => {
    const summary = 'Homey Energy has no prices for your Homey.';
    const usingPrices: SetupPathFacts = {
      ...configuredAndSimulating,
      prices: { state: 'used', complete: false, summary },
    };

    expect(statuses(usingPrices)).toEqual(['power:done', 'devices:done', 'hardCap:done', 'prices:next']);
    expect(pathOf(usingPrices)?.steps.find((step) => step.id === 'prices')?.detail).toBe(summary);
    // Prices are a step of their own here, so the lede does not promise them.
    expect(pathOf(usingPrices)?.lede).toBe(
      'Connect your meter, choose a device, then review your settings.',
    );
    expect(resolveSetupPath({ ...usingPrices, prices: { state: 'used', complete: true, summary: 'Homey Energy' } }))
      .toEqual({ state: 'complete' });
    expect(resolveSetupPath(configuredAndSimulating)).toEqual({ state: 'complete' });
  });

  it('keeps the denominator fixed as devices activate limits and prices', () => {
    const choices = [freshInstall,
      { ...freshInstall, actionableDeviceCount: 1, limitableDeviceCount: 1 },
      { ...configuredAndSimulating, prices: { state: 'used' as const, complete: false, summary: 'Choose prices' } },
    ];
    for (const facts of choices) {
      expect(resolveSetupSteps(facts).steps.map((step) => step.id)).toEqual(['power', 'devices', 'hardCap', 'prices']);
    }
  });

  it('distinguishes an unread price setup from one the devices do not use', () => {
    const path = resolveSetupSteps({ ...configuredAndSimulating, prices: { state: 'unread' } });
    expect(path.steps[3]).toMatchObject({ status: 'done', detail: 'Price settings could not be read. Check Electricity prices.' });
    expect(resolveSetupSteps(configuredAndSimulating).steps[3].detail).toBe('Not needed for your devices');
  });

  it('moves the next step past whatever is already done, in any order', () => {
    // Devices chosen before the meter is connected: the meter still leads.
    expect(statuses({ ...freshInstall, actionableDeviceCount: 2 })).toEqual(['power:next', 'devices:done', 'hardCap:done', 'prices:done']);
  });

  it('keeps the power step done once a reading has ever arrived', () => {
    // A meter that has since gone quiet is the no-readings banner's alert, not
    // a setup step to redo.
    expect(statuses({ ...freshInstall, power: { state: 'received' } })?.[0]).toBe('power:done');
  });

  it('states the devices as a fact and never tells the owner to turn Limit on', () => {
    // Devices that cannot be limited, or that the owner chose not to limit, are
    // a finished choice.
    expect(detailOf(freshInstall, 'devices')).toBe('Choose one device to start');
    expect(detailOf({ ...priceOnlyOwner, power: NEVER }, 'devices')).toBe('2 devices managed');
    expect(detailOf({ ...configuredAndSimulating, power: NEVER }, 'devices')).toBe('1 device PELS may limit');
  });

  it('says simulation is on while the path is open, and nothing once PELS is live', () => {
    expect(pathOf(freshInstall)?.simulating).toBe(true);
    expect(pathOf({ ...freshInstall, simulating: false })?.simulating).toBe(false);
  });

  it('closes on a configured home that is still simulating', () => {
    // Simulation is not a step: the simulation banner speaks for this home, and
    // a card that waited for go-live would sit on its Overview for weeks.
    expect(resolveSetupPath(configuredAndSimulating)).toEqual({ state: 'complete' });
  });

  it('comes back when a returning owner unmanages their last device', () => {
    const resolved = resolveSetupPath({
      ...configuredAndSimulating, actionableDeviceCount: 0, limitableDeviceCount: 0, simulating: false,
    });
    expect(resolved.state === 'open'
      ? resolved.path.steps.map((step) => `${step.id}:${step.status}`)
      : []).toEqual(['power:done', 'devices:next', 'hardCap:later', 'prices:later']);
    expect(isSetupStepOpen(resolved, 'devices')).toBe(true);
    expect(isSetupStepOpen(resolved, 'power')).toBe(false);
    expect(isSetupStepOpen({ state: 'complete' }, 'devices')).toBe(false);
  });
});
