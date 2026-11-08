import type { InverterDecision } from '../planContract/inverterDecision';
import type { InverterControllableInput, InverterPlanInput, InverterPlanner } from '../ports/inverterControl';

export type InverterPlanningSource = {
  inputs(): readonly InverterPlanInput[];
  exportCostly(nowMs: number): boolean;
};

/** Production the held inverters are kept below what they could make, W. */
const heldBackW = (inputs: readonly InverterPlanInput[]): number => {
  let totalW = 0;
  for (const input of inputs) {
    if (input.kind === 'controllable' && input.ownership.kind === 'held') {
      totalW += Math.max(0, ceiling(input) - input.observation.limit.value);
    }
  }
  return totalW;
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
 * The production the inverters may keep. A phase past its target has to come
 * down by its excess whatever the net says; repeated each reading, so a
 * three-phase inverter converges though the phase sees a third of each step.
 */
function resolveRequiredW(
  totalCeilingW: number,
  totalProductionW: number,
  netImportW: number,
  exportCostly: boolean,
  phaseExportExcessW: number,
  phaseFloorW: number,
): number {
  const priceRequiredW = exportCostly ? totalProductionW + netImportW + 50 : totalCeilingW;
  const phaseRequiredW = phaseExportExcessW > 0
    ? Math.max(phaseFloorW, totalProductionW - phaseExportExcessW)
    : totalCeilingW;
  return Math.max(0, Math.min(totalCeilingW, priceRequiredW, phaseRequiredW));
}

/** One run of a phase past its export target, from the first reading until the inverters are free again. */
type PhaseExportEpisode = {
  startProductionW: number;
  maxExcessW: number;
  lastProductionW: number;
  lastExcessW: number;
  /** A real drop in production did nothing for the phase: this inverter does not feed it. */
  unresponsive: boolean;
};

/** A drop smaller than this says nothing about whether the phase responded. */
const MIN_PRODUCTION_STEP_W = 200;
const MIN_PHASE_RESPONSE_SHARE = 0.1;

/**
 * Meter-driven feedback on actual production and signed net import. Inverter
 * commands are never treated as produced watts. Unselected generation and a
 * battery's actual charge/discharge already appear in the grid reading.
 */
export class InverterCurtailmentPlanner implements InverterPlanner {
  private phaseEpisode: PhaseExportEpisode | null = null;

  constructor(private readonly source: InverterPlanningSource) {}

  releaseAll(): InverterDecision[] {
    return releasesFor(this.source.inputs());
  }

  decide(
    netImportW: number,
    nowMs: number,
    phaseExportExcessW: number,
    phaseExportRoomW: number | null,
  ): InverterDecision[] {
    const inputs = this.source.inputs();
    if (!inputs.some((input) => input.kind === 'controllable' && input.enabled)) return releasesFor(inputs);
    const phaseOverload = phaseExportExcessW > 0;
    const costly = this.source.exportCostly(nowMs);
    // Held until the phase has room for what is held back, or it would flap at the first reading under target.
    const phaseHolding = !phaseOverload && phaseExportRoomW !== null
      && phaseExportRoomW < heldBackW(inputs);
    const curtailing = costly || phaseOverload || phaseHolding;
    const eligible = inputs.filter((input): input is InverterControllableInput => input.kind === 'controllable'
      && curtailing && input.enabled
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
    const phaseFloorW = this.resolvePhaseFloorW(totalProductionW, phaseExportExcessW, phaseHolding);
    const requiredW = resolveRequiredW(
      totalCeilingW, totalProductionW, netImportW, costly, phaseExportExcessW, phaseFloorW,
    );
    if (totalCeilingW === 0) return releases;
    const ignoresNet = phaseOverload;
    const limits = eligible.flatMap((input) => {
      const leavesFreeAlone = input.ownership.kind === 'free' && netImportW >= -100 && !ignoresNet;
      const keptForPhase = phaseHolding && !costly;
      if (input.notBeforeMs > nowMs || leavesFreeAlone || keptForPhase) return [];
      const weight = totalProductionW > 0 ? input.observation.production.value / totalProductionW
        : ceiling(input) / totalCeilingW;
      const rawW = netImportW > 100 && !ignoresNet ? ceiling(input) : requiredW * weight;
      const roomCapW = phaseExportRoomW !== null && input.ownership.kind === 'held' && !phaseOverload
        ? input.observation.limit.value + Math.max(0, phaseExportRoomW) : Number.POSITIVE_INFINITY;
      const limitW = Math.min(ceiling(input), roomCapW, Math.ceil(rawW / input.surface.stepW) * input.surface.stepW);
      // Do not take control just to reassert an already unrestricted inverter.
      if (input.ownership.kind === 'free' && limitW >= ceiling(input)) return [];
      return [{ kind: 'limit' as const, deviceId: input.deviceId, limitW,
        binding: input.surface, observation: input.observation }];
    });
    return [...releases, ...limits];
  }

  /**
   * How low a phase overload may take production. An inverter on another phase
   * cannot help, so production never drops past three times the excess from where
   * the breach began, and stops the moment a real drop did nothing for the phase.
   */
  private resolvePhaseFloorW(productionW: number, excessW: number, holding: boolean): number {
    if (excessW <= 0) {
      if (!holding) this.phaseEpisode = null;
      return 0;
    }
    const episode = this.advancePhaseEpisode(productionW, excessW);
    this.phaseEpisode = episode;
    if (episode.unresponsive) return productionW;
    return Math.max(0, episode.startProductionW - 3 * episode.maxExcessW);
  }

  private advancePhaseEpisode(productionW: number, excessW: number): PhaseExportEpisode {
    const episode = this.phaseEpisode;
    if (episode === null) {
      return {
        startProductionW: productionW,
        maxExcessW: excessW,
        lastProductionW: productionW,
        lastExcessW: excessW,
        unresponsive: false,
      };
    }
    const dropW = episode.lastProductionW - productionW;
    const stepped = dropW >= MIN_PRODUCTION_STEP_W;
    return {
      ...episode,
      maxExcessW: Math.max(episode.maxExcessW, excessW),
      lastProductionW: stepped ? productionW : episode.lastProductionW,
      lastExcessW: stepped ? excessW : episode.lastExcessW,
      unresponsive: episode.unresponsive
        || (stepped && episode.lastExcessW - excessW < dropW * MIN_PHASE_RESPONSE_SHARE),
    };
  }
}
