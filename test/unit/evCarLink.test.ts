import { describe, expect, it } from 'vitest';
import {
  EV_CAR_LINK_COINCIDENCE_WINDOW_MS,
  EV_CAR_LINK_MAX_EDGES_PER_SIDE,
  appendEvLinkEdge,
  classifyEvCarSelfStop,
  isChargingElsewhere,
  matchCoincidentEdges,
  pruneExpiredEvLinkEdges,
  resolveEvLinkEdge,
  resolveLinkForCharger,
  type EvLinkEdge,
} from '../../lib/device/evCarLink';

const edge = (deviceId: string, kind: EvLinkEdge['kind'], atMs: number): EvLinkEdge => (
  { deviceId, kind, atMs }
);

describe('resolveEvLinkEdge', () => {
  it('reports connect when moving from unplugged to any connected state', () => {
    expect(resolveEvLinkEdge('plugged_out', 'plugged_in')).toBe('connect');
    expect(resolveEvLinkEdge('plugged_out', 'plugged_in_charging')).toBe('connect');
    expect(resolveEvLinkEdge('plugged_out', 'plugged_in_paused')).toBe('connect');
    expect(resolveEvLinkEdge('plugged_out', 'plugged_in_discharging')).toBe('connect');
  });

  it('reports disconnect when leaving any connected state', () => {
    expect(resolveEvLinkEdge('plugged_in_charging', 'plugged_out')).toBe('disconnect');
    expect(resolveEvLinkEdge('plugged_in_paused', 'plugged_out')).toBe('disconnect');
  });

  it('ignores transitions between connected states', () => {
    // Charging -> paused is PELS pausing the charger, or the car's own schedule.
    // Neither is a plug event, so neither may become link evidence.
    expect(resolveEvLinkEdge('plugged_in_charging', 'plugged_in_paused')).toBeNull();
    expect(resolveEvLinkEdge('plugged_in', 'plugged_in_charging')).toBeNull();
  });

  it('never treats a first observation as a plug event', () => {
    // A cold boot would otherwise manufacture a connect edge for every device
    // and hand out a link vote on every restart.
    expect(resolveEvLinkEdge(undefined, 'plugged_in_charging')).toBeNull();
    expect(resolveEvLinkEdge('plugged_in_charging', undefined)).toBeNull();
  });
});

describe('edge ring', () => {
  it('drops the oldest edge past the cap', () => {
    const filled = Array.from({ length: EV_CAR_LINK_MAX_EDGES_PER_SIDE }, (_unused, index) => (
      edge('car', 'connect', index)
    ));
    const next = appendEvLinkEdge(filled, edge('car', 'connect', 999));
    expect(next).toHaveLength(EV_CAR_LINK_MAX_EDGES_PER_SIDE);
    expect(next[0].atMs).toBe(1);
    expect(next[next.length - 1].atMs).toBe(999);
  });

  it('prunes edges older than the retention window', () => {
    const edges = [edge('car', 'connect', 0), edge('car', 'connect', 5_000)];
    expect(pruneExpiredEvLinkEdges(edges, 6_000, 2_000)).toEqual([edge('car', 'connect', 5_000)]);
  });
});

describe('matchCoincidentEdges', () => {
  it('pairs one car with one charger inside the window', () => {
    const result = matchCoincidentEdges({
      carEdges: [edge('car', 'connect', 10_000)],
      chargerEdges: [edge('charger', 'connect', 0)],
    });
    expect(result.coincidences).toEqual([
      { carId: 'car', chargerId: 'charger', kind: 'connect', deltaMs: 10_000, atMs: 0 },
    ]);
    expect(result.ambiguities).toHaveLength(0);
    expect(result.unmatchedCarEdges).toHaveLength(0);
  });

  it('does not pair across the window boundary', () => {
    const result = matchCoincidentEdges({
      carEdges: [edge('car', 'connect', EV_CAR_LINK_COINCIDENCE_WINDOW_MS + 1)],
      chargerEdges: [edge('charger', 'connect', 0)],
    });
    expect(result.coincidences).toHaveLength(0);
    expect(result.unmatchedCarEdges).toHaveLength(1);
  });

  it('pairs exactly at the window boundary', () => {
    const result = matchCoincidentEdges({
      carEdges: [edge('car', 'connect', EV_CAR_LINK_COINCIDENCE_WINDOW_MS)],
      chargerEdges: [edge('charger', 'connect', 0)],
    });
    expect(result.coincidences).toHaveLength(1);
  });

  it('does not pair edges of opposite kinds', () => {
    const result = matchCoincidentEdges({
      carEdges: [edge('car', 'disconnect', 0)],
      chargerEdges: [edge('charger', 'connect', 0)],
    });
    expect(result.coincidences).toHaveLength(0);
  });

  it('reports ambiguity instead of voting when two cars plug in together', () => {
    const result = matchCoincidentEdges({
      carEdges: [edge('carA', 'connect', 0), edge('carB', 'connect', 1_000)],
      chargerEdges: [edge('charger', 'connect', 500)],
    });
    expect(result.coincidences).toHaveLength(0);
    expect(result.ambiguities).toEqual([
      { chargerId: 'charger', carIds: ['carA', 'carB'], kind: 'connect', atMs: 500 },
    ]);
    // Both cars are accounted for, so neither is misreported as an away session.
    expect(result.unmatchedCarEdges).toHaveLength(0);
  });

  it('reports a car edge with no charger edge as unmatched', () => {
    const result = matchCoincidentEdges({
      carEdges: [edge('car', 'connect', 0)],
      chargerEdges: [],
    });
    expect(result.unmatchedCarEdges).toEqual([edge('car', 'connect', 0)]);
  });
});

