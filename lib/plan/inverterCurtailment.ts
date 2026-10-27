import type { InverterDecision } from '../planContract/inverterDecision';
import type { InverterControllableInput, InverterPlanInput, InverterPlanner } from '../ports/inverterControl';

export type InverterPlanningSource = {
  inputs(): readonly InverterPlanInput[];
  exportCostly(nowMs: number): boolean;
};

function releasesFor(inputs: readonly InverterPlanInput[]): InverterDecision[] {
  return inputs.flatMap((input) => input.kind === 'hand_back' || input.ownership.kind === 'held'
    ? [{ kind: 'release' as const, deviceId: input.deviceId }] : []);
}

function ceiling(input: InverterControllableInput): number {
  if (input.ownership.kind === 'free') {
    return input.observation.mode.kind === 'autonomous' ? input.surface.maxW
      : Math.min(input.surface.maxW, input.observation.limit.value);
  }
  const claim = input.ownership.claim;
  return claim.previousMode.kind === 'autonomous' ? input.surface.maxW
    : Math.min(input.surface.maxW, claim.previousLimitW);
}

/**
 * Meter-driven feedback on actual production and signed net import. Inverter
 * commands are never treated as produced watts. Unselected generation and a
 * battery's actual charge/discharge already appear in the grid reading.
 */
export class InverterCurtailmentPlanner implements InverterPlanner {
  constructor(private readonly source: InverterPlanningSource) {}

  releaseAll(): InverterDecision[] {
    return releasesFor(this.source.inputs());
  }

  decide(netImportW: number, nowMs: number): InverterDecision[] {
    const inputs = this.source.inputs();
    if (!inputs.some((input) => input.kind === 'controllable' && input.enabled)) return releasesFor(inputs);
    const costly = this.source.exportCostly(nowMs);
    const eligible = inputs.filter((input): input is InverterControllableInput => input.kind === 'controllable'
      && costly && input.enabled
      && !(input.ownership.kind === 'held' && input.ownership.recovering));
    const releases: InverterDecision[] = inputs.flatMap((input) => (
      input.kind === 'hand_back' || (!eligible.includes(input) && input.ownership.kind === 'held')
        ? [{ kind: 'release' as const, deviceId: input.deviceId }] : []
    ));
    const totalProductionW = eligible.reduce((sum, input) => sum + input.observation.production.value, 0);
    const totalCeilingW = eligible.reduce((sum, input) => sum + ceiling(input), 0);
    // A small export allowance avoids deliberately buying grid energy to save
    // a smaller export fee. The result is an economic controller, not a certified
    // zero-export protection system.
    const requiredW = Math.max(0, Math.min(totalCeilingW, totalProductionW + netImportW + 50));
    if (totalCeilingW === 0) return releases;
    for (const input of eligible) {
      if (input.notBeforeMs > nowMs) continue;
      if (input.ownership.kind === 'free' && netImportW >= -100) continue;
      const weight = totalProductionW > 0 ? input.observation.production.value / totalProductionW
        : ceiling(input) / totalCeilingW;
      const rawW = netImportW > 100 ? ceiling(input) : requiredW * weight;
      const limitW = Math.min(ceiling(input), Math.ceil(rawW / input.surface.stepW) * input.surface.stepW);
      // Do not take control just to reassert an already unrestricted inverter.
      if (input.ownership.kind === 'free' && limitW >= ceiling(input)) continue;
      releases.push({ kind: 'limit', deviceId: input.deviceId, limitW,
        binding: input.surface, observation: input.observation });
    }
    return releases;
  }
}
