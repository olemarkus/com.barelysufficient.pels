import { beforeEach, describe, expect, it } from 'vitest';
import {
  EvCarLinkProducer,
  type EvCarLinkChargerView,
  type EvCarLinkEvent,
} from '../../lib/device/evCarLinkProducer';
import { createEmptyEvCarLinkSnapshot, getEvCarLinkVotes } from '../../lib/device/evCarLinkSnapshot';
import {
  EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
  EV_CAR_LINK_SELF_STOP_MIN_MS,
} from '../../lib/device/evCarLink';
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyDeviceLike } from '../../lib/utils/types';

/**
 * Drives the real producer through whole charging sessions. Only the two inputs
 * PELS actually has are simulated: the raw car device payload (official
 * capabilities only) and the resolved charger view the transport hands over.
 */
const carDevice = (params: {
  id?: string;
  name?: string;
  state?: string;
  socPct?: number;
}): HomeyDeviceLike => ({
  id: params.id ?? 'car-1',
  name: params.name ?? 'Polestar',
  class: 'car',
  capabilities: ['ev_charging_state', 'measure_battery'],
  capabilitiesObj: {
    ...(params.state === undefined ? {} : { ev_charging_state: { value: params.state } }),
    ...(params.socPct === undefined ? {} : { measure_battery: { value: params.socPct } }),
  },
} as unknown as HomeyDeviceLike);

const charger = (overrides: Partial<EvCarLinkChargerView> = {}): EvCarLinkChargerView => ({
  id: 'charger-1',
  name: 'Elbillader',
  evChargingState: 'plugged_out',
  measuredPowerW: 0,
  controlOn: false,
  reportedSocPct: null,
  ...overrides,
});

class Harness {
  events: EvCarLinkEvent[] = [];
  chargers: EvCarLinkChargerView[] = [charger()];
  snapshot: EvCarLinkSnapshot = createEmptyEvCarLinkSnapshot();
  readonly producer: EvCarLinkProducer;

  constructor() {
    this.producer = new EvCarLinkProducer({
      emit: (payload) => { this.events.push(payload); },
      getChargers: () => this.chargers,
      getSnapshot: () => this.snapshot,
      setSnapshot: (next) => { this.snapshot = next; },
    });
  }

  /** Push a car payload through the realtime seam. */
  car(device: HomeyDeviceLike, nowMs: number): void {
    this.producer.noteDeviceUpdate(device, nowMs);
  }

  /** Re-run correlation with the current charger views (the snapshot-refresh seam). */
  tick(nowMs: number): void {
    this.producer.observe([], { fullRefresh: true, nowMs });
  }

  setCharger(overrides: Partial<EvCarLinkChargerView>, id = 'charger-1'): void {
    this.chargers = this.chargers.map((entry) => (entry.id === id ? { ...entry, ...overrides } : entry));
  }

  of(event: EvCarLinkEvent['event']): EvCarLinkEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }
}

let h: Harness;
beforeEach(() => { h = new Harness(); });

/** Seed both sides with a first observation so later changes read as plug edges. */
const seedDisconnected = (harness: Harness, atMs: number): void => {
  harness.car(carDevice({ state: 'plugged_out', socPct: 40 }), atMs);
  harness.tick(atMs);
};

/**
 * A charger edge is only matched once a full coincidence window has elapsed, so
 * every link assertion has to advance past it. This mirrors production, where
 * the snapshot refresh ticks every ~10 s.
 */
const SETTLE_MS = EV_CAR_LINK_COINCIDENCE_WINDOW_MS + 1_000;

/** Plug the car in at `atMs` and advance past the settle window. */
const plugIn = (harness: Harness, atMs: number, socPct = 40): void => {
  harness.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
  harness.car(carDevice({ state: 'plugged_in_charging', socPct }), atMs);
  harness.tick(atMs + SETTLE_MS);
};

