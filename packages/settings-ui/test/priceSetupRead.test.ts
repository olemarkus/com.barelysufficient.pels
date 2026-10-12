import { describe, expect, it } from 'vitest';
import { classifyPriceSetupRead, resolveDisplayedPriceScheme } from '../src/ui/priceSetupRead.ts';

const NORWAY = {
  county: { value: '55', chosen: true },
  gridCompany: { kind: 'chosen', organizationNumber: '979151950' },
  tariffGroup: { value: 'Husholdning', chosen: false },
  pricingModel: { value: 'norgespris', chosen: true },
  priceArea: { value: 'NO4', chosen: true },
};

const resolvedRead = (source: unknown, norway: unknown = NORWAY) => ({ state: 'resolved', setup: { source, norway } });

describe('classifyPriceSetupRead', () => {
  it('passes a well-formed read through', () => {
    const source = { scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' } };

    expect(classifyPriceSetupRead(resolvedRead(source))).toEqual(resolvedRead(source));
  });

  it('reads an app that does not send the field yet as unavailable', () => {
    expect(classifyPriceSetupRead(undefined)).toEqual({ state: 'unavailable' });
  });

  it('rejects a source it cannot vouch for', () => {
    expect(classifyPriceSetupRead(resolvedRead({ scheme: 'spot', basis: { kind: 'chosen' } })))
      .toEqual({ state: 'unavailable' });
    expect(classifyPriceSetupRead(resolvedRead({ scheme: 'homey', basis: { kind: 'hub_location', country: 'nl' } })))
      .toEqual({ state: 'unavailable' });
  });

  it('rejects Norway settings with a missing or malformed member', () => {
    const source = { scheme: 'norway', basis: { kind: 'chosen' } };

    expect(classifyPriceSetupRead(resolvedRead(source, { ...NORWAY, priceArea: { value: '', chosen: true } })))
      .toEqual({ state: 'unavailable' });
    expect(classifyPriceSetupRead(resolvedRead(source, { ...NORWAY, gridCompany: { kind: 'chosen' } })))
      .toEqual({ state: 'unavailable' });
  });
});

describe('resolveDisplayedPriceScheme', () => {
  it('shows the source the runtime has in force', () => {
    const read = classifyPriceSetupRead(resolvedRead({ scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' } }));

    expect(resolveDisplayedPriceScheme(read, undefined)).toBe('homey');
  });

  it('trusts a saved source over a prices read that predates the switch', () => {
    // The read is cached: right after the owner picks Norway it can still say
    // Homey Energy, and saving against it would drop the owner's switch.
    const staleRead = classifyPriceSetupRead(resolvedRead({ scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' } }));

    expect(resolveDisplayedPriceScheme(staleRead, 'norway')).toBe('norway');
  });

  it('falls back to the stored setting without the runtime read', () => {
    expect(resolveDisplayedPriceScheme({ state: 'unavailable' }, 'powerhour')).toBe('powerhour');
    expect(resolveDisplayedPriceScheme({ state: 'unavailable' }, undefined)).toBe('norway');
  });
});
