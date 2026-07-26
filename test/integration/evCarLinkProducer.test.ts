import { beforeEach, describe, expect, it } from 'vitest';
import {
  EvCarLinkProducer,
  type EvCarLinkChargerView,
  type EvCarLinkEvent,
} from '../../lib/device/evCarLinkProducer';
import { createEmptyEvCarLinkSnapshot, getEvCarLinkVotes } from '../../lib/device/evCarLinkSnapshot';
import {
  EV_CAR_LINK_AWAY_VERDICT_MS,
  EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
  EV_CAR_LINK_MIN_PRIOR_VOTES,
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
  /** Capability `lastUpdated`, so a stale fetch can be modelled explicitly. */
  observedAtMs?: number;
  socObservedAtMs?: number;
}): HomeyDeviceLike => ({
  id: params.id ?? 'car-1',
  name: params.name ?? 'Polestar',
  class: 'car',
  capabilities: ['ev_charging_state', 'measure_battery'],
  capabilitiesObj: {
    ...(params.state === undefined ? {} : {
      ev_charging_state: {
        value: params.state,
        ...(params.observedAtMs === undefined ? {} : { lastUpdated: params.observedAtMs }),
      },
    }),
    ...(params.socPct === undefined ? {} : {
      measure_battery: {
        value: params.socPct,
        ...(params.socObservedAtMs === undefined ? {} : { lastUpdated: params.socObservedAtMs }),
      },
    }),
  },
} as unknown as HomeyDeviceLike);