describe('resolveLinkForCharger', () => {
  it('prefers a live coincidence over the persisted prior', () => {
    const resolution = resolveLinkForCharger({
      coincidentCarId: 'carB',
      candidateCarIds: ['carA', 'carB'],
      votesFor: (carId) => (carId === 'carA' ? 50 : 0),
    });
    expect(resolution).toEqual({ carId: 'carB', source: 'coincidence', votes: 0 });
  });

  it('uses the prior when exactly one candidate has cleared the threshold', () => {
    const resolution = resolveLinkForCharger({
      candidateCarIds: ['carA', 'carB'],
      votesFor: (carId) => (carId === 'carA' ? 3 : 0),
    });
    expect(resolution).toEqual({ carId: 'carA', source: 'affinity_prior', votes: 3 });
  });

  it('refuses the prior when a rival has any votes at all', () => {
    // A second household car must never inherit the first car's history just
    // because it is behind on votes.
    expect(resolveLinkForCharger({
      candidateCarIds: ['carA', 'carB'],
      votesFor: (carId) => (carId === 'carA' ? 9 : 1),
    })).toBeNull();
  });

  it('refuses the prior below the vote threshold', () => {
    expect(resolveLinkForCharger({
      candidateCarIds: ['carA'],
      votesFor: () => 1,
    })).toBeNull();
  });
});

describe('classifyEvCarSelfStop', () => {
  const base = {
    carState: 'plugged_in' as const,
    chargerState: 'plugged_in_charging' as const,
    chargerCommandedOn: false,
    chargerPowerW: 0,
  };

  it('classifies the car sitting connected-but-not-charging', () => {
    expect(classifyEvCarSelfStop(base)).toBe('car_not_charging');
  });

  it('classifies the car holding on its own schedule', () => {
    expect(classifyEvCarSelfStop({ ...base, carState: 'plugged_in_paused' })).toBe('car_schedule_hold');
  });

  it('accepts an observed-on charger that has not reported charging yet', () => {
    expect(classifyEvCarSelfStop({
      ...base, chargerState: 'plugged_in_paused', chargerCommandedOn: true,
    })).toBe('car_not_charging');
  });

  it('returns null while the charger is actually delivering', () => {
    expect(classifyEvCarSelfStop({ ...base, chargerPowerW: 7_000 })).toBeNull();
  });

  it('returns null when the charger does not believe it is delivering', () => {
    expect(classifyEvCarSelfStop({ ...base, chargerState: 'plugged_in' })).toBeNull();
  });

  it('treats an unreadable power measurement as no evidence', () => {
    expect(classifyEvCarSelfStop({ ...base, chargerPowerW: null })).toBeNull();
    expect(classifyEvCarSelfStop({ ...base, chargerPowerW: Number.NaN })).toBeNull();
  });

  it('returns null while the car reports charging', () => {
    expect(classifyEvCarSelfStop({ ...base, carState: 'plugged_in_charging' })).toBeNull();
  });
});

describe('isChargingElsewhere', () => {
  it('detects charge climbing while the linked charger is idle', () => {
    expect(isChargingElsewhere({
      previousSocPct: 40, currentSocPct: 41, chargerPowerW: 0,
    })).toBe(true);
  });

  it('is false when the charger is delivering', () => {
    expect(isChargingElsewhere({
      previousSocPct: 40, currentSocPct: 41, chargerPowerW: 7_000,
    })).toBe(false);
  });

  it('is false without two readings to compare', () => {
    expect(isChargingElsewhere({
      previousSocPct: null, currentSocPct: 41, chargerPowerW: 0,
    })).toBe(false);
  });

  it('is false when charge is flat or falling', () => {
    expect(isChargingElsewhere({
      previousSocPct: 41, currentSocPct: 41, chargerPowerW: 0,
    })).toBe(false);
  });
});
