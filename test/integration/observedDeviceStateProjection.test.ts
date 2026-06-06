import { DeviceTransport } from '../../lib/device/deviceTransport';
import { ObservedStateEmitter } from '../../lib/observer/observedStateEvents';
import { ObservedHomePower } from '../../lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from '../../lib/observer/observedDeviceStateProjection';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import {
    createBinarySettleState,
    clearAllPendingBinarySettleWindows,
    clearPendingBinarySettleWindow,
    hasPendingBinarySettleWindow,
    notePendingBinarySettleObservation,
    startPendingBinarySettleWindow,
} from '../../lib/observer/binarySettle';
import type { DeviceTransportBinarySettleOps } from '../../lib/device/deviceTransport';
import type { LiveFeedHealth } from '../../lib/device/liveFeed';
import type {
    ObservedStateChangedEvent,
    ObservedStateRefreshEvent,
} from '../../lib/observer/observedStateEvents';
import { mockHomeyInstance } from '../mocks/homey';
import Homey from 'homey';
import * as homeyApi from '../../lib/device/transport/managerHomeyApi';

// Stub the live feed so the transport never opens a real socket.io connection.
// This is an OUTWARD Homey SDK seam, not a PELS internal — the merge, the
// emitter, and the projection all run for real per the deferred-objective e2e
// rule (AGENTS.md: drive the SDK boundary, never mock PELS internals).
vi.mock('../../lib/device/liveFeed', () => {
    const mockHealth: LiveFeedHealth = {
        subscriptionState: 'subscribed',
        lastLiveEventMs: null,
        liveEventCount: 0,
        ignoredLiveEventCount: 0,
        reconnectCount: 0,
        lastReconnectMs: null,
        lastSuccessfulSubscriptionMs: null,
    };
    return {
        createDeviceLiveFeed: vi.fn(() => ({
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined),
            isHealthy: vi.fn().mockReturnValue(true),
            getHealth: vi.fn().mockReturnValue(mockHealth),
            updateTrackedDevices: vi.fn(),
        })),
    };
});

const mockApiGet = vi.fn();
const mockApiPut = vi.fn().mockResolvedValue(undefined);
const mockGetLiveReport = vi.fn();

function realBinarySettle() {
    const state = createBinarySettleState();
    const ops: DeviceTransportBinarySettleOps = {
        start: startPendingBinarySettleWindow,
        note: notePendingBinarySettleObservation,
        hasWindow: hasPendingBinarySettleWindow,
        clear: clearPendingBinarySettleWindow,
        clearAll: clearAllPendingBinarySettleWindows,
    };
    return { binarySettleState: state, binarySettleOps: ops };
}

type Harness = {
    transport: DeviceTransport;
    projection: ObservedDeviceStateProjection;
};

async function buildHarness(): Promise<Harness> {
    const loggerMock = {
        log: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        structuredLog: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
    };
    const emitter = new ObservedStateEmitter();
    const projection = new ObservedDeviceStateProjection();
    // Subscribe the projection to the emitter exactly as app.ts wiring does.
    emitter.onObservedStateChanged((event) => projection.applyDelta(event));
    emitter.onObservedStateRefresh((event) => projection.applyRefresh(event));

    const transport = new DeviceTransport(
        mockHomeyInstance as unknown as Homey.App,
        loggerMock,
        undefined,
        undefined,
        {
            ...realBinarySettle(),
            observedStateDispatcher: emitter.asDispatcher(new ObservedHomePower()),
        },
    );
    await transport.init();
    return { transport, projection };
}

const device = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    class: 'heater',
    capabilities: ['measure_power', 'onoff'],
    capabilitiesObj: {
        measure_power: { value: 1000, id: 'measure_power' },
        onoff: { value: false, id: 'onoff', lastUpdated: '2026-03-20T05:00:00.000Z' },
        ...(overrides.capabilitiesObj as Record<string, unknown> ?? {}),
    },
    ...overrides,
});

function onoffDevice(id: string, value: boolean, lastUpdated: string) {
    return device(id, {
        capabilitiesObj: {
            measure_power: { value: 1000, id: 'measure_power' },
            onoff: { value, id: 'onoff', lastUpdated },
        },
    });
}

function assertShadowEquality(harness: Harness): void {
    for (const snapshot of harness.transport.getSnapshot()) {
        expect(harness.projection.getObservedState(snapshot.id)).toEqual(
            projectObservedState(harness.transport.getSnapshotByDeviceId(snapshot.id)!),
        );
    }
}

