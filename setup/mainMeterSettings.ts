/**
 * The wiring layer's handle on Main's meter selection. It classifies nothing:
 * the read, the absence policy and the bounded grace all live in
 * `lib/home/mainMeterSelection.ts`, the module that owns what the key means.
 *
 * It exists as a re-export rather than as five direct imports because
 * `lib/home` is a domain peer, and the files that need a meter id — the weather
 * collector, the transport wiring, the settings repository — do not otherwise
 * touch the home domain. Pointing each at `lib/home` would raise the cross-peer
 * count `npm run setup:boundaries` holds down, for no gain: what those callers
 * want is one device id, not the home domain.
 *
 * The consumer that needs the GRACED reader — `homeMembership.ts`, which is the
 * home domain's own service — imports it from `lib/home` directly.
 */
export { readMainMeterSelection } from '../lib/home/mainMeterSelection';
