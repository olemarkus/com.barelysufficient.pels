import {
  PhaseCurrentMonitor,
  isPhaseCurrentAbove,
  phaseCurrentWatchKey,
  type PhaseCurrentCrossing,
  type PhaseCurrentLimit,
  type PhaseCurrentWatch,
} from '../lib/power/phaseCurrentMonitor';
import { directionalPhaseAmps, type PhaseReadingTracker } from '../lib/power/phaseReading';
import type { PhaseMeter } from '../lib/power/mainFusePhaseSource';
import { normalizeError } from '../lib/utils/errorUtils';
import type { ConfigurableFlowTriggerCard, FlowManagerLike } from '../lib/utils/types';
import type { Logger } from '../lib/logging/logger';
import { readFlowNumberArg, readFlowStringArg } from './flowArgParsers';

function readLimit(args: unknown): PhaseCurrentLimit | null {
  const phase = readFlowStringArg(args, 'phase');
  const direction = readFlowStringArg(args, 'direction');
  const limitA = readFlowNumberArg(args, 'amps');
  if (phase !== 'any' && phase !== 'L1' && phase !== 'L2' && phase !== 'L3') return null;
  if (direction !== 'import' && direction !== 'export') return null;
  if (limitA === null || limitA < 1 || limitA > 250) return null;
  return { phase, direction, limitA };
}

function readWatch(args: unknown): PhaseCurrentWatch | null {
  const limit = readLimit(args);
  const holdSeconds = readFlowNumberArg(args, 'seconds');
  if (limit === null || holdSeconds === null || !Number.isInteger(holdSeconds)) return null;
  if (holdSeconds < 0 || holdSeconds > 600) return null;
  return { ...limit, holdSeconds };
}

async function readWatches(card: ConfigurableFlowTriggerCard): Promise<PhaseCurrentWatch[] | null> {
  const args = await card.getArgumentValues();
  if (!Array.isArray(args)) return null;
  return args.flatMap((raw) => {
    const watch = readWatch(raw);
    return watch === null ? [] : [watch];
  });
}

async function dispatch(card: ConfigurableFlowTriggerCard, crossing: PhaseCurrentCrossing): Promise<void> {
  const { watch, load, elapsedSeconds } = crossing;
  await card.trigger({
    phase: load.phase,
    current_a: directionalPhaseAmps(load, watch.direction),
    power_kw: load.kw,
    direction: watch.direction,
    duration_seconds: elapsedSeconds,
  }, { watch_key: phaseCurrentWatchKey(watch) });
}

function watchCard(
  card: ConfigurableFlowTriggerCard,
  edge: PhaseCurrentCrossing['edge'],
  monitor: PhaseCurrentMonitor,
  logger: Logger,
): void {
  const refresh = () => {
    void monitor.refresh(edge, () => readWatches(card)).catch((error) => {
      logger.error({ event: 'phase_current_flows_read_failed', edge, err: normalizeError(error) });
    });
  };
  card.on('update', refresh);
  refresh();
}

export function registerPhaseCurrentCards(
  flow: FlowManagerLike,
  tracker: PhaseReadingTracker | undefined,
  readMeter: () => PhaseMeter | null,
  getNow: () => Date,
  logger: Logger,
): void {
  flow.getConditionCard('phase_current_above').registerRunListener(async (args) => {
    const limit = readLimit(args);
    if (limit === null) throw new Error('Choose a phase, a direction and a limit from 1 to 250 A.');
    const reading = tracker?.currentFrom(readMeter()) ?? { kind: 'none' };
    return isPhaseCurrentAbove(reading, limit, getNow().getTime());
  });

  const cards = {
    above: flow.getTriggerCard('phase_current_went_above'),
    back_below: flow.getTriggerCard('phase_current_went_back_below'),
  };
  for (const card of Object.values(cards)) {
    card.registerRunListener(async (args, state) => {
      const watch = readWatch(args);
      return watch !== null && readFlowStringArg(state, 'watch_key') === phaseCurrentWatchKey(watch);
    });
  }
  if (tracker === undefined) return;

  const monitor = new PhaseCurrentMonitor((crossing) => {
    void dispatch(cards[crossing.edge], crossing).catch((error) => {
      logger.error({ event: 'phase_current_flow_trigger_failed', edge: crossing.edge, err: normalizeError(error) });
    });
  });
  watchCard(cards.above, 'above', monitor, logger);
  watchCard(cards.back_below, 'back_below', monitor, logger);
  tracker.subscribe((event) => {
    if (event.kind === 'source_reset') monitor.reset();
    else monitor.observe(event.reading);
  });
}
