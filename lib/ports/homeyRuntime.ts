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
 *
 * `get` deliberately narrows the SDK's `any` to `unknown`: settings are
 * untrusted persisted data, so callers must validate before use. This port is
 * the single place that narrowing happens — read sites used to repeat it as
 * `homey.settings.get(KEY) as unknown`, and those casts are gone because the
 * port already hands them `unknown`.
 *
 * `unset` and `getKeys` are standard `ManagerSettings` methods. `getKeys` is
 * what lets a reader tell an unwritten key from a listed key the SDK failed to
 * answer (`notes/persisted-settings-state.md`); the legacy tracker import
 * (`lib/power/trackerLegacySettings.ts`) is its first domain consumer through
 * this port, and `lib/objectives/deferredObjectives/objectiveStore.ts` (which
 * hand-rolls a structurally-identical `ObjectiveSettingsStore`) is the
 * consolidation target still owed.
 */
export type SettingsPort = {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  unset(key: string): void;
  getKeys(): string[];
};

export type HomeyRuntime = {
  settings: SettingsPort;
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
 * A handle on ANOTHER app's own API, as `homey.api.getApiApp` hands it over.
 *
 * Only the two reads PELS makes: whether the app is there at all, and one GET
 * against a route it publishes. Not `post`/`put`/`delete` — PELS reads a peer
 * app, it does not drive one — and not `on('realtime')`, because nothing
 * subscribes yet and a port member no caller has exercised is a claim about an
 * SDK surface nobody has tested.
 */
export type ApiAppPort = {
  /** GET a route the other app publishes, relative to its API root. */
  get(uri: string): Promise<unknown>;
  /** True while the app is installed, enabled and running. */
  getInstalled(): Promise<boolean>;
};

/**
 * Subset of `homey.api` (ManagerApi) the domain uses: emit a realtime UI event,
 * and take a handle on another app's API. Like `FlowPort`, a standalone port —
 * not folded into `HomeyRuntime`. It has no `energy` member: the SDK gives apps
 * no Homey Energy manager, so its prices are read over the Web API
 * (`lib/price/homeyEnergyPriceFetch.ts`).
 */
export type ApiPort = {
  realtime(event: string, data: unknown): Promise<unknown>;
  /**
   * THROWS SYNCHRONOUSLY rather than returning a handle when the call is not
   * allowed — on a Cloud Homey, where app-to-app calls do not exist, and on any
   * Homey where this app has not declared `homey:app:<appId>` permission
   * (`ManagerApi.getApiApp`). Every caller owns that throw; it is a settled
   * verdict about the platform, not a failed read worth retrying.
   */
  getApiApp(appId: string): ApiAppPort;
};
