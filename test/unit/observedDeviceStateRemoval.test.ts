import { describe, expect, it } from 'vitest';
import type { ProjectedObservedDeviceState } from '../../packages/contracts/src/types';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import type { ObservedStateChangedEvent } from '../../lib/ports/observedStateEvents';

function observation(seq: number, powerKw = 0): Extract<ObservedStateChangedEvent, { removed?: never }> {
    const observed: ProjectedObservedDeviceState = {
        id: 'device', name: 'Device', available: true, targets: [],
        binaryControl: { on: true },
        measuredPowerKw: powerKw,
        measuredPowerIsDirectMeasurement: true,
        measuredPowerObservedAtMs: seq * 100,
    };
    return {
        source: 'realtime_capability', deviceId: observed.id,
        observationSeq: seq, observedAtMs: seq * 100, observed,
    };
}

function removal(seq: number): Extract<ObservedStateChangedEvent, { removed: true }> {
    return {
        source: 'device_update', deviceId: 'device', removed: true,
        observationSeq: seq, observedAtMs: seq * 100,
    };
}

describe('explicit observed device removal', () => {
    it('removes the record and draw history, advances revision, and leaves other devices untouched', () => {
        const projection = new ObservedDeviceStateProjection();
        projection.applyDelta(observation(1));
        projection.applyDelta(observation(2, 1));
        projection.applyDelta({
            source: 'device_update', deviceId: 'other', observationSeq: 1, observedAtMs: 150,
            observed: { id: 'other', name: 'Other', targets: [], available: true },
        });
        const other = projection.getObservedRecord('other');
        const revision = projection.getRevision();
        expect(projection.isLiveMeasuredDraw('device')).toBe(true);
        expect(projection.hasStartedDrawingSince('device', 150, 300, 0.5)).toBe(true);
        expect(projection.getLiveDrawAt('device', 200)).toBe(1);

        projection.applyDelta(removal(3));

        expect(projection.getObservedState('device')).toBeUndefined();
        expect(projection.getObservedRecord('device')).toBeUndefined();
        expect(projection.isLiveMeasuredDraw('device')).toBe(false);
        expect(projection.hasStartedDrawingSince('device', 150, 400, 0.5)).toBe(false);
        expect(projection.hasDrawnAtLeastSince('device', 150, 400, 0.5)).toBe(false);
        expect(projection.getLiveDrawAt('device', 400)).toBeNull();
        expect(projection.getRevision()).toBe(revision + 1);
        expect(projection.getObservedRecord('other')).toBe(other);
    });

    it('ignores out-of-order and duplicate removals', () => {
        const projection = new ObservedDeviceStateProjection();
        projection.applyDelta(observation(5, 1));
        const accepted = projection.getObservedRecord('device');
        const revision = projection.getRevision();

        projection.applyDelta(removal(4));
        expect(projection.getObservedRecord('device')).toBe(accepted);
        expect(projection.getRevision()).toBe(revision);

        projection.applyDelta(removal(6));
        projection.applyDelta(removal(6));
        projection.applyDelta(removal(5));
        expect(projection.getObservedRecord('device')).toBeUndefined();
        expect(projection.getRevision()).toBe(revision + 1);
    });

    it('rejects stale observations after removal and accepts newer recovery without old draw history', () => {
        const projection = new ObservedDeviceStateProjection();
        projection.applyDelta(observation(1));
        projection.applyDelta(observation(2, 1));
        projection.applyDelta(removal(4));
        const revision = projection.getRevision();

        projection.applyDelta({ ...observation(3, 2), observedAtMs: 900 });
        projection.applyDelta(observation(4, 2));
        projection.applyDelta({ ...observation(3, 2), observationSeq: undefined, observedAtMs: 300 });
        expect(projection.getObservedRecord('device')).toBeUndefined();
        expect(projection.getRevision()).toBe(revision);

        projection.applyDelta(observation(5, 1));
        expect(projection.getObservedRecord('device')?.binaryControl).toEqual({ on: true });
        expect(projection.isLiveMeasuredDraw('device')).toBe(true);
        expect(projection.getLiveDrawAt('device', 200)).toBeNull();
        expect(projection.hasStartedDrawingSince('device', 150, 600, 0.5)).toBe(false);
        expect(projection.getRevision()).toBe(revision + 1);

        projection.applyDelta(removal(4));
        expect(projection.getObservedRecord('device')).toBeDefined();
        expect(projection.getRevision()).toBe(revision + 1);
    });

    it('keeps metadata-only deltas without decided observations as no-ops', () => {
        const projection = new ObservedDeviceStateProjection();
        projection.applyDelta(observation(1));
        const accepted = projection.getObservedRecord('device');
        const revision = projection.getRevision();
        const metadata: ObservedStateChangedEvent = {
            source: 'device_update', deviceId: 'device', observationSeq: 100, observedAtMs: 10_000,
        };

        projection.applyDelta(metadata);
        expect(projection.getObservedRecord('device')).toBe(accepted);
        expect(projection.getRevision()).toBe(revision);

        projection.applyDelta(removal(2));
        projection.applyDelta(metadata);
        expect(projection.getObservedRecord('device')).toBeUndefined();
        expect(projection.getRevision()).toBe(revision + 1);

        projection.applyDelta(observation(3));
        expect(projection.getObservedRecord('device')).toBeDefined();
        expect(projection.getRevision()).toBe(revision + 2);
    });
});
