import type { DeviceTransport } from '../../lib/device/deviceTransport';
import type { ObservedHomePower } from '../../lib/observer/observedHomePower';
import type { PowerSource } from '../../lib/power/powerSource';
import { GenerationPollSource } from '../../lib/power/sources/generationPoll';
import type { StructuredDebugEmitter } from '../../lib/logging/logger';
import { hasSolarProductionCandidate } from '../../lib/device/solarPresence';
import type { TimerRegistry } from '../../lib/utils/timerRegistry';

/**
 * The slice of the app this factory reads. Structural rather than `PelsApp` so
 * `setup/` keeps its one-way dependency on the entry point.
 */
export type GenerationPollSourceHost = {
  readonly timers: TimerRegistry;
  getPowerSource(): PowerSource;
  readonly deviceManager?: DeviceTransport;
  getStructuredDebugEmitter(component: 'devices', debugTopic: 'devices'): StructuredDebugEmitter;
  error(...args: unknown[]): void;
};

/**
 * Boot wiring for the production companion poll.
 *
 * Lives here rather than in `app.ts` per `setup/AGENTS.md` ("add new boot wiring
 * as a new `setup/appInit/` file"), alongside its sibling
 * `createHomeyEnergyPollSource`. The source itself is SDK-free and
 * `lib/device`-free; this factory is where its read is bound to the transport
 * and its write to observer's holder.
 *
 * Every host field is read lazily inside a closure, so this may be constructed
 * during `PelsApp` field initialisation before `deviceManager` exists.
 */
export const createGenerationPollSource = (
  host: GenerationPollSourceHost,
  observedHomePower: ObservedHomePower,
): GenerationPollSource => {
  // `deviceManager` is definite on `PelsApp` but optional on the structural
  // host, and `startAppServices` runs long after `initDeviceManager` — so an
  // absent transport here is a wiring bug, not a boot-window state. Assert it
  // rather than defaulting: `?.` / `?? default` would silently convert that bug
  // into "this home produces nothing" and quietly suppress production polling
  // forever (setup/AGENTS.md).
  const requireDeviceManager = (): DeviceTransport => {
    const { deviceManager } = host;
    if (!deviceManager) throw new Error('generation poll ran before the device transport was wired');
    return deviceManager;
  };
  return new GenerationPollSource({
  getPowerSource: () => host.getPowerSource(),
  // A role-detected PV device is what makes a production reading possible at
  // all: `totalGenerated.W` is Homey's generator aggregate, so a home without
  // one has nothing to poll for. Gating the SDK call on it keeps flow homes
  // without solar at the zero energy-API calls they make today.
  // Reads the RAW snapshot, not `latestTargetSnapshot`: that getter decorates
  // every device on each call (a fresh object per device) and side-effects a
  // stepped-load prune. This runs every 10 s on every flow home, so it must stay
  // allocation-free — the capability question needs only `deviceClass`.
  hasProductionCandidate: () => hasSolarProductionCandidate(requireDeviceManager().getSnapshot()),
  timers: host.timers,
  readGenerationW: () => requireDeviceManager().readGenerationW(),
  setGenerationW: (generationW, observedAtMs) => observedHomePower
    .setGenerationW(generationW, observedAtMs),
  now: () => Date.now(),
  debugStructured: host.getStructuredDebugEmitter('devices', 'devices'),
  error: (...args) => host.error(...args),
  });
};
