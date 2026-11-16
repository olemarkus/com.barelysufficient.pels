import { describe, expect, it } from 'vitest';
import { projectPhaseNames, standardPhaseName } from '../../lib/device/meterPhaseNames';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const NAMES = { a1: 'measure_power.l1', a2: 'measure_power.l2', a3: 'measure_power.l3' };

const device = (capabilities: string[]): HomeyDeviceLike => ({
  id: 'm', name: 'm', class: 'sensor', driverId: 'd', capabilities,
  capabilitiesObj: Object.fromEntries(capabilities.map((id, index) => [id, { id, value: index }])),
} as unknown as HomeyDeviceLike);

describe('meter phase names', () => {
  it('renames a complete vendor set and keeps the values', () => {
    const read = projectPhaseNames(device(['measure_power', 'a1', 'a2', 'a3']), NAMES);
    expect(read.capabilities).toEqual(['measure_power', 'measure_power.l1', 'measure_power.l2', 'measure_power.l3']);
    expect(read.capabilitiesObj['measure_power.l2']).toEqual({ id: 'measure_power.l2', value: 2 });
    expect(read.capabilitiesObj.a2).toBeUndefined();
  });

  it('leaves a partial set, or one beside standard phases, as declared', () => {
    const partial = device(['a1', 'a2']);
    expect(projectPhaseNames(partial, NAMES)).toBe(partial);
    const both = device(['a1', 'a2', 'a3', 'measure_power.l1']);
    expect(projectPhaseNames(both, NAMES)).toBe(both);
  });

  it('routes a live report to the name the accepted read uses', () => {
    const renamed = projectPhaseNames(device(['a1', 'a2', 'a3']), NAMES);
    expect(standardPhaseName(renamed, NAMES, 'a1')).toBe('measure_power.l1');
    expect(standardPhaseName(device(['a1', 'a2']), NAMES, 'a1')).toBe('a1');
    expect(standardPhaseName(renamed, NAMES, 'measure_power')).toBe('measure_power');
  });
});
