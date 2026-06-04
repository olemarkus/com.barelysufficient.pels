import { describe, expect, it } from 'vitest';

import { formatDeviceMustBeProvidedMessage } from '../../packages/shared-domain/src/smartTaskRescueStrings';

describe('formatDeviceMustBeProvidedMessage', () => {
  // Byte-identical to the literal that previously lived inline in
  // flowCards/deviceSettingsCards.ts: `${label[0].toUpperCase()}${label.slice(1)} device must be provided`.
  it.each([
    ['budget exemption', 'Budget exemption device must be provided'],
    ['capacity control', 'Capacity control device must be provided'],
  ])('capitalizes the label %s -> %s', (label, expected) => {
    expect(formatDeviceMustBeProvidedMessage(label)).toBe(expected);
  });

  it('matches the original inline expression for an arbitrary label', () => {
    const label = 'something else';
    const original = `${label[0].toUpperCase()}${label.slice(1)} device must be provided`;
    expect(formatDeviceMustBeProvidedMessage(label)).toBe(original);
  });
});