const charger = (overrides: Partial<EvCarLinkChargerView> = {}): EvCarLinkChargerView => ({
  id: 'charger-1',
  name: 'Elbillader',
  evChargingState: 'plugged_out',
  measuredPowerW: 0,
  controlOn: false,
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

  /** Push a car payload through the realtime device-update seam. */
  car(device: HomeyDeviceLike, nowMs: number): void {
    this.producer.noteDeviceUpdate(device, nowMs);
  }

  /** Push a single capability VALUE change — how realtime changes really arrive. */
  cap(deviceId: string, capabilityId: string, value: unknown, nowMs: number): void {
    this.producer.noteCapabilityUpdate(deviceId, capabilityId, value, nowMs);
  }

  /**
   * Advance time and re-correlate. NOT a full read: an authoritative full read
   * carrying no devices means "this home has no cars" and legitimately prunes
   * membership, which is not what advancing the clock means.
   */
  tick(nowMs: number): void {
    this.producer.tick(nowMs);
  }

  setCharger(overrides: Partial<EvCarLinkChargerView>, id = 'charger-1'): void {
    this.chargers = this.chargers.map((entry) => (entry.id === id ? { ...entry, ...overrides } : entry));
  }

  of(event: EvCarLinkEvent['event']): EvCarLinkEvent[] {
    return this.events.filter((entry) => entry.event === event);
  }

  /** Narrowed accessor so self-stop assertions read the variant's own fields. */
  selfStops(): Extract<EvCarLinkEvent, { event: 'ev_car_self_stopped' }>[] {
    return this.events.flatMap((entry) => (entry.event === 'ev_car_self_stopped' ? [entry] : []));
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
    // Past the AWAY verdict age, so "no match" is now settled.
    h.tick(10_000 + EV_CAR_LINK_AWAY_VERDICT_MS + 1_000);

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

  it('waits for a lagging charger edge to settle before calling an away session', () => {
    // Car connects at t=0, its charger reports 20 s later. At one window the
    // charger edge has not settled yet — reporting an away session there would
    // contradict the link that forms moments later, purely from event-ordering
    // jitter that any real integration exhibits.
    seedDisconnected(h, 0);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.tick(20_000);

    h.tick(EV_CAR_LINK_COINCIDENCE_WINDOW_MS + 5_000);
    expect(h.of('ev_car_session_elsewhere')).toHaveLength(0);

    h.tick(20_000 + EV_CAR_LINK_COINCIDENCE_WINDOW_MS + 1_000);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
    expect(h.of('ev_car_session_elsewhere')).toHaveLength(0);
  });

  it('refuses to vote when one car edge fits two chargers', () => {
    // One physical car cannot be on two chargers, so the edge identifies
    // neither — voting for both would corrupt the affinity map.
    h.chargers = [charger(), charger({ id: 'charger-2', name: 'Garasje' })];
    seedDisconnected(h, 0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true }, 'charger-2');
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 10_000);
    h.tick(10_000 + SETTLE_MS);

    expect(h.of('ev_car_link_resolved')).toHaveLength(0);
    expect(h.of('ev_car_link_ambiguous').length).toBeGreaterThan(0);
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-1')).toBe(0);
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-2')).toBe(0);
  });

  it('refuses to vote when a second charger connects late enough to contest the car edge', () => {
    // Regression: settling only the CHARGER edge left a hole. Charger A settles
    // one window after its own edge, which can be BEFORE the window around the
    // car edge has closed — so A was finalized with a persisted vote, and the
    // contest that appeared when B connected moments later could no longer
    // retract it. The two-car household this probe has to survive.
    h.chargers = [charger({ id: 'charger-A' }), charger({ id: 'charger-B', name: 'Garasje' })];
    h.car(carDevice({ state: 'plugged_out', socPct: 40 }), 0);
    h.tick(0);

    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true }, 'charger-A');
    h.tick(1_000);
    // Car edge lands just inside A's window, so A alone looks coincident.
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 90_000);
    h.tick(91_500);
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-A')).toBe(0);

    // B connects while the car edge could still be contested.
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true }, 'charger-B');
    h.tick(95_000);
    h.tick(90_000 + EV_CAR_LINK_COINCIDENCE_WINDOW_MS + 5_000);

    expect(h.of('ev_car_link_ambiguous').length).toBeGreaterThan(0);
    expect(h.of('ev_car_link_resolved')).toHaveLength(0);
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-A')).toBe(0);
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-B')).toBe(0);
  });

  it('ends the session on a car-side disconnect even when the charger view is stale', () => {
    // Regression: only a charger-side disconnect cleared the link. If the
    // charger's update was missed the link survived, and every later charge
    // reading was still shadowed against a charger the car had left.
    seedDisconnected(h, 0);
    plugIn(h, 10_000);
    const linkedAt = 10_000 + SETTLE_MS;
    const shadowsWhileLinked = h.of('ev_car_link_soc_shadow').length;

    // Car unplugs; the charger view stays stale at plugged_in_charging.
    h.car(carDevice({ state: 'plugged_out', socPct: 41 }), linkedAt + 10_000);
    h.car(carDevice({ state: 'plugged_out', socPct: 42 }), linkedAt + 20_000);

    expect(h.of('ev_car_link_soc_shadow')).toHaveLength(shadowsWhileLinked);
    // The affinity the session earned is history, not session state.
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-1')).toBe(1);
  });

  it('ignores a corrupt future capability timestamp instead of freezing the car', () => {
    // `lastUpdated` is unbounded and the merge keeps whichever reading is newer,
    // so a far-future timestamp would beat every later honest report — the car's
    // plug state could never change again and no edge would ever form.
    h.car(carDevice({
      state: 'plugged_out',
      socPct: 40,
      observedAtMs: 10_000 + 365 * 24 * 60 * 60_000,
    }), 10_000);
    h.tick(10_000);
    plugIn(h, 20_000);

    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
  });

  it('does not let the prior overturn an ambiguous charger edge', () => {
    // Two live candidates the matcher refused to choose between. Resolving one
    // via history here would emit a confident link contradicting the ambiguity.
    h.snapshot = {
      version: h.snapshot.version,
      pairs: { 'car-A|charger-1': { votes: EV_CAR_LINK_MIN_PRIOR_VOTES, lastVotedAtMs: 1 } },
      cars: {},
    };
    h.car(carDevice({ id: 'car-A', state: 'plugged_out', socPct: 40 }), 0);
    h.car(carDevice({ id: 'car-B', state: 'plugged_out', socPct: 55 }), 0);
    h.tick(0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({ id: 'car-A', state: 'plugged_in_charging', socPct: 40 }), 5_000);
    h.car(carDevice({ id: 'car-B', state: 'plugged_in_charging', socPct: 55 }), 6_000);
    h.tick(5_000 + SETTLE_MS);

    expect(h.of('ev_car_link_ambiguous')).toHaveLength(1);
    expect(h.of('ev_car_link_resolved')).toHaveLength(0);
  });

  it('falls back to the persisted prior when the car edge is missed', () => {
    // The car is observed already CONNECTED, so there is no edge to match — a
    // restart mid-session, or a missed transition. History identifies the car.
    // It must be connected: a disconnected car is not a candidate at all.
    h.snapshot = {
      version: h.snapshot.version,
      pairs: { 'car-1|charger-1': { votes: EV_CAR_LINK_MIN_PRIOR_VOTES, lastVotedAtMs: 1 } },
      cars: {},
    };
    // FIRST observation of the car is already connected, so there is no edge.
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 0);
    h.tick(0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.tick(10_000);
    h.tick(10_000 + SETTLE_MS);

    const resolved = h.of('ev_car_link_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ carId: 'car-1', source: 'affinity_prior' });
  });

  it('ignores a disconnected car when falling back to the prior', () => {
    // A guest car is on the charger; the household car with all the history is
    // parked elsewhere. Attributing the session to it would be confidently wrong.
    h.snapshot = {
      version: h.snapshot.version,
      pairs: { 'car-1|charger-1': { votes: EV_CAR_LINK_MIN_PRIOR_VOTES + 5, lastVotedAtMs: 1 } },
      cars: {},
    };
    h.car(carDevice({ state: 'plugged_out', socPct: 40 }), 0);
    h.tick(0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.tick(10_000);
    h.tick(10_000 + SETTLE_MS);
    expect(h.of('ev_car_link_resolved')).toHaveLength(0);
  });

  it('recovers a session from the prior when the charger is already connected at boot', () => {
    // Restart mid-session: the charger's FIRST observation is already connected,
    // so it never produces a connect edge and the edge-driven paths never see it.
    // Without a prior pass the whole session loses its shadow and self-stop.
    h.snapshot = {
      version: h.snapshot.version,
      pairs: { 'car-1|charger-1': { votes: EV_CAR_LINK_MIN_PRIOR_VOTES, lastVotedAtMs: 1 } },
      cars: {},
    };
    h.chargers = [charger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true })];
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 0);

    const resolved = h.of('ev_car_link_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ carId: 'car-1', source: 'affinity_prior' });
  });

  it('does not resurrect a session whose charger has already unplugged', () => {
    // A short session: the disconnect lands before the connect edge has settled,
    // so the connect coincidence is processed after the session was cleared.
    // Reviving it would attribute later charge readings to an unplugged car.
    seedDisconnected(h, 0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 10_000);
    // Unplugged again well inside the settle window.
    h.setCharger({ evChargingState: 'plugged_out', measuredPowerW: 0, controlOn: false });
    h.car(carDevice({ state: 'plugged_out', socPct: 41 }), 30_000);
    h.tick(30_000 + SETTLE_MS);

    // A charge reading now must not be attributed to any charger.
    h.car(carDevice({ state: 'plugged_out', socPct: 42 }), 30_000 + SETTLE_MS + 10_000);
    expect(h.of('ev_car_link_soc_shadow')).toHaveLength(0);
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

  it('restarts the dwell when a schedule hold turns into not-charging', () => {
    // Regression: both reasons are non-null, so a reason change reused the
    // previous episode's start time. A two-minute schedule hold that flipped to
    // `plugged_in` therefore reported `car_not_charging` at once and persisted
    // the charge as observed-limit evidence for a condition that had held for
    // seconds — poisoning the exact statistic this probe exists to gather.
    const linkedAt = linkAndCharge(10_000);
    h.setCharger({ measuredPowerW: 0 });
    const holdAt = linkedAt + 10_000;
    h.car(carDevice({ state: 'plugged_in_paused', socPct: 55 }), holdAt);
    h.tick(holdAt + EV_CAR_LINK_SELF_STOP_MIN_MS - 2_000);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);

    // The hold ends just short of the dwell; a new episode starts here.
    const flipAt = holdAt + EV_CAR_LINK_SELF_STOP_MIN_MS - 2_000;
    h.car(carDevice({ state: 'plugged_in', socPct: 55 }), flipAt);
    h.tick(flipAt + 3_000);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);
    // The charge must not be banked as charge-limit evidence yet either.
    expect(h.snapshot.cars['car-1']?.stopSocPct ?? []).toHaveLength(0);

    // Only once the new reason has held for its own full dwell.
    h.tick(flipAt + EV_CAR_LINK_SELF_STOP_MIN_MS + 1_000);
    const stopped = h.selfStops();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ subReason: 'car_not_charging', stoppedAtSocPct: 55 });
    expect(h.snapshot.cars['car-1']?.stopSocPct).toEqual([55]);
  });

  it('does not re-report one stop across a gap in power telemetry', () => {
    // An unavailable power read used to re-arm reporting. When the same idle
    // telemetry returned and completed another dwell, one uninterrupted physical
    // stop was reported and banked twice — and two samples is exactly the
    // threshold for publishing a confident observed charge limit.
    const linkedAt = linkAndCharge(10_000);
    const stoppedAt = linkedAt + 10_000;
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in', socPct: 80 }), stoppedAt);
    h.tick(stoppedAt + EV_CAR_LINK_SELF_STOP_MIN_MS);
    expect(h.selfStops()).toHaveLength(1);

    // Power telemetry drops out, then returns with the car still stopped and
    // stays idle long enough to clear a whole second dwell.
    h.setCharger({ measuredPowerW: undefined });
    h.tick(stoppedAt + EV_CAR_LINK_SELF_STOP_MIN_MS + 30_000);
    h.setCharger({ measuredPowerW: 0 });
    const returnedAt = stoppedAt + EV_CAR_LINK_SELF_STOP_MIN_MS + 60_000;
    h.tick(returnedAt);
    h.tick(returnedAt + EV_CAR_LINK_SELF_STOP_MIN_MS + 1_000);

    expect(h.selfStops()).toHaveLength(1);
    expect(h.snapshot.cars['car-1']?.stopSocPct).toEqual([80]);
  });

  it('does not bank a charge reading carried over from an earlier session', () => {
    // `mergeCarObservation` deliberately carries the last-known percentage
    // forward when later updates omit `measure_battery`. Banking it as where the
    // car stopped in a NEW session publishes a confidently wrong observed limit.
    seedDisconnected(h, 0);
    plugIn(h, 10_000, 55);
    // Unplug, then start a fresh session whose car updates carry no charge at all.
    h.setCharger({ evChargingState: 'plugged_out', measuredPowerW: 0, controlOn: false });
    h.car(carDevice({ state: 'plugged_out' }), 200_000);
    h.tick(200_000);
    // This session's car updates carry NO charge at all, so the only percentage
    // on hand is the one last seen in the previous session.
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({ state: 'plugged_in_charging' }), 300_000);
    h.tick(300_000 + SETTLE_MS);
    const linkedAt = 300_000 + SETTLE_MS;

    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in' }), linkedAt + 10_000);
    h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);

    expect(h.selfStops()).toHaveLength(1);
    expect(h.snapshot.cars['car-1']?.stopSocPct ?? []).toHaveLength(0);
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

