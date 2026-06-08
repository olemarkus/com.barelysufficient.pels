/**
 * SDK-free view of the Homey runtime object that the domain (`lib/**`) depends
 * on, instead of `Homey.App['homey']`. The real injected instance structurally
 * satisfies these ports, so consumers declare the narrow slice they need and
 * receive the full instance unchanged from the entry points — no adapter, no
 * value import of `homey`. This retires the *type* coupling to the SDK that a
 * direct `Homey.App` type import would otherwise spread across the domain.
 *
 * Keep this module free of any `homey` import — it is the seam, not the SDK.
 * The matching `homey-apps-sdk-v3-types` signatures are:
 *   ManagerSettings.get(key: string): any
 *   ManagerSettings.set(key: string, value: any): void   // synchronous, no Promise
 *   ManagerSettings.unset(key: string): void
 *   ManagerClock.getTimezone(): string
 *
 * `get` deliberately narrows the SDK's `any` to `unknown`: settings are
 * untrusted persisted data, so callers must validate before use (matching the
 * existing `homey.settings.get(KEY) as unknown` pattern at every read site).
 *
 * `unset` is a standard `ManagerSettings` method and is already consumed in the
 * domain by `lib/objectives/deferredObjectives/objectiveStore.ts` (which hand-
 * rolls a structurally-identical `ObjectiveSettingsStore`); that store is a
 * future consolidation target for this canonical port, at which point `getKeys`
 * joins the surface. Kept here so that migration needs no re-widening.
 */
export type SettingsPort = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
};

export type ClockPort = {
  getTimezone(): string;
};

export type HomeyRuntime = {
  settings: SettingsPort;
  clock: ClockPort;
};

export type FlowTriggerCard = {
  trigger(tokens: Record<string, unknown>, state?: Record<string, unknown>): Promise<unknown>;
};

export type FlowToken = {
  setValue(value: unknown): Promise<unknown>;
};

/**
 * Subset of `homey.flow` (ManagerFlow) the domain uses to publish runtime Flow
 * tokens/triggers. Deliberately NOT part of `HomeyRuntime`: only the two flow
 * publishers depend on it, so folding it into the shared runtime port would
 * make every settings-only consumer falsely claim a flow dependency. Consumers
 * keep their own `typeof …` runtime guards for partial mocks / SDK variance;
 * this port types the happy path.
 */
export type FlowPort = {
  getTriggerCard(id: string): FlowTriggerCard;
  createToken(id: string, opts: { type: 'string'; title: string; value: string }): Promise<FlowToken>;
};

/**
 * Subset of `homey.api` (ManagerApi) the domain uses: emit a realtime UI event,
 * and reach the Homey Energy manager. Like `FlowPort`, a standalone port (only
 * the price/energy consumers need it) — not folded into `HomeyRuntime`. `energy`
 * stays `unknown`: its shape is validated at the read site by `isHomeyEnergyApi`
 * (lib/utils/homeyEnergy). Consumers keep their `typeof …` guards for partial
 * mocks / SDK variance; this port types the happy path.
 */
export type ApiPort = {
  realtime(event: string, data: unknown): Promise<unknown>;
  readonly energy?: unknown;
};
