/**
 * Realtime handling of an integration's acknowledged-current event
 * (`ACKNOWLEDGED_CURRENT_CAPABILITY_ID`): the device echoed the current it
 * accepted as its setting. It updates only the held snapshot's
 * `acknowledgedStep`, dated on arrival, and dispatches the observation. It is
 * not a reported step, so it moves neither the settled rung nor device
 * freshness.
 *
 * NOT in the Homey-SDK-leaf allowlist — must stay homey-free.
 */
import { ACKNOWLEDGED_CURRENT_CAPABILITY_ID } from '../deviceAdapter';
import { resolveAcknowledgedCurrentStepId } from '../acknowledgedStep';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { dispatchRealtimeObservation } from './realtimeCapabilityShared';
import type { RealtimeIngestService } from './transportServices';

/** True when the event was an acknowledged current, consumed here whether or not it named a step. */
export function handleAcknowledgedCurrentUpdate(
    ingest: RealtimeIngestService,
    snapshot: TransportDeviceSnapshot,
    capabilityId: string,
    value: unknown,
): boolean {
    if (capabilityId !== ACKNOWLEDGED_CURRENT_CAPABILITY_ID) return false;
    const stepId = resolveAcknowledgedCurrentStepId(snapshot.targetPowerConfig, value);
    if (stepId === undefined || !snapshot.steppedLoadProfile) return true;
    // Transport owns the held snapshot and updates it before dispatch.
    // eslint-disable-next-line functional/immutable-data, no-param-reassign
    snapshot.acknowledgedStep = { stepId, observedAtMs: Date.now() };
    ingest.publishDeviceConfiguration(snapshot.id);
    dispatchRealtimeObservation(ingest, snapshot.id, capabilityId);
    return true;
}