describe('observation ordering and membership', () => {
  it('refuses a fetched observation older than one already held', () => {
    // A device fetch can start before a realtime update and land after it.
    // Applying the older payload would manufacture a disconnect edge, then a
    // reconnect edge from the next fresh update — two phantom plug events.
    seedDisconnected(h, 0);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40, observedAtMs: 60_000 }), 60_000);
    // Stale fetch result arrives afterwards carrying the PREVIOUS plug state.
    h.producer.observe(
      [carDevice({ state: 'plugged_out', socPct: 40, observedAtMs: 30_000 })],
      { fullRefresh: false, nowMs: 61_000 },
    );
    // The charger's own edge lands within the window of the genuine car edge.
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.tick(70_000);
    h.tick(70_000 + SETTLE_MS);

    // The stale payload manufactured neither a disconnect nor an away session,
    // and the one true connect edge still links.
    expect(h.of('ev_car_session_elsewhere')).toHaveLength(0);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
  });

  it('never tracks a car that has no readable plug state', () => {
    // An unknown must not be stored and handed inward. A car whose capability is
    // unreadable is simply not tracked until a valid reading arrives.
    h.producer.observe([{
      id: 'car-1', name: 'Polestar', class: 'car',
      capabilities: ['ev_charging_state'], capabilitiesObj: {},
    } as unknown as HomeyDeviceLike], { fullRefresh: true, nowMs: 0 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual([]);
    expect(h.producer.isCarDevice('car-1')).toBe(false);

    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 1_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);
  });

  it('keeps the last valid plug state across a malformed update', () => {
    // An absent/unreadable capability is an ABSENT observation, not "unplugged".
    // Storing undefined would erase the last trusted state, and the following
    // genuine transition would compare against it and produce no edge at all —
    // the session could then neither link nor clear.
    seedDisconnected(h, 0);
    h.car({
      id: 'car-1', name: 'Polestar', class: 'car',
      capabilities: ['ev_charging_state'], capabilitiesObj: {},
    } as unknown as HomeyDeviceLike, 5_000);

    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 10_000);
    h.tick(10_000 + SETTLE_MS);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
  });

  it('does not let a stale fetch roll charge backward when the plug state is unchanged', () => {
    // Charge and plug state are separate capabilities. Gating both on the plug
    // timestamp lets an older fetched battery value through for the whole of a
    // charging session, faking a rising-charge/elsewhere event or a wrong
    // self-stop reading.
    seedDisconnected(h, 0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({
      state: 'plugged_in_charging', socPct: 40, observedAtMs: 10_000, socObservedAtMs: 10_000,
    }), 10_000);
    h.tick(10_000 + SETTLE_MS);

    const linkedAt = 10_000 + SETTLE_MS;
    h.car(carDevice({
      state: 'plugged_in_charging', socPct: 55, observedAtMs: 10_000, socObservedAtMs: linkedAt,
    }), linkedAt);
    const afterFresh = h.of('ev_car_link_soc_shadow').length;

    // Stale fetch: same (unchanged) plug timestamp, older battery reading.
    h.producer.observe([carDevice({
      state: 'plugged_in_charging', socPct: 40, observedAtMs: 10_000, socObservedAtMs: 10_000,
    })], { fullRefresh: false, nowMs: linkedAt + 5_000 });

    expect(h.of('ev_car_link_soc_shadow')).toHaveLength(afterFresh);
    expect(h.of('ev_car_session_elsewhere')).toHaveLength(0);
  });

  it('moves a car to its new charger instead of linking both', () => {
    // A missed disconnect leaves the old charger's link behind; one car cannot
    // occupy two chargers, and a double link double-counts charge readings.
    h.chargers = [charger(), charger({ id: 'charger-2', name: 'Garasje' })];
    seedDisconnected(h, 0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 10_000);
    h.tick(10_000 + SETTLE_MS);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);

    // Second charger picks the car up; the first never reported a disconnect.
    const t = 10_000 + SETTLE_MS;
    h.car(carDevice({ state: 'plugged_out', socPct: 41 }), t + 1_000);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 41 }), t + 2_000);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true }, 'charger-2');
    h.tick(t + 3_000);
    h.tick(t + 3_000 + SETTLE_MS);

    const shadowsBefore = h.of('ev_car_link_soc_shadow');
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 42 }), t + 3_000 + SETTLE_MS + 5_000);
    const added = h.of('ev_car_link_soc_shadow').slice(shadowsBefore.length);
    // EXACTLY one — `<= 1` would also pass if the link were lost entirely, which
    // is a different bug wearing the same number.
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ chargerId: 'charger-2', carSocPct: 42 });
  });

  it('drops a car Homey no longer reports on a full refresh', () => {
    // The affinity fallback treats every tracked car as a candidate, so a
    // deleted car with persisted votes would otherwise own live sessions
    // forever — and its id would be re-requested on every targeted refresh.
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);
    const other = { id: 'other', name: 'Ovn', class: 'heater', capabilities: [], capabilitiesObj: {} };
    h.producer.observe([other as unknown as HomeyDeviceLike], { fullRefresh: true, nowMs: 2_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual([]);
  });

  it('prunes the last car on a committed empty full read', () => {
    // No second emptiness guard here: the refresh pipeline's abandon-grace has
    // already ruled that an empty COMMITTED full read is genuine. Re-gating would
    // stack two graces and leave the final car tracked forever.
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);
    h.producer.observe([], { fullRefresh: true, nowMs: 1_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual([]);
  });

  it('keeps membership additive on a targeted refresh', () => {
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });
    h.producer.observe([], { fullRefresh: false, nowMs: 1_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);
  });
});

