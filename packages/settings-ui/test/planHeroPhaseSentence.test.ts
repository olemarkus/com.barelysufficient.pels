import { buildDecisionSentence } from '../src/ui/planHeroSummary.ts';

const base = {
  managedDeviceCount: 2,
  limitedCount: 1,
  resumingCount: 0,
  dryRun: false,
  projectedOverHardCap: false,
  projectedOverBudget: false,
  gridImportHigh: false,
  safePaceKw: 8,
  capacityPeriodMinutes: 60 as const,
  jobs: { state: 'uncounted' as const },
  capacityControlOffCount: 0,
  sheddableManagedRunningCount: 0,
};

describe('decision sentence for a phase at the main fuse', () => {
  it('names the phase when nothing managed can relieve it', () => {
    const sentence = buildDecisionSentence({ ...base, unrelievedPhase: 'L2' });
    expect(sentence.text).toContain('L2');
    expect(sentence.text).toContain('Turn off other appliances to stay under your limit.');
    expect(sentence.positive).toBe(false);
  });

  it('keeps the existing line otherwise', () => {
    expect(buildDecisionSentence(base).text).not.toContain('main fuse');
  });
});

describe('decision sentence for a phase exporting past its target', () => {
  it('names the phase', () => {
    expect(buildDecisionSentence({ ...base, exportPhase: 'L3' }).text).toContain('L3 is exporting');
  });
});
