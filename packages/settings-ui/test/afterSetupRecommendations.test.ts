import {
  resolveAfterSetupRecommendations,
  type AfterSetupDevice,
  type AfterSetupFacts,
} from '../src/ui/afterSetupRecommendations.ts';

const device = (overrides: Partial<AfterSetupDevice> = {}): AfterSetupDevice => ({
  temperature: false,
  limitable: true,
  taskCapable: false,
  priceConfigured: false,
  usesSolarSurplus: false,
  ...overrides,
});

// Setup complete, one thermostat and one charger managed, the home exports
// solar, and none of the three features is in use.
const everythingApplies: AfterSetupFacts = {
  setupComplete: true,
  devices: [device({ temperature: true, taskCapable: true }), device({ taskCapable: true })],
  priceOptimizationEnabled: true,
  priceSource: { kind: 'needs_setup' },
  solarSurplusAvailable: true,
  smartTaskConfigured: false,
  market: { state: 'unavailable' },
  belgianHomeOnHourlyPeriod: false,
};

const ids = (facts: AfterSetupFacts) => resolveAfterSetupRecommendations(facts, {}).map((entry) => entry.id);

const goals = (facts: AfterSetupFacts, dismissals: Record<string, number> = {}) => resolveAfterSetupRecommendations(
  facts, dismissals,
).find((entry) => entry.id === 'after-setup:goals');

describe('after-setup suggestions', () => {
  it('offers prices, solar and Smart tasks as one card that opens Choose what PELS does', () => {
    expect(ids(everythingApplies)).toEqual(['after-setup:goals']);
    expect(goals(everythingApplies)).toMatchObject({
      category: 'optional',
      title: 'Choose what PELS does',
      body: 'PELS can heat in cheap hours, use more of your own solar or have something ready by a set time. '
        + 'Choose for each device.',
      actionLabel: 'Choose',
      target: { kind: 'setup-goals' },
      guideLink: { label: 'Heat a water heater overnight' },
    });
  });

  it('keeps one id and version whatever it names, so a dismissal holds', () => {
    const onlyTasks = goals({ ...everythingApplies, solarSurplusAvailable: false, priceOptimizationEnabled: false });
    expect(onlyTasks?.body).toBe('PELS can have something ready by a set time. Choose for each device.');
    expect(onlyTasks?.version).toBe(goals(everythingApplies)?.version);
  });

  it('says nothing while the setup path is open: one thing at a time', () => {
    expect(ids({ ...everythingApplies, setupComplete: false })).toEqual([]);
  });

  describe('only what is relevant to this home', () => {
    it('does not offer prices to a home with nothing Price can act on', () => {
      // Price adjusts a temperature target. An owner with only a charger and a
      // pool pump has no device it applies to.
      const facts = { ...everythingApplies, devices: [device({ taskCapable: true })] };
      expect(goals(facts)?.body).not.toContain('cheap hours');
    });

    it('does not offer solar to a home that does not export, or that PELS cannot act on', () => {
      expect(goals({ ...everythingApplies, solarSurplusAvailable: false })?.body).not.toContain('solar');
      const nothingLimitable = { ...everythingApplies, devices: [device({ temperature: true, limitable: false })] };
      expect(goals(nothingLimitable)?.body).not.toContain('solar');
    });

    it('does not offer Smart tasks, or the relay guide, to a home with nothing that could take one', () => {
      const suggestion = goals({ ...everythingApplies, devices: [device({ temperature: true })] });
      expect(suggestion?.body).not.toContain('ready by');
      expect(suggestion?.guideLink).toBeUndefined();
    });

    it('offers no card at all when nothing applies', () => {
      expect(ids({ ...everythingApplies, devices: [device({ limitable: false })] })).toEqual([]);
    });
  });

  it('leaves out an offer whose own card the owner dismissed before the cards became one', () => {
    const suggestion = goals(everythingApplies, { 'after-setup:prices': 1, 'after-setup:smart-tasks': 1 });
    expect(suggestion?.body).toBe('PELS can use more of your own solar. Choose for each device.');
    expect(suggestion?.guideLink).toBeUndefined();
    expect(goals(everythingApplies, {
      'after-setup:prices': 1, 'after-setup:solar': 1, 'after-setup:smart-tasks': 1,
    })).toBeUndefined();
  });

  describe('never what the owner already uses', () => {
    it('drops prices once any device has an explicit Price choice, including Off', () => {
      const facts = { ...everythingApplies, devices: [device({ temperature: true, priceConfigured: true })] };
      expect(goals(facts)?.body).not.toContain('cheap hours');
    });

    it('drops prices when the owner turned the global feature off', () => {
      expect(goals({ ...everythingApplies, priceOptimizationEnabled: false })?.body).not.toContain('cheap hours');
    });

    it('drops solar once any device uses the surplus', () => {
      const facts = { ...everythingApplies, devices: [device({ taskCapable: true, usesSolarSurplus: true })] };
      expect(goals(facts)?.body).not.toContain('solar');
    });

    it('drops Smart tasks once one is configured', () => {
      expect(goals({ ...everythingApplies, smartTaskConfigured: true })?.body).not.toContain('ready by');
    });
  });

  describe('tailored by where the hub is', () => {
    it('names an owner\'s own solar first in the Netherlands, where net metering is ending', () => {
      expect(goals({ ...everythingApplies, market: { state: 'resolved', country: 'NL' } })?.body).toBe(
        'PELS can use more of your own solar, heat in cheap hours or have something ready by a set time. '
          + 'Choose for each device.',
      );
    });

    it('changes the order only: no market adds or removes an offer', () => {
      const norway = goals({ ...everythingApplies, market: { state: 'resolved', country: 'NO' } });
      expect(norway?.body).toBe(goals(everythingApplies)?.body);
    });

    it('asks a Belgian home on the hourly average to check its capacity period', () => {
      const [first] = resolveAfterSetupRecommendations({ ...everythingApplies, belgianHomeOnHourlyPeriod: true }, {});
      expect(first?.id).toBe('market:flanders-capacity-period');
      // A real recommendation, and a question: only the owner knows whether
      // Belgium means Flanders, so the body says who may dismiss it.
      expect(first?.category).toBe('recommendation');
      expect(first?.body).toBe('In Flanders? Use the 15-minute average for measured peaks.');
      expect(first?.target).toEqual({ kind: 'quarter-hour' });
    });

    it('does not ask when PELS may limit nothing: no cap is in force to be wrong', () => {
      const facts = {
        ...everythingApplies,
        belgianHomeOnHourlyPeriod: true,
        devices: [device({ temperature: true, limitable: false })],
      };
      expect(ids(facts)).not.toContain('market:flanders-capacity-period');
    });
  });
});