describe('charge-limit evidence', () => {
  const stopAt = (socPct: number, reasonState: string, startMs: number): void => {
    h.setCharger({ evChargingState: 'plugged_out', measuredPowerW: 0, controlOn: false });
    h.car(carDevice({ state: 'plugged_out', socPct: 40 }), startMs);
    h.tick(startMs);
    plugIn(h, startMs + 10_000);
    const linkedAt = startMs + 10_000 + SETTLE_MS;
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: reasonState, socPct }), linkedAt + 10_000);
    h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
  };

  it('excludes schedule holds from the observed charge limit', () => {
    // A smart-charging schedule pauses at whatever percentage it likes. Two such
    // holds would clear the two-sample threshold and publish a confident
    // `observedLimitPct` that is not a limit at all.
    stopAt(43, 'plugged_in_paused', 0);
    stopAt(67, 'plugged_in_paused', 1_000_000);

    const stops = h.selfStops();
    expect(stops).toHaveLength(2);
    expect(stops.every((e) => e.subReason === 'car_schedule_hold')).toBe(true);
    expect(stops[1].observedLimitPct).toBeUndefined();
    expect(stops[1].observedLimitSamples).toBe(0);
  });

  it('still builds the limit from genuine not-charging stops', () => {
    stopAt(80, 'plugged_in', 0);
    stopAt(79.8, 'plugged_in', 1_000_000);
    const stops = h.selfStops();
    expect(stops[1]).toMatchObject({ observedLimitPct: 79.9, observedLimitSamples: 2 });
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

describe('realtime capability events', () => {
  // Capability VALUE changes arrive on the per-capability seam, NOT on
  // `device.update`. Driving the probe only from full payloads hid the fact that
  // it was never wired to the path a real plug transition takes: on hardware it
  // saw nothing between fetches, so plug-edge correlation could not fire at all.
  it('links from capability events alone', () => {
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });

    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.cap('car-1', 'ev_charging_state', 'plugged_in_charging', 10_000);
    h.cap('car-1', 'measure_battery', 41, 12_000);
    h.cap('charger-1', 'measure_power', 7_000, 12_500);
    h.cap('car-1', 'measure_battery', 42, 10_000 + SETTLE_MS);

    const resolved = h.of('ev_car_link_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ carId: 'car-1', chargerId: 'charger-1', source: 'coincidence' });
    expect(h.of('ev_car_link_soc_shadow').length).toBeGreaterThan(0);
  });

  it('ignores capability events for devices it does not track', () => {
    h.cap('unknown-device', 'ev_charging_state', 'plugged_in_charging', 1_000);
    h.cap('unknown-device', 'measure_battery', 50, 2_000);
    expect(h.events).toHaveLength(0);
    expect(h.producer.isCarDevice('unknown-device')).toBe(false);
  });

  it('keeps the held value when a capability event is unreadable or stale', () => {
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });
    h.cap('car-1', 'ev_charging_state', 'plugged_in_charging', 10_000);
    h.cap('car-1', 'ev_charging_state', 'nonsense', 11_000);
    h.cap('car-1', 'ev_charging_state', 'plugged_out', 5_000);

    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.tick(10_500);
    h.tick(10_000 + SETTLE_MS);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
  });
});

