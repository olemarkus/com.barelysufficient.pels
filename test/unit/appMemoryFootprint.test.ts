import { parseAppMemoryUsage } from '../../lib/diagnostics/appMemoryFootprint';

const MB = 1024 * 1024;

describe('parseAppMemoryUsage', () => {
  it('turns Homey\'s byte counts into the megabytes the log reports', () => {
    expect(parseAppMemoryUsage({
      mem: { rss: 139.5 * MB, pss: 84.4 * MB, sharedClean: 55.1 * MB, pssSwap: 0 },
      cpu: { percentage: 3 },
    }, 1_000)).toEqual({ atMs: 1_000, rssMb: 139.5, pssMb: 84.4, sharedCleanMb: 55.1, swapMb: 0 });
  });

  it.each([
    ['no mem object', { cpu: {} }],
    ['a missing field', { mem: { rss: MB, pss: MB, sharedClean: MB } }],
    ['a non-finite field', { mem: { rss: Number.NaN, pss: MB, sharedClean: MB, pssSwap: 0 } }],
    ['a negative field', { mem: { rss: MB, pss: -1, sharedClean: MB, pssSwap: 0 } }],
    ['a string field', { mem: { rss: '1', pss: MB, sharedClean: MB, pssSwap: 0 } }],
    ['an error body', 'Not Found'],
  ])('rejects %s', (_label, body) => {
    expect(parseAppMemoryUsage(body, 1_000)).toBeNull();
  });
});