describe('linking a car to a charger', () => {
  it('links on a coincident plug-in and votes for the pair', () => {
    seedDisconnected(h, 0);
    plugIn(h, 10_000);

    expect(h.of('ev_car_link_candidate')).toHaveLength(1);
    const resolved = h.of('ev_car_link_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ carId: 'car-1', chargerId: 'charger-1', source: 'coincidence' });
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-1')).toBe(1);
  });

  it('does not link on a first observation after boot', () => {
    // No prior state on either side, so neither transition is a plug event.
    h.setCharger({ evChargingState: 'plugged_in_charging' });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 0);
    expect(h.of('ev_car_link_resolved')).toHaveLength(0);
    expect(h.of('ev_car_link_candidate')).toHaveLength(0);
  });

  it('reports ambiguity and votes for nobody when two cars plug in together', () => {
    h.car(carDevice({ id: 'car-A', state: 'plugged_out', socPct: 40 }), 0);
    h.car(carDevice({ id: 'car-B', state: 'plugged_out', socPct: 55 }), 0);
    h.tick(0);

    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000 });
    h.car(carDevice({ id: 'car-A', state: 'plugged_in_charging', socPct: 40 }), 5_000);
    h.car(carDevice({ id: 'car-B', state: 'plugged_in_charging', socPct: 55 }), 6_000);
    // Nothing may be decided before the window closes — that is what lets the
    // second car's edge count against an otherwise-confident first vote.
    expect(h.of('ev_car_link_candidate')).toHaveLength(0);
    h.tick(5_000 + SETTLE_MS);

    expect(h.of('ev_car_link_ambiguous')).toHaveLength(1);
    expect(getEvCarLinkVotes(h.snapshot, 'car-A', 'charger-1')).toBe(0);
    expect(getEvCarLinkVotes(h.snapshot, 'car-B', 'charger-1')).toBe(0);
  });

  it('reports a session elsewhere when the car plugs in with no charger edge', () => {
    seedDisconnected(h, 0);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 10_000);
    // Past the coincidence window, so "no match" is now a settled verdict.
    h.tick(10_000 + SETTLE_MS);

    const elsewhere = h.of('ev_car_session_elsewhere');
    expect(elsewhere).toHaveLength(1);
    expect(elsewhere[0]).toMatchObject({ carId: 'car-1', reason: 'no_charger_edge' });
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-1')).toBe(0);
  });

  it('never reports a linked session as charged elsewhere once its edge ages out', () => {
    // Regression: an "about to expire" sweep once reported EVERY aged connect
    // edge, including ones the matcher had already explained — so each
    // successful home session produced a phantom away session ~3 min later,
    // polluting the exact signal this probe exists to measure.
    seedDisconnected(h, 0);
    plugIn(h, 10_000);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
    h.tick(10_000 + EV_CAR_LINK_COINCIDENCE_WINDOW_MS * 2 + 10_000);
    expect(h.of('ev_car_session_elsewhere')).toHaveLength(0);
  });

  it('detects charging elsewhere from rising charge against an idle charger', () => {
    seedDisconnected(h, 0);
    plugIn(h, 10_000);
    // Charger goes idle but the car keeps gaining charge — it is on another plug.
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 44 }), 10_000 + SETTLE_MS + 10_000);

    expect(h.of('ev_car_session_elsewhere')).toEqual([
      expect.objectContaining({ reason: 'charger_idle_while_soc_rising' }),
    ]);
  });
});