describe('round-five ordering holes', () => {
  it('does not vote for the first charger while a later one is still competing', () => {
    h.chargers = [charger(), charger({ id: 'charger-2', name: 'Garasje' })];
    seedDisconnected(h, 0);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.tick(1_000);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 80_000);
    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true }, 'charger-2');
    h.tick(85_000);
    h.tick(1_000 + SETTLE_MS);

    expect(h.of('ev_car_link_resolved')).toHaveLength(0);
    expect(getEvCarLinkVotes(h.snapshot, 'car-1', 'charger-1')).toBe(0);
  });

  it('restarts the self-stop dwell when the reason changes', () => {
    seedDisconnected(h, 0);
    plugIn(h, 10_000, 60);
    const linkedAt = 10_000 + SETTLE_MS;
    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in_paused', socPct: 60 }), linkedAt + 1_000);
    h.tick(linkedAt + EV_CAR_LINK_SELF_STOP_MIN_MS);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);

    h.car(carDevice({ state: 'plugged_in', socPct: 60 }), linkedAt + EV_CAR_LINK_SELF_STOP_MIN_MS + 1_000);
    h.tick(linkedAt + EV_CAR_LINK_SELF_STOP_MIN_MS + 2_000);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);

    h.tick(linkedAt + (EV_CAR_LINK_SELF_STOP_MIN_MS * 2) + 5_000);
    expect(h.selfStops()).toHaveLength(1);
    expect(h.selfStops()[0].subReason).toBe('car_not_charging');
  });

  it('clears the link on a car-side disconnect even if the charger never agrees', () => {
    seedDisconnected(h, 0);
    plugIn(h, 10_000);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);
    const linkedAt = 10_000 + SETTLE_MS;

    h.car(carDevice({ state: 'plugged_out', socPct: 55 }), linkedAt + 5_000);
    const before = h.of('ev_car_link_soc_shadow').length;
    h.car(carDevice({ state: 'plugged_out', socPct: 56 }), linkedAt + 10_000);
    expect(h.of('ev_car_link_soc_shadow')).toHaveLength(before);
  });
});

