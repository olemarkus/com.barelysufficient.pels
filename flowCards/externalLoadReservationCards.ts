import { normalizeError } from '../lib/utils/errorUtils';
import type { FlowManagerLike } from '../lib/utils/types';
import type { Logger } from '../lib/logging/logger';
import type { ExternalLoadReservation, ExternalLoadReservations } from '../lib/power/externalLoadReservations';
import { readFlowNumberArg, readFlowStringArg } from './flowArgParsers';

const READY = 'external_load_capacity_ready';

export function registerExternalLoadReservationCards(
  flow: FlowManagerLike,
  reservations: ExternalLoadReservations,
  nowMs: () => number,
  logger: Logger,
): void {
  flow.getActionCard('reserve_external_load_capacity').registerRunListener((args) => {
    reservations.reserve(
      readFlowStringArg(args, 'load'),
      readFlowNumberArg(args, 'watts'),
      readFlowNumberArg(args, 'minutes'),
      nowMs(),
    );
    return true;
  });
  flow.getActionCard('release_external_load_capacity').registerRunListener((args) => {
    reservations.release(readFlowStringArg(args, 'load'), nowMs());
    return true;
  });
  const card = flow.getTriggerCard(READY);
  card.registerRunListener((args, state) => {
    const load = readFlowStringArg(state, 'load');
    return load !== '' && load === readFlowStringArg(args, 'load');
  });
  const trigger = async ({ name, powerW }: ExternalLoadReservation): Promise<void> => {
    await card.trigger?.({ load: name, watts: powerW }, { load: name });
  };
  reservations.onReady((reservation) => {
    void trigger(reservation).catch((error) => {
      logger.error({ event: 'external_load_capacity_ready_trigger_failed', err: normalizeError(error) });
    });
  });
}
