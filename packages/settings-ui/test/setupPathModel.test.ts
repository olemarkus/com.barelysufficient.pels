import {
  formatSetupProgress,
  isSetupStepOpen,
  resolveSetupPath,
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
  managedDeviceCount: 0,
  limitableDeviceCount: 0,
  simulating: true,
  market: { state: 'unavailable' },
};

// Everything the path asks for, with simulation still on: a cautious owner who
// has finished setting up and is watching before going live.
const configuredAndSimulating: SetupPathFacts = {
  power: { state: 'received' },
  hardCap: { state: 'saved', limitKw: 8, marginKw: 0.4, periodMinutes: 60 },
  managedDeviceCount: 3,
  limitableDeviceCount: 1,
  simulating: true,
  market: { state: 'unavailable' },
};

// An owner who manages thermostats for their price response and nothing else:
// readings arriving, devices managed, none PELS may limit, no hard cap saved.
const priceOnlyOwner: SetupPathFacts = {
  power: { state: 'received' },
  hardCap: { state: 'unset', runningLimitKw: 10, periodMinutes: 60 },
  managedDeviceCount: 2,
  limitableDeviceCount: 0,
  simulating: false,
  market: { state: 'unavailable' },
};

const statuses = (facts: SetupPathFacts) => (
  resolveSetupPath(facts)?.steps.map((step) => `${step.id}:${step.status}`)
);

const detailOf = (facts: SetupPathFacts, id: 'power' | 'hardCap' | 'devices') => (
  resolveSetupPath(facts)?.steps.find((step) => step.id === id)?.detail
);