describe('round-seven findings', () => {
  it('never reports a stop percentage this session did not observe', () => {
    // The merge deliberately carries the last-known charge forward. Reporting it
    // as `stoppedAtSocPct` claims the car stopped at a number never seen in this
    // session — the log would be confidently wrong even though the sample is
    // correctly withheld.
    seedDisconnected(h, 0);
    plugIn(h, 10_000, 55);
    h.setCharger({ evChargingState: 'plugged_out', measuredPowerW: 0, controlOn: false });
    h.car(carDevice({ state: 'plugged_out' }), 200_000);
    h.tick(200_000);

    h.setCharger({ evChargingState: 'plugged_in_charging', measuredPowerW: 7_000, controlOn: true });
    h.car(carDevice({ state: 'plugged_in_charging' }), 300_000);
    h.tick(300_000 + SETTLE_MS);
    const linkedAt = 300_000 + SETTLE_MS;

    h.setCharger({ measuredPowerW: 0 });
    h.car(carDevice({ state: 'plugged_in' }), linkedAt + 10_000);
    h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);

    const stops = h.selfStops();
    expect(stops).toHaveLength(1);
    expect(stops[0].stoppedAtSocPct).toBeUndefined();
  });

  it('drops a car that repeated targeted reads no longer return', () => {
    // The periodic refresh is ALWAYS targeted, so a deleted car would otherwise
    // never be forgotten — it keeps being requested and stays an affinity
    // candidate. One miss is not proof, so it takes a few.
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);

    h.producer.observe([], { fullRefresh: false, nowMs: 1_000 });
    h.producer.observe([], { fullRefresh: false, nowMs: 2_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);

    h.producer.observe([], { fullRefresh: false, nowMs: 3_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual([]);
  });

  it('forgives an intermittent targeted miss', () => {
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: true, nowMs: 0 });
    h.producer.observe([], { fullRefresh: false, nowMs: 1_000 });
    h.producer.observe([], { fullRefresh: false, nowMs: 2_000 });
    // A successful read resets the count, so the car survives.
    h.producer.observe([carDevice({ state: 'plugged_out', socPct: 40 })], { fullRefresh: false, nowMs: 3_000 });
    h.producer.observe([], { fullRefresh: false, nowMs: 4_000 });
    h.producer.observe([], { fullRefresh: false, nowMs: 5_000 });
    expect(h.producer.getObservedCarDeviceIds()).toEqual(['car-1']);
  });
});

