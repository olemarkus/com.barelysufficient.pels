/**
 * The structured events the EV car-link probe emits. Split from the producer so
 * that file stays within its size ceiling and so the log contract — which is the
 * probe's entire output — can be read on its own.
 *
 * Optional numeric fields are OMITTED rather than nulled when unknown: a probe
 * whose whole purpose is measurement must not report a value it never observed.
 */
import type { EvChargingState } from '../../packages/contracts/src/types';
import type { CarLinkCarStatus, CarLinkConnection } from '../ports/carLinkDiagnostics';
import type { EvCarSelfStopReason, EvLinkEdgeKind, EvLinkRefusalReason } from './evCarLink';

export type EvCarLinkEvent =
    | {
        component: 'devices'; event: 'ev_car_link_confirmed' | 'ev_car_link_confirmation_ended';
        chargerId: string; carId: string;
    }
    | {
        component: 'devices'; event: 'ev_car_link_confirmation_rejected';
        chargerId: string; carId: string; reason: string;
    }
    | {
        component: 'devices'; event: 'ev_car_link_waiting_trigger_failed';
        chargerId: string; reason: string;
    }
    | {
        component: 'devices'; event: 'ev_car_link_candidate';
        carId: string; carName: string; chargerId: string; chargerName: string;
        kind: string; deltaMs: number; votes: number;
    }
    | {
        // The one car a charger's unsettled plug-in pairs with, linked before the
        // rival window closes: no vote, not persisted. `deltaMs` is car edge minus
        // charger edge.
        component: 'devices'; event: 'ev_car_link_provisional';
        carId: string; carName: string; chargerId: string; chargerName: string; deltaMs: number;
    }
    | {
        // A rival reported inside the window, so the provisional link was dropped.
        component: 'devices'; event: 'ev_car_link_provisional_withdrawn';
        carId: string; chargerId: string;
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
    }
    | {
        // A charger reported a plug-in or unplug. The event's time is when PELS
        // received it.
        component: 'devices'; event: 'ev_car_link_plug_edge'; role: 'charger';
        deviceId: string; deviceName: string; kind: EvLinkEdgeKind; state: EvChargingState;
    }
    | {
        // A car reported a plug-in or unplug. `reportedAtMs` is the car device's
        // own timestamp for its plug state; beside the event's time, when PELS
        // received it, it shows how late a car app reported.
        component: 'devices'; event: 'ev_car_link_plug_edge'; role: 'car';
        deviceId: string; deviceName: string; kind: EvLinkEdgeKind; state: EvChargingState;
        reportedAtMs: number;
    }
    | {
        // A charger with selected cars is plugged in and has no car yet.
        component: 'devices'; event: 'ev_car_link_waiting_started';
        chargerId: string; chargerName: string; connection?: CarLinkConnection;
        cars: CarLinkCarStatus[];
    }
    | {
        component: 'devices'; event: 'ev_car_link_waiting_ended';
        chargerId: string; chargerName: string; waitedMs: number;
        reason: EvCarLinkWaitEndReason; carId?: string; carName?: string;
    }
    | {
        // A charger's plug-in got no car: its coincidence window closed with no
        // car plug-in to pair, or PELS found it already plugged in, and past
        // matches did not decide. `cars` is what it waited for: the cars that may
        // pair with it and every plugged-in car the decision weighed.
        component: 'devices'; event: 'ev_car_link_unmatched';
        chargerId: string; chargerName: string; connection: CarLinkConnection;
        windowMs: number; reason: EvLinkUnmatchedReason; cars: CarLinkCarStatus[];
    }
    | {
        // A car that may pair with this charger reported plugging in after the
        // charger's window closed, while the charger was still plugged in with no
        // car. Never linked automatically, by plug-in timing or past matches: it
        // could have plugged in anywhere meanwhile. The owner can confirm it.
        component: 'devices'; event: 'ev_car_link_late_car_report';
        chargerId: string; chargerName: string; carId: string; carName: string;
        connection: CarLinkConnection; lateByMs: number;
    };

/**
 * Why a charger's plug-in got no car: a refusal of its past matches
 * (`decideLinkForCharger`), or `explained_at_another_charger` when the only car
 * plug-ins that fit belong to a charger that selected those cars.
 */
export type EvLinkUnmatchedReason = EvLinkRefusalReason | 'explained_at_another_charger';

/**
 * Why a charger stopped waiting to identify its car. `charger_removed`: Homey
 * no longer lists it; `plug_state_unknown`: its plug state stopped being readable.
 */
export type EvCarLinkWaitEndReason = 'linked' | 'confirmed' | 'unplugged' | 'selection_cleared'
    | 'charger_removed' | 'plug_state_unknown';

/** The devices an event is about: its charger, its car, or the device that reported a plug edge. */
export const carLinkEventDeviceIds = (event: EvCarLinkEvent): string[] => [
    ...('chargerId' in event ? [event.chargerId] : []),
    ...('carId' in event && event.carId !== undefined ? [event.carId] : []),
    ...('deviceId' in event ? [event.deviceId] : []),
];

/**
 * Whether a problem report keeps this event. A battery-level shadow repeats with
 * every percent a linked car charges, and a failing waiting trigger repeats every
 * minute of a wait; either would crowd the rest out of the journal's per-device
 * room. The structured log still has both.
 */
export const isJournalledCarLinkEvent = (event: EvCarLinkEvent): boolean => (
    event.event !== 'ev_car_link_soc_shadow' && event.event !== 'ev_car_link_waiting_trigger_failed'
);
