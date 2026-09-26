/**
 * The structured events the EV car-link probe emits. Split from the producer so
 * that file stays within its size ceiling and so the log contract — which is the
 * probe's entire output — can be read on its own.
 *
 * Optional numeric fields are OMITTED rather than nulled when unknown: a probe
 * whose whole purpose is measurement must not report a value it never observed.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';
import type { EvCarSelfStopReason } from './evCarLink';

export type EvCarLinkEvent =
    | {
        component: 'devices'; event: 'ev_car_link_candidate';
        carId: string; carName: string; chargerId: string; chargerName: string;
        kind: string; deltaMs: number; votes: number;
    }
    | {
        component: 'devices'; event: 'ev_car_link_resolved';
        carId: string; carName: string; chargerId: string; chargerName: string;
        votes: number; source: string;
    }
    | {
        // A session picked back up after a restart: the persisted pair, confirmed
        // by both sides currently reporting connected. `sinceMs` is the ORIGINAL
        // session start carried across the outage, so a log review can tell a
        // resumed session from a fresh one by its age.
        component: 'devices'; event: 'ev_car_link_resumed';
        carId: string; carName: string; chargerId: string; chargerName: string;
        sinceMs: number;
    }
    | {
        component: 'devices'; event: 'ev_car_link_ambiguous';
        chargerId: string; chargerName: string; carIds: string[]; kind: string;
    }
    | {
        component: 'devices'; event: 'ev_car_session_elsewhere';
        carId: string; carName: string; reason: string;
    }
    | {
        // `chargerState` is the charger's plug state when the stop was reported:
        // an Easee that ends the session at the car's limit reads `plugged_out`
        // with the car still connected. `chargeLimitPct` is present only once
        // the samples qualify as a limit (`resolveEvCarChargeLimit`); the
        // `observedLimit*` fields summarise every retained sample, qualified or not.
        component: 'devices'; event: 'ev_car_self_stopped';
        carId: string; carName: string; chargerId: string; chargerName: string;
        subReason: EvCarSelfStopReason; stoppedAtSocPct?: number;
        chargerState: EvChargingState;
        chargerPowerW: number; heldForMs: number;
        observedLimitPct?: number; observedLimitSpreadPct?: number;
        observedLimitSamples: number;
        chargeLimitPct?: number;
    }
    | {
        // The car charged past the limit its stops had qualified, so that limit
        // was not the car's: its samples are discarded and it must be learned again.
        component: 'devices'; event: 'ev_car_observed_limit_disproven';
        carId: string; carName: string; chargerId: string;
        chargeLimitPct: number; socPct: number;
    }
    | {
        component: 'devices'; event: 'ev_car_link_soc_shadow';
        carId: string; carName: string; chargerId: string; chargerName: string;
        carSocPct: number; reportedSocPct?: number; deltaPct?: number;
        wouldAdopt: boolean;
    };
