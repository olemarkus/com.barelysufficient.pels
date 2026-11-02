import { describe, expect, it } from 'vitest';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { buildSmartTaskCycleRecord } from '../../lib/objectives/deferredObjectives/smartTaskCycleRecord';
import { partialDouble } from '../helpers/partialDouble';

const diagnostic = (applied: Partial<DeferredObjectiveDiagnostic>) => partialDouble<DeferredObjectiveDiagnostic>({
  reasonCode: 'objective_progress_stale', trajectory: { kind: 'resolved', status: 'at_risk' }, currentValue: 40,
  energyNeededKWh: 20, planningSpeedKw: 7, kwhPerUnitSource: 'learned', kwhPerUnitAcceptedSamples: 4,
  ...applied,
});

describe('smart task cycle record', () => {
  it('names the saved permissions the producer applied this cycle', () => {
    const record = buildSmartTaskCycleRecord(
      diagnostic({ budgetExemptApplied: true, limitLowerPriorityApplied: false, pauseLowerPriorityApplied: true }),
      { kind: 'idle', budgetExempt: true, holdCause: 'cheaper_hours' }, 1_000,
    );
    expect(record.permissionsInForce).toEqual(['exemptFromBudget', 'pauseLowerPriorityDevices']);
  });

  it('leaves the field out when none applied, as for a satisfied task', () => {
    const record = buildSmartTaskCycleRecord(diagnostic({}), { kind: 'inactive', budgetExempt: false }, 1_000);
    expect(record).not.toHaveProperty('permissionsInForce');
  });
});
