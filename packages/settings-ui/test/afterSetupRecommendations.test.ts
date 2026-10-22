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

  describe('the price suggestion', () => {
    const prices = (priceSource: AfterSetupFacts['priceSource']) => resolveAfterSetupRecommendations(
      { ...everythingApplies, priceSource },
    ).find((entry) => entry.id === 'after-setup:prices');

    it('says the prices are there and makes the assumed source the owner\'s before opening Devices', () => {
      // Otherwise turning on Price would reopen the setup path on Prices.
      const suggestion = prices({ kind: 'priced', scheme: 'homey', chosen: false });
      expect(suggestion).toMatchObject({
        title: 'Heat in cheap hours',
        body: 'PELS already has your prices from Homey Energy. Turn on Price for your heating and hot water '
          + 'so they heat more in cheap hours.',
        actionLabel: 'Use these prices',
        target: { kind: 'keep-price-source', scheme: 'homey' },
      });
    });

    it('names the source in force and goes straight to Devices once the owner chose it', () => {
      expect(prices({ kind: 'priced', scheme: 'powerhour', chosen: true })).toMatchObject({
        body: expect.stringContaining('from Power by the Hour.'),
        actionLabel: 'Choose devices',
        target: { kind: 'panel', panelId: 'devices' },
      });
    });

    it('sends a home PELS holds no prices for to set them up', () => {
      expect(prices({ kind: 'needs_setup' })).toMatchObject({
        actionLabel: 'Set up prices',
        target: { kind: 'panel', panelId: 'electricity-prices' },
      });
    });

    it('asks for the source when Power by the Hour could price the home instead of Homey Energy', () => {
      // Keeping Homey Energy from here would leave the owner's markups in
      // Power by the Hour unused without their having seen the choice.
      expect(prices({ kind: 'powerhour_offered' })).toMatchObject({
        actionLabel: 'Set up prices',
        target: { kind: 'panel', panelId: 'electricity-prices' },
      });
    });

    it('keeps one id across its forms, so a dismissal holds', () => {
      expect(prices({ kind: 'priced', scheme: 'homey', chosen: false })?.version)
        .toBe(prices({ kind: 'needs_setup' })?.version);
    });
  });

  it('says nothing while the setup path is open: one thing at a time', () => {
    expect(ids({ ...everythingApplies, setupComplete: false })).toEqual([]);
  });

  describe('only what is relevant to this home', () => {
    it('does not suggest prices to a home with nothing Price can act on', () => {
      // Price adjusts a temperature target. An owner with only a charger and a
      // pool pump has no device it applies to.
      const facts = { ...everythingApplies, devices: [device({ taskCapable: true })] };
      expect(ids(facts)).not.toContain('after-setup:prices');
    });

    it('does not suggest solar to a home that does not export, or that PELS cannot act on', () => {
      expect(ids({ ...everythingApplies, solarSurplusAvailable: false })).not.toContain('after-setup:solar');
      const nothingLimitable = {
        ...everythingApplies,
        devices: [device({ temperature: true, limitable: false })],
      };
      expect(ids(nothingLimitable)).not.toContain('after-setup:solar');
    });

    it('does not suggest Smart tasks to a home with nothing that could take one', () => {
      const facts = { ...everythingApplies, devices: [device()] };
      expect(ids(facts)).not.toContain('after-setup:smart-tasks');
    });
  });

  describe('never what the owner already uses', () => {
    it('drops prices once any device has an explicit Price choice, including Off', () => {
      const facts = {
        ...everythingApplies,
        devices: [device({ temperature: true, priceConfigured: true })],
      };
      expect(ids(facts)).not.toContain('after-setup:prices');
    });

    it('drops prices when the owner turned the global feature off', () => {
      expect(ids({ ...everythingApplies, priceOptimizationEnabled: false }))
        .not.toContain('after-setup:prices');
    });

    it('drops solar once any device uses the surplus', () => {
      const facts = {
        ...everythingApplies,
        devices: [device({ usesSolarSurplus: true })],
      };
      expect(ids(facts)).not.toContain('after-setup:solar');
    });

    it('drops Smart tasks once one is configured', () => {
      expect(ids({ ...everythingApplies, smartTaskConfigured: true }))
        .not.toContain('after-setup:smart-tasks');
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
        devices: [device({ temperature: true, limitable: false })],
      };
      expect(ids(facts)).not.toContain('market:flanders-capacity-period');
    });
  });
});