describe('round-eight currency gates', () => {
  it('does not self-stop on a power reading taken before the session', () => {
    // A retained idle value from a previous session is not evidence about this
    // one; treating it as live proof of "delivering nothing" fabricates a stop.
    seedDisconnected(h, 0);
    plugIn(h, 10_000, 60);
    const linkedAt = 10_000 + SETTLE_MS;
    h.setCharger({ measuredPowerW: 0, measuredPowerObservedAtMs: 5_000 });
    h.car(carDevice({ state: 'plugged_in', socPct: 60 }), linkedAt + 10_000);
    h.tick(linkedAt + 10_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
    expect(h.of('ev_car_self_stopped')).toHaveLength(0);

    // A reading from within the session does count: the dwell starts on the
    // first resolved pass and reports once it has been held long enough.
    h.setCharger({ measuredPowerW: 0, measuredPowerObservedAtMs: linkedAt + 20_000 });
    h.tick(linkedAt + 20_000);
    h.tick(linkedAt + 20_000 + EV_CAR_LINK_SELF_STOP_MIN_MS);
    expect(h.of('ev_car_self_stopped')).toHaveLength(1);
  });

  it('omits a stale charger percentage from the shadow delta', () => {
    // Comparing the car against a percentage the observation layer already
    // marked stale corrupts the accuracy signal the shadow exists to report.
    seedDisconnected(h, 0);
    h.setCharger({ reportedSocPct: undefined });
    plugIn(h, 10_000);
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 74 }), 10_000 + SETTLE_MS + 5_000);

    const shadow = h.of('ev_car_link_soc_shadow');
    expect(shadow.length).toBeGreaterThan(0);
    expect(shadow[shadow.length - 1]).toMatchObject({ carSocPct: 74 });
    expect((shadow[shadow.length - 1] as { reportedSocPct?: number }).reportedSocPct).toBeUndefined();
    expect((shadow[shadow.length - 1] as { deltaPct?: number }).deltaPct).toBeUndefined();
  });
});

describe('idle interval provenance', () => {
  it('does not call an away session from a retained pre-session idle reading', () => {
    // The charger reconnects carrying an idle reading observed BEFORE this
    // session. A charge rise now is the car charging at home, not elsewhere.
    seedDisconnected(h, 0);
    h.setCharger({
      evChargingState: 'plugged_in_charging',
      measuredPowerW: 0,
      measuredPowerObservedAtMs: 1_000,
      controlOn: true,
    });
    h.car(carDevice({ state: 'plugged_in_charging', socPct: 40 }), 10_000);
    h.tick(10_000 + SETTLE_MS);
    expect(h.of('ev_car_link_resolved')).toHaveLength(1);

    h.car(carDevice({ state: 'plugged_in_charging', socPct: 44 }), 10_000 + SETTLE_MS + 5_000);
    expect(h.of('ev_car_session_elsewhere')).toHaveLength(0);
  });
});