describe('setup path', () => {
  it('asks a fresh install for the two things every home needs, and nothing else', () => {
    // No hard cap row: nothing may be limited yet, so no cap is in force.
    expect(statuses(freshInstall)).toEqual(['power:next', 'devices:later']);
    const path = resolveSetupPath(freshInstall);
    expect(path && formatSetupProgress(path)).toBe('0 of 2');
  });

  describe('a step appears only when what it configures is in force', () => {
    it('never shows the hard cap to an owner PELS may not limit anything for', () => {
      // Asking them to set a capacity cap would be asking for something that
      // never touches their home. Their setup is complete.
      expect(resolveSetupPath(priceOnlyOwner)).toBeNull();
    });

    it('never keeps the path open over an unsaved cap that is not in force', () => {
      expect(statuses({ ...priceOnlyOwner, power: NEVER })).toEqual(['power:next', 'devices:done']);
    });

    it('shows the hard cap once a device may be limited, naming the number it is running on', () => {
      // Now the cap IS in force, tariff or no tariff: every home runs one, and
      // this device will be held to 10 kW until the owner says otherwise.
      const facts = { ...priceOnlyOwner, limitableDeviceCount: 1 };
      expect(statuses(facts)).toEqual(['power:done', 'devices:done', 'hardCap:next']);
      expect(detailOf(facts, 'hardCap')).toBe('10 kW hourly average until you set yours');
    });

    it('puts Devices before Hard cap: what may be limited, then to what', () => {
      const path = resolveSetupPath({ ...freshInstall, managedDeviceCount: 1, limitableDeviceCount: 1 });
      expect(path?.steps.map((step) => step.id)).toEqual(['power', 'devices', 'hardCap']);
      expect(path && formatSetupProgress(path)).toBe('1 of 3');
    });
  });

  it('says the no-readings banner\'s own sentence while no reading has ever arrived', () => {
    // The step stands in for that banner where the card is on screen, so it
    // must lose nothing the banner said: both remedies, and the names to look for.
    expect(detailOf(freshInstall, 'power')).toBe(NEVER.remedy);
    expect(detailOf({ ...freshInstall, power: { state: 'received' } }, 'power')).toBe('Readings are arriving');
  });

  it('names the capacity period, so a quarter-hour tariff on the hourly default is visible', () => {
    // Flanders bills the 15-minute peak. An owner who saves a kW value and
    // leaves the default period gets the wrong control, and only the period
    // named beside the number shows it.
    const saved = (periodMinutes: 15 | 60): SetupPathFacts => ({
      ...freshInstall,
      managedDeviceCount: 1,
      limitableDeviceCount: 1,
      hardCap: { state: 'saved', limitKw: 2.5, marginKw: 0.2, periodMinutes },
    });
    expect(detailOf(saved(15), 'hardCap')).toBe('2.5 kW 15-minute average, 0.2 kW safety margin');
    expect(detailOf(saved(60), 'hardCap')).toBe('2.5 kW hourly average, 0.2 kW safety margin');
  });

  describe('tailored by where the hub is, never by its language', () => {
    const belgian = (periodMinutes: 15 | 60): SetupPathFacts => ({
      ...freshInstall,
      managedDeviceCount: 1,
      limitableDeviceCount: 1,
      market: { state: 'resolved', country: 'BE' },
      hardCap: { state: 'unset', runningLimitKw: 10, periodMinutes },
    });

    it('names Flanders to a Belgian home still on the hourly default', () => {
      // Flanders bills the 15-minute peak; the rest of Belgium has no such
      // tariff and a country code cannot tell them apart, so this names
      // Flanders rather than telling every Belgian owner to change it.
      expect(detailOf(belgian(60), 'hardCap'))
        .toBe('10 kW hourly average until you set yours. In Flanders, use the 15-minute average.');
    });

    it('says nothing more once that home is on the 15-minute average', () => {
      expect(detailOf(belgian(15), 'hardCap')).toBe('10 kW 15-minute average until you set yours');
    });

    it('gives a Norwegian hub, and an unknown one, exactly the neutral copy', () => {
      const norwegian = { ...belgian(60), market: { state: 'resolved' as const, country: 'NO' } };
      const unknown = { ...belgian(60), market: { state: 'unavailable' as const } };
      expect(detailOf(norwegian, 'hardCap')).toBe('10 kW hourly average until you set yours');
      expect(detailOf(unknown, 'hardCap')).toBe('10 kW hourly average until you set yours');
    });
  });

  it('sells no single market in its lede', () => {
    // The Netherlands has no household capacity tariff; an owner there came for
    // solar and dynamic prices and must not read this as somebody else's app.
    expect(resolveSetupPath(freshInstall)?.lede).toBe(
      'PELS starts managing your devices once these are done. Prices, solar and Smart tasks build on them.',
    );
  });

  it('moves the next step past whatever is already done, in any order', () => {
    // Devices chosen before the meter is connected: the meter still leads.
    expect(statuses({ ...freshInstall, managedDeviceCount: 2 })).toEqual(['power:next', 'devices:done']);
  });

  it('keeps the power step done once a reading has ever arrived', () => {
    // A meter that has since gone quiet is the no-readings banner's alert, not
    // a setup step to redo.
    expect(statuses({ ...freshInstall, power: { state: 'received' } })?.[0]).toBe('power:done');
  });

  it('states the devices as a fact and never tells the owner to turn Limit on', () => {
    // Devices that cannot be limited, or that the owner chose not to limit, are
    // a finished choice.
    expect(detailOf(freshInstall, 'devices')).toBe('Choose the devices PELS manages');
    expect(detailOf({ ...priceOnlyOwner, power: NEVER }, 'devices')).toBe('2 devices managed');
    expect(detailOf({ ...configuredAndSimulating, power: NEVER }, 'devices')).toBe('1 device PELS may limit');
  });

  it('says simulation is on while the path is open, and nothing once PELS is live', () => {
    expect(resolveSetupPath(freshInstall)?.simulationNote)
      .toBe('Simulation is on, so devices stay as-is until you turn it off.');
    expect(resolveSetupPath({ ...freshInstall, simulating: false })?.simulationNote).toBeNull();
  });

  it('closes on a configured home that is still simulating', () => {
    // Simulation is not a step: the simulation banner speaks for this home, and
    // a card that waited for go-live would sit on its Overview for weeks.
    expect(resolveSetupPath(configuredAndSimulating)).toBeNull();
  });

  it('comes back when a returning owner unmanages their last device', () => {
    const path = resolveSetupPath({
      ...configuredAndSimulating, managedDeviceCount: 0, limitableDeviceCount: 0, simulating: false,
    });
    expect(path?.steps.map((step) => `${step.id}:${step.status}`)).toEqual(['power:done', 'devices:next']);
    expect(isSetupStepOpen(path, 'devices')).toBe(true);
    expect(isSetupStepOpen(path, 'power')).toBe(false);
    expect(isSetupStepOpen(null, 'devices')).toBe(false);
  });
});