describe('ObservedDeviceStateProjection (stage 4a shadow)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetLiveReport.mockResolvedValue({ items: [] });
        vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(mockApiGet);
        vi.spyOn(mockHomeyInstance.api, 'put').mockImplementation(mockApiPut);
        vi.spyOn(homeyApi, 'getEnergyLiveReport').mockImplementation(() => mockGetLiveReport());
    });

    it('cold-start: serves nothing until the first refresh, then seeds the merged value', async () => {
        const h = await buildHarness();
        expect(h.projection.getObservedState('dev1')).toBeUndefined();

        mockApiGet.mockResolvedValue({ dev1: onoffDevice('dev1', true, '2026-03-20T06:00:00.000Z') });
        await h.transport.refreshSnapshot();

        const seeded = h.projection.getObservedState('dev1');
        expect(seeded).toBeDefined();
        expect(seeded?.binaryControl?.on).toBe(true);
        assertShadowEquality(h);
        h.transport.destroy();
    });

    it('shadow-equals the snapshot after an arbitrary refresh + realtime sequence', async () => {
        const h = await buildHarness();
        mockApiGet.mockResolvedValue({
            dev1: onoffDevice('dev1', false, '2026-03-20T06:00:00.000Z'),
            dev2: onoffDevice('dev2', true, '2026-03-20T06:00:00.000Z'),
        });
        await h.transport.refreshSnapshot();

        // Realtime deltas through the real merge.
        h.transport.injectCapabilityUpdateForTest('dev1', 'onoff', true);
        h.transport.injectCapabilityUpdateForTest('dev2', 'measure_power', 2500);
        h.transport.injectDeviceUpdateForTest({
            id: 'dev1',
            name: 'dev1',
            class: 'heater',
            capabilities: ['measure_power', 'onoff'],
            capabilitiesObj: { measure_power: { value: 1750, id: 'measure_power' } },
        });

        // A second refresh on top.
        mockApiGet.mockResolvedValue({
            dev1: onoffDevice('dev1', true, '2026-03-20T07:00:00.000Z'),
            dev2: onoffDevice('dev2', false, '2026-03-20T07:00:00.000Z'),
        });
        await h.transport.refreshSnapshot();

        assertShadowEquality(h);
        h.transport.destroy();
    });

    it('realtime delta survives between two refreshes', async () => {
        const h = await buildHarness();
        mockApiGet.mockResolvedValue({ dev1: onoffDevice('dev1', false, '2026-03-20T06:00:00.000Z') });
        await h.transport.refreshSnapshot();
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(false);

        h.transport.injectCapabilityUpdateForTest('dev1', 'onoff', true);
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(true);
        assertShadowEquality(h);
        h.transport.destroy();
    });

    it('refresh-then-realtime interleave: an older refresh read never rolls back a fresher realtime on-state', async () => {
        const h = await buildHarness();
        // Seed currentOn=false.
        mockApiGet.mockResolvedValue({ dev1: onoffDevice('dev1', false, '2026-03-20T06:00:00.000Z') });
        await h.transport.refreshSnapshot();
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(false);

        // Realtime turns it on.
        h.transport.injectCapabilityUpdateForTest('dev1', 'onoff', true);
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(true);

        // A refresh whose SDK read is OLDER than the realtime event. Transport's
        // fresher-wins keeps currentOn=true, so Event A carries true and the
        // projection stays true (no rollback).
        mockApiGet.mockResolvedValue({ dev1: onoffDevice('dev1', false, '2026-03-20T05:30:00.000Z') });
        await h.transport.refreshSnapshot();

        expect(h.transport.getSnapshotByDeviceId('dev1')?.binaryControl?.on).toBe(true);
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(true);
        assertShadowEquality(h);
        h.transport.destroy();
    });

    it('abandon-grace: a transient empty read defers commit, fires no refresh event, and retains prior values', async () => {
        const h = await buildHarness();
        mockApiGet.mockResolvedValue({ dev1: onoffDevice('dev1', true, '2026-03-20T06:00:00.000Z') });
        await h.transport.refreshSnapshot();
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(true);

        // Empty raw read within the grace window → commit deferred → no Event A.
        mockApiGet.mockResolvedValue({});
        await h.transport.refreshSnapshot();

        expect(h.transport.getSnapshot()).toHaveLength(1);
        expect(h.projection.getObservedState('dev1')?.binaryControl?.on).toBe(true);
        h.transport.destroy();
    });

    it('vanished-device prune: a device absent from a later refresh stops being served', async () => {
        const h = await buildHarness();
        mockApiGet.mockResolvedValue({
            dev1: onoffDevice('dev1', true, '2026-03-20T06:00:00.000Z'),
            dev2: onoffDevice('dev2', true, '2026-03-20T06:00:00.000Z'),
        });
        await h.transport.refreshSnapshot();
        expect(h.projection.getObservedState('dev2')).toBeDefined();

        mockApiGet.mockResolvedValue({ dev1: onoffDevice('dev1', true, '2026-03-20T07:00:00.000Z') });
        await h.transport.refreshSnapshot();

        expect(h.projection.getObservedState('dev1')).toBeDefined();
        expect(h.projection.getObservedState('dev2')).toBeUndefined();
        assertShadowEquality(h);
        h.transport.destroy();
    });

    it('targets aliasing: mutating transport snapshot targets[].value does not change the stored projection', async () => {
        const h = await buildHarness();
        mockApiGet.mockResolvedValue({
            dev1: device('dev1', {
                class: 'thermostat',
                capabilities: ['measure_temperature', 'target_temperature', 'onoff'],
                capabilitiesObj: {
                    onoff: { value: true, id: 'onoff', lastUpdated: '2026-03-20T06:00:00.000Z' },
                    measure_temperature: { value: 20, id: 'measure_temperature', units: '°C' },
                    target_temperature: { value: 21, id: 'target_temperature', units: '°C' },
                },
            }),
        });
        await h.transport.refreshSnapshot();

        const storedBefore = h.projection.getObservedState('dev1');
        const storedTarget = storedBefore?.targets.find((t) => t.id === 'target_temperature');
        expect(storedTarget?.value).toBe(21);

        // Mutate transport's snapshot target value in place (transport does this
        // during its merge). The projection's deep copy must be unaffected.
        const liveSnapshot = h.transport.getSnapshotByDeviceId('dev1')!;
        const liveTarget = liveSnapshot.targets.find((t) => t.id === 'target_temperature');
        expect(liveTarget).toBeDefined();
        liveTarget!.value = 99;

        expect(h.projection.getObservedState('dev1')?.targets.find((t) => t.id === 'target_temperature')?.value)
            .toBe(21);
        h.transport.destroy();
    });
});

