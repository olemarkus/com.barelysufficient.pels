import {
  resolveAfterSetupRecommendations,
  type AfterSetupDevice,
  type AfterSetupFacts,
} from '../src/ui/afterSetupRecommendations.ts';

const device = (overrides: Partial<AfterSetupDevice> = {}): AfterSetupDevice => ({
  temperature: false,
  limitable: true,
  taskCapable: false,
  priceEnabled: false,
  usesSolarSurplus: false,
  ...overrides,
});

// Setup complete, one thermostat and one charger managed, the home exports
// solar, and none of the three features is in use.
const everythingApplies: AfterSetupFacts = {
  setupComplete: true,
  devices: {
    state: 'known',
    value: [device({ temperature: true, taskCapable: true }), device({ taskCapable: true })],
  },
  solarSurplusAvailable: true,
  smartTaskConfigured: { state: 'known', value: false },
  market: { state: 'unavailable' },
  belgianHomeOnHourlyPeriod: false,
};

const ids = (facts: AfterSetupFacts) => resolveAfterSetupRecommendations(facts).map((entry) => entry.id);

describe('after-setup suggestions', () => {
  it('offers prices, solar and Smart tasks, in the order the setup path names them', () => {
    expect(ids(everythingApplies)).toEqual([
      'after-setup:prices', 'after-setup:solar', 'after-setup:smart-tasks',
    ]);
  });

  it('marks them optional and sends each to the page that sets it up', () => {
    const suggestions = resolveAfterSetupRecommendations(everythingApplies);
    expect(suggestions.map((entry) => entry.category)).toEqual(['optional', 'optional', 'optional']);
    expect(suggestions.map((entry) => entry.target)).toEqual([
      { kind: 'panel', panelId: 'electricity-prices' },
      { kind: 'panel', panelId: 'devices' },
      { kind: 'panel', panelId: 'deadlines' },
    ]);
  });

  it('says nothing while the setup path is open: one thing at a time', () => {
    expect(ids({ ...everythingApplies, setupComplete: false })).toEqual([]);
  });

  describe('only what is relevant to this home', () => {
    it('does not suggest prices to a home with nothing Price can act on', () => {
      // Price adjusts a temperature target. An owner with only a charger and a
      // pool pump has no device it applies to.
      const facts = { ...everythingApplies, devices: { state: 'known' as const, value: [device({ taskCapable: true })] } };
      expect(ids(facts)).not.toContain('after-setup:prices');
    });

    it('does not suggest solar to a home that does not export, or that PELS cannot act on', () => {
      expect(ids({ ...everythingApplies, solarSurplusAvailable: false })).not.toContain('after-setup:solar');
      const nothingLimitable = {
        ...everythingApplies,
        devices: { state: 'known' as const, value: [device({ temperature: true, limitable: false })] },
      };
      expect(ids(nothingLimitable)).not.toContain('after-setup:solar');
    });

    it('does not suggest Smart tasks to a home with nothing that could take one', () => {
      const facts = { ...everythingApplies, devices: { state: 'known' as const, value: [device()] } };
      expect(ids(facts)).not.toContain('after-setup:smart-tasks');
    });
  });

  describe('never what the owner already uses', () => {
    it('drops prices once any device follows them', () => {
      const facts = {
        ...everythingApplies,
        devices: { state: 'known' as const, value: [device({ temperature: true, priceEnabled: true })] },
      };
      expect(ids(facts)).not.toContain('after-setup:prices');
    });

    it('drops solar once any device uses the surplus', () => {
      const facts = {
        ...everythingApplies,
        devices: { state: 'known' as const, value: [device({ usesSolarSurplus: true })] },
      };
      expect(ids(facts)).not.toContain('after-setup:solar');
    });

    it('drops Smart tasks once one is configured', () => {
      expect(ids({ ...everythingApplies, smartTaskConfigured: { state: 'known', value: true } }))
        .not.toContain('after-setup:smart-tasks');
    });
  });

  describe('an unread fact is not a feature nobody turned on', () => {
    it('suggests nothing while the device and price settings are unknown', () => {
      // A failed read of the price settings looks exactly like a home with
      // Price off everywhere; suggesting it then is telling an owner to set up
      // what they set up last year.
      expect(ids({ ...everythingApplies, devices: { state: 'unknown' } })).toEqual([]);
    });

    it('holds back only Smart tasks while only those settings are unknown', () => {
      expect(ids({ ...everythingApplies, smartTaskConfigured: { state: 'unknown' } })).toEqual([
        'after-setup:prices', 'after-setup:solar',
      ]);
    });
  });

  describe('tailored by where the hub is', () => {
    it('puts an owner\'s own solar first in the Netherlands, where net metering is ending', () => {
      expect(ids({ ...everythingApplies, market: { state: 'resolved', country: 'NL' } })).toEqual([
        'after-setup:solar', 'after-setup:prices', 'after-setup:smart-tasks',
      ]);
    });

    it('changes the order only: no market adds or removes an optional feature', () => {
      const norway = ids({ ...everythingApplies, market: { state: 'resolved', country: 'NO' } });
      expect(norway).toEqual(ids(everythingApplies));
    });

    it('asks a Belgian home on the hourly average to check its capacity period', () => {
      const [first] = resolveAfterSetupRecommendations({ ...everythingApplies, belgianHomeOnHourlyPeriod: true });
      expect(first?.id).toBe('market:flanders-capacity-period');
      // A real recommendation, and a question: only the owner knows whether
      // Belgium means Flanders, so the body says who may dismiss it.
      expect(first?.category).toBe('recommendation');
      expect(first?.body).toContain('If you live in Flanders');
      expect(first?.body).toContain('Elsewhere in Belgium this does not apply');
      expect(first?.target).toEqual({ kind: 'panel', panelId: 'limits' });
    });

    it('does not ask when PELS may limit nothing: no cap is in force to be wrong', () => {
      const facts = {
        ...everythingApplies,
        belgianHomeOnHourlyPeriod: true,
        devices: { state: 'known' as const, value: [device({ temperature: true, limitable: false })] },
      };
      expect(ids(facts)).not.toContain('market:flanders-capacity-period');
    });
  });
});
