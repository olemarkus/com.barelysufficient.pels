import type { MeteredRunCommitment, PersistedMeteredDeliveryState } from './planHistoryMeteredState';
import type { InProgressCommitment, InProgressRecord } from './planHistoryInProgressState';
import { appendHourlyContribution } from './planHistoryV4Helpers';
import { mergeHourStartBookings } from './planHistoryHourStartBookings';

/**
 * An in-progress run across a restart: the row the recorder (`planHistory.ts`)
 * saves for it, and how a saved row merges back into the live run, on the run's
 * first tick after a restart or when a failed boot read recovers. Saving and
 * resuming the commitment live together here so the two stay mirrors.
 */

// The commitment as saved. A run still learning, undelivered, with a trusted
// start is saved as learning and carries that start as its anchor; a resumed
// run keeps the anchor it was restored with, so a second restart resumes it the
// same way.
//
// Otherwise a learning run is saved as unknown. With delivery, that is what
// `backfillCommitment` decides on the next plannable tick anyway, and it keeps
// the row readable by an older build, whose validator rejects `learning` and
// deletes the row with its delivery. With no trusted start, nothing could show
// after the restart that the run stood still while PELS was down, and a start
// adopted after the restart would measure only from the restart.
const toPersistedCommitment = (record: InProgressRecord): MeteredRunCommitment => {
  const { commitment } = record;
  if (commitment.kind === 'known' || commitment.kind === 'unknown') return commitment;
  const startProgressValue = commitment.kind === 'resumed_learning'
    ? commitment.startProgressValue
    : record.startProgressValue;
  if (record.deliveredKWh > 0 || startProgressValue === null) return { kind: 'unknown' };
  return { kind: 'learning', startProgressValue };
};

// The commitment a restored run resumes with. Known and unknown stay as saved;
// a run saved while learning keeps learning under the restart gate, anchored at
// the start progress it had before the restart.
const resumeSavedCommitment = (state: PersistedMeteredDeliveryState): InProgressCommitment => (
  state.commitment.kind === 'learning'
    ? { kind: 'resumed_learning', startProgressValue: state.commitment.startProgressValue }
    : state.commitment
);

export const toPersistedMeteredDeliveryState = (record: InProgressRecord): PersistedMeteredDeliveryState => ({
  deviceId: record.deviceId,
  deadlineAtMs: record.deadlineAtMs,
  startedAtMs: record.startedAtMs,
  deliveryEvidence: record.deliveryEvidence,
  commitment: toPersistedCommitment(record),
  startProgressValue: record.startProgressValue,
  deliveredKWh: record.deliveredKWh,
  totalCost: record.totalCost,
  costDisplay: record.costDisplay,
  deliveryPriceComplete: record.deliveryPriceComplete,
  hourlyContributions: record.hourlyContributions.slice(),
  hourStartBookings: record.hourStartBookings.slice(),
});

// Merges a saved run into the live record for the same task. The saved values
// win where both sides hold one: the run's start, its start reading, its
// commitment, its hour-start bookings. Delivery and cost add up; the downtime
// between the two is never billed.
export const mergeSavedRun = (
  record: InProgressRecord,
  state: PersistedMeteredDeliveryState,
): InProgressRecord => {
  let hourlyContributions = state.hourlyContributions.slice();
  for (const contribution of record.hourlyContributions) {
    hourlyContributions = appendHourlyContribution(hourlyContributions, contribution);
  }
  return {
    ...record,
    startedAtMs: Math.min(record.startedAtMs, state.startedAtMs),
    // The run began where it stood before the restart, not at the first
    // reading after it. A run saved before any trusted reading keeps the
    // live record's own first trusted reading.
    startProgressValue: state.startProgressValue ?? record.startProgressValue,
    deliveryEvidence: { ...state.deliveryEvidence, nonDelivery: { kind: 'none' } },
    commitment: resumeSavedCommitment(state),
    deliveredKWh: state.deliveredKWh + record.deliveredKWh,
    totalCost: state.totalCost + record.totalCost,
    costDisplay: state.costDisplay ?? record.costDisplay,
    hasDeliveryContribution: true,
    deliveryPriceComplete: state.deliveryPriceComplete && record.deliveryPriceComplete,
    hourlyContributions,
    hourStartBookings: mergeHourStartBookings(state.hourStartBookings, record.hourStartBookings),
  };
};