// Unit-level guard tests for the sequenced idempotent apply. These exercise the
// projection's ordering contract directly (the guard is pure logic), feeding it
// hand-shaped events — no transport needed for ordering/dedup semantics.
describe('ObservedDeviceStateProjection apply guard', () => {
    const baseObserved = (id: string, currentOn: boolean) => ({
        id,
        name: id,
        targets: [],
        binaryControl: { on: currentOn },
    });

    const delta = (seq: number, currentOn: boolean, observedAtMs?: number): ObservedStateChangedEvent => ({
        source: 'realtime_capability',
        deviceId: 'dev1',
        observationSeq: seq,
        observedAtMs,
        observed: baseObserved('dev1', currentOn),
    });

    it('drops a defensive delta with no decided value attached', () => {
        const p = new ObservedDeviceStateProjection();
        p.applyDelta({ source: 'device_update', deviceId: 'dev1' });
        expect(p.getObservedState('dev1')).toBeUndefined();
    });

    it('replay-out-of-order: 1,3,2 settles on seq 3 and a later seq-2 replay is dropped', () => {
        const p = new ObservedDeviceStateProjection();
        p.applyDelta(delta(1, false));
        p.applyDelta(delta(3, true));
        p.applyDelta(delta(2, false)); // out of order → dropped
        expect(p.getObservedState('dev1')?.binaryControl?.on).toBe(true);

        p.applyDelta(delta(2, false)); // duplicate replay of an earlier seq → still dropped
        expect(p.getObservedState('dev1')?.binaryControl?.on).toBe(true);
    });

    it('dedup: applying the identical seq twice is a no-op', () => {
        const p = new ObservedDeviceStateProjection();
        p.applyDelta(delta(5, true));
        const first = p.getObservedState('dev1');
        p.applyDelta(delta(5, false)); // same seq → dropped, value unchanged
        expect(p.getObservedState('dev1')).toBe(first);
        expect(p.getObservedState('dev1')?.binaryControl?.on).toBe(true);
    });

    it('observedAtMs fallback applies only when a seq is absent on either side', () => {
        const p = new ObservedDeviceStateProjection();
        // First with no seq, older timestamp.
        p.applyDelta({ source: 'device_update', deviceId: 'dev1', observedAtMs: 200, observed: baseObserved('dev1', true) });
        // Newer timestamp, still no seq → accepted.
        p.applyDelta({ source: 'device_update', deviceId: 'dev1', observedAtMs: 300, observed: baseObserved('dev1', false) });
        expect(p.getObservedState('dev1')?.binaryControl?.on).toBe(false);
        // Older timestamp, no seq → dropped.
        p.applyDelta({ source: 'device_update', deviceId: 'dev1', observedAtMs: 100, observed: baseObserved('dev1', true) });
        expect(p.getObservedState('dev1')?.binaryControl?.on).toBe(false);
    });

    it('refresh prunes devices absent from the batch', () => {
        const p = new ObservedDeviceStateProjection();
        const refresh = (ids: string[]): ObservedStateRefreshEvent => ({
            entries: ids.map((id, index) => ({
                observationSeq: index + 1,
                observedAtMs: 1000 + index,
                observed: baseObserved(id, true),
            })),
        });
        p.applyRefresh(refresh(['dev1', 'dev2']));
        expect(p.getAllObservedStates().map((o) => o.id).sort()).toEqual(['dev1', 'dev2']);
        p.applyRefresh(refresh(['dev1']));
        expect(p.getObservedState('dev2')).toBeUndefined();
        expect(p.getObservedState('dev1')).toBeDefined();
    });
});