describe('self-stop detection', () => {
  /** Link the pair and leave it charging; returns the time the link is live. */
  const linkAndCharge = (atMs: number): number => {
    seedDisconnected(h, 0);
    plugIn(h, atMs, 79);
    return atMs + SETTLE_MS;
  };

  it('reports the car stopping on its own once the dwell elapses', () => {
    const linkedAt = linkAndCharge(10_000);
    // Car reaches its own limit: connected, not charging, charger still live.
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in', socPct: 80 }), linkedAt + 10_000);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);

    h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
    const stopped = h.of('ev_car_self_stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({
      carId: 'car-1',
      chargerId: 'charger-1',
      subReason: 'car_not_charging',
      stoppedAtSocPct: 80,
    });
  });

  it('distinguishes the car holding on its own schedule', () => {
    const linkedAt = linkAndCharge(10_000);
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in_paused', socPct: 55 }), linkedAt + 10_000);
    h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
    expect(h.of('ev_car_self_stopped')[0]).toMatchObject({ subReason: 'car_schedule_hold' });
  });

  it('does not fire on a momentary zero mid-ramp', () => {
    const linkedAt = linkAndCharge(10_000);
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in', socPct: 60 }), linkedAt + 10_000);
    h.tick(linkedAt + 15_000);
    // Draw returns well inside the dwell window.
    h.setCharger({ measuredPowerW: 7_000 });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 61 }), linkedAt + 20_000);
    h.tick(linkedAt + 20_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);
  });

  it('reports once per episode, not once per tick', () => {
    const linkedAt = linkAndCharge(10_000);
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in', socPct: 80 }), linkedAt + 10_000);
    const firstReport = linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS;
    h.tick(firstReport);
    h.tick(firstReport + 60_000);
    h.tick(firstReport + 120_000);
    expect(h.of('ev_car_self_stopped')).toHaveLength(1);
  });

  it('accumulates the stop charge level across sessions as an observed limit', () => {
    const runSession = (startMs: number, stopSocPct: number): void => {
      h.setCharger({ evChargingState: 'plugged_out', measuredPowerW: 0, controlOn: false });
      h.car(carDevice({ state: 'plugged_out', socPct: 40 }), startMs);
      h.tick(startMs);
      plugIn(h, startMs + 10_000);
      const linkedAt = startMs + 10_000 + SETTLE_MS;
      h.setCharger({ measuredPowerW: 0 });
      h.car(carDevice({ state: 'plugged_in', socPct: stopSocPct }), linkedAt + 10_000);
      h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
    };
    runSession(0, 80);
    runSession(1_000_000, 79.8);

    const stops = h.of('ev_car_self_stopped');
    expect(stops).toHaveLength(2);
    // Second session can name a candidate limit; a tight spread is what makes it
    // trustworthy, and it is reported alongside.
    expect(stops[1]).toMatchObject({ observedLimitPct: 79.9, observedLimitSamples: 2 });
    expect(stops[1]).toMatchObject({ observedLimitSpreadPct: 0.2 });
  });
});

describe('state-of-charge shadow', () => {
  it('reports the car reading against the flow-card value without adopting it', () => {
    seedDisconnected(h, 0);
    h.setCharger({ reportedSocPct: 71 });
    plugIn(h, 10_000);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 74 }), 10_000 + SETTLE_MS + 5_000);

    const shadow = h.of('ev_car_link_soc_shadow');
    expect(shadow).toHaveLength(1);
    expect(shadow[0]).toMatchObject({
      carSocPct: 74, reportedSocPct: 71, deltaPct: 3, wouldAdopt: true,
    });
    // The probe must never write the charger's state-of-charge.
    expect(h.chargers[0].reportedSocPct).toBe(71);
  });

  it('says nothing while no link is established', () => {
    seedDisconnected(h, 0);
    h.car(carDevice({ state: 'plugged_out', socPct: 62 }), 10_000);
    expect(h.of('ev_car_link_soc_shadow')).toHaveLength(0);
  });
});

describe('session lifecycle', () => {
  it('forgets the session link on unplug but keeps the affinity votes', () => {
    seedDisconnected(h, 0);
    plugIn(h, 10_000);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
    const linkedAt = 10_000 + SETTLE_MS;

    h.setCharger({ evChargingState: 'plugged_out', measuredPowerW: 0, controlOn: false });
    h.car(carDevice({ state: 'plugged_out', socPct: 80 }), linkedAt + 10_000);

    // Votes survive the session; a later charge reading no longer shadows.
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-1')).toBeGreaterThanOrEqual(1);
    const before = h.of('ev_car_link_soc_shadow').length;
    h.car(carDevice({ state: 'plugged_out', socPct: 81 }), linkedAt + 20_000);
    expect(h.of('ev_car_link_soc_shadow')).toHaveLength(before);
  });

  it('ignores devices that are not cars', () => {
    const thermostat = {
      id: 'thermo', name: 'Stue', class: 'thermostat', capabilities: [], capabilitiesObj: {},
    } as unknown as HomeyDeviceLike;
    h.producer.noteDeviceUpdate(thermostat, 0);
    expect(h.producer.isCarDevice('thermo')).toBe(false);
    expect(h.events).toHaveLength(0);
  });
});
