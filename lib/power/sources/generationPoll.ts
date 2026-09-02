import type { PowerSource } from '../powerSource';
import type { TimerRegistry } from '../../utils/timerRegistry';
import type { StructuredDebugEmitter } from '../../logging/logger';

/**
 * Producer-resolved outcome of one generation read: a measured value, `none`
 * when the report carried no generation signal, or `unavailable` — a failed
 * read or a present-but-malformed signal, the same no-op to this source.
 * Structural so this module keeps its zero dependency on `lib/device/`.
 */
export type GenerationReadResult =
  | { readonly state: 'measured'; readonly watts: number }
  | { readonly state: 'none' }
  | { readonly state: 'unavailable' };

const GENERATION_POLL_INTERVAL_MS = 10_000;
const GENERATION_POLL_TIMER = 'generationPoll';
const GENERATION_POLL_RESTART_RETRY_TIMER = 'generationPollRestartRetry';
const GENERATION_POLL_RESTART_RETRY_INITIAL_MS = 1_000;
const GENERATION_POLL_RESTART_RETRY_MAX_MS = 60_000;
const GENERATION_POLL_RESTART_RETRY_MAX_EXPONENT = 6;

/**
 * PRODUCTION-only companion poll for the `flow` power source.
 *
 * Whole-home PRODUCTION (`totalGenerated.W`) is a channel of Homey Energy, not
 * of whichever source delivers net. On `homey_energy` the main poll already
 * co-samples the two from one report; on `flow` net arrives through the
 * `report_power_usage` card and nothing was reading production at all, so a home
 * whose meter is only representable via a Flow (a split import/export AMS —
 * `test-devices` Run D) could report export but never production. This closes
 * that gap by reading the SAME report on the SAME 10 s cadence, and dispatching
 * ONLY generation.
 *
 * Why it does not reuse the whole-home poll path: that path
 * (`pollHomePowerWithMeterFanOut` → `updateHomePowerFromReport`) also produces
 * the whole-home net sample and fires the sub-home meter fan-out. On a flow home
 * Homey's net is not authoritative — for a split meter it FLOORS AT 0 while the
 * home genuinely exports (Run D, S2: exporting 6000 W, Homey reports 0) — so
 * recording it would overwrite a correct negative net with a wrong zero, and the
 * fan-out would start delivering sub-home samples that this source has no
 * business producing. Generation is the only thing taken from the report.
 *
 * Runs ONLY when the main poll does not, so the two can never race for the same
 * report. That is a boundary-level source branch, which is where source identity
 * legitimately lives; nothing downstream learns which source produced the value.
 */
export class GenerationPollSource {
  private pollInterval?: ReturnType<typeof setInterval>;

  // Same discard guard as `HomeyEnergyPollSource`: bumped on every (re)start, so
  // a poll already awaiting the SDK when the power source changed cannot write
  // its now-irrelevant reading over a fresher one.
  private pollGeneration = 0;

  private restartRetryAttempt = 0;

  // Per-READ sequence, distinct from `pollGeneration` (which tracks restarts).
  // A read slower than the interval overlaps the next one, and both share a
  // generation — so without this the earlier read, completing last, would
  // overwrite the newer value with an older measurement. Only the latest issued
  // read may publish.
  private readSequence = 0;

  // The latest read that SETTLED, not the latest that published. A failed read
  // still retires its predecessors: it proves a newer answer arrived, so an
  // older read completing afterwards is stale regardless of what it carries.
  // Advancing this only on the publish path would let exactly the overlap this
  // fence exists to stop through — slow read A, fast-failing read B, then A
  // publishing its older measurement unopposed.
  private settledReadSequence = 0;

  constructor(private readonly deps: {
    getPowerSource: () => PowerSource;
    /**
     * Whether the home has a device that could produce a generation reading at
     * all. Gates the SDK call, NOT the timer: flow homes make zero energy-API
     * calls today, and most have no PV, so an unconditional 10 s poll would be a
     * new steady-state cost on every flow install. Re-read each tick rather than
     * at start, so a solar device paired later is picked up without a restart.
     */
    hasProductionCandidate: () => boolean;
    timers: TimerRegistry;
    /**
     * Reads gross generation from the live energy report. A PURE READ — it must
     * not publish anything, so the discard checks below decide whether the value
     * is delivered at all. Injected so this source never imports `lib/device/`
     * (the power mandate in `.dependency-cruiser.cjs`).
     *
     * `unavailable` is a failed read or a malformed signal, which must never be published: on this
     * source net keeps arriving from the Flow card regardless, so publishing a
     * failure as "producing nothing" would overwrite a good reading with a fresh
     * timestamp — sailing past the freshness window into the accrual. Declining
     * to publish lets the last good reading age out honestly instead.
     */
    readGenerationW: () => Promise<GenerationReadResult>;
    /** Publishes the reading to observer state, stamped with its read time. */
    setGenerationW: (generationW: number | null, observedAtMs: number) => void;
    now: () => number;
    debugStructured: StructuredDebugEmitter;
    error: (...args: unknown[]) => void;
  }) {}

  start(): void {
    this.pollGeneration += 1;
    if (this.pollInterval) {
      this.deps.timers.clear(GENERATION_POLL_TIMER);
      this.pollInterval = undefined;
    }
    this.deps.timers.clear(GENERATION_POLL_RESTART_RETRY_TIMER);
    let powerSource: PowerSource;
    try {
      powerSource = this.deps.getPowerSource();
    } catch (error) {
      this.deps.error('Generation poll source read failed; retrying', error);
      this.scheduleRestartRetry();
      return;
    }
    this.restartRetryAttempt = 0;
    // On `homey_energy` the whole-home poll already co-samples generation from
    // the same report; a second reader would be pure duplication.
    if (powerSource !== 'flow') return;

    this.pollNow()
      .catch((error) => this.deps.error('Generation initial poll failed', error));

    this.pollInterval = this.deps.timers.registerInterval(GENERATION_POLL_TIMER, setInterval(() => {
      this.pollNow()
        .catch((error) => this.deps.error('Generation poll failed', error));
    }, GENERATION_POLL_INTERVAL_MS));
  }

  restart(): void {
    this.start();
  }

  stop(): void {
    this.pollGeneration += 1;
    this.deps.timers.clear(GENERATION_POLL_RESTART_RETRY_TIMER);
    this.restartRetryAttempt = 0;
    if (this.pollInterval) {
      this.deps.timers.clear(GENERATION_POLL_TIMER);
      this.pollInterval = undefined;
    }
  }

  private scheduleRestartRetry(): void {
    const exponent = Math.min(
      this.restartRetryAttempt,
      GENERATION_POLL_RESTART_RETRY_MAX_EXPONENT,
    );
    const delayMs = Math.min(
      GENERATION_POLL_RESTART_RETRY_INITIAL_MS * (2 ** exponent),
      GENERATION_POLL_RESTART_RETRY_MAX_MS,
    );
    this.restartRetryAttempt = Math.min(
      this.restartRetryAttempt + 1,
      GENERATION_POLL_RESTART_RETRY_MAX_EXPONENT,
    );
    this.deps.timers.registerTimeout(
      GENERATION_POLL_RESTART_RETRY_TIMER,
      setTimeout(() => {
        this.deps.timers.clear(GENERATION_POLL_RESTART_RETRY_TIMER);
        this.start();
      }, delayMs),
    );
  }

  async pollNow(): Promise<void> {
    // Check the source BEFORE the read, not only after: an interval tick that
    // fires mid-flip would otherwise spend an Energy API call whose result is
    // then discarded, and briefly put two pollers on the same report.
    if (this.deps.getPowerSource() !== 'flow') return;
    if (!this.deps.hasProductionCandidate()) return;
    const generation = this.pollGeneration;
    this.readSequence += 1;
    const sequence = this.readSequence;
    // Stamped at ISSUE, not at completion: the reading describes the moment the
    // report was asked for, and a slow read would otherwise overstate its own
    // freshness by its whole duration — the one thing the 60 s window
    // (`resolveFreshGenerationW`) has no way to detect.
    const readAtMs = this.deps.now();
    const read = await this.deps.readGenerationW();
    // Publish only AFTER the discard checks. The read is deliberately pure so a
    // poll superseded mid-flight (power source flipped, app restarting) cannot
    // leave its reading behind in observer state for the flow ingest to pick up.
    if (generation !== this.pollGeneration) {
      this.deps.debugStructured({ event: 'generation_poll_discarded_stale' });
      return;
    }
    if (this.deps.getPowerSource() !== 'flow') return;
    if (sequence <= this.settledReadSequence) {
      this.deps.debugStructured({ event: 'generation_poll_discarded_overtaken' });
      return;
    }
    this.settledReadSequence = sequence;
    if (read.state === 'unavailable') {
      this.deps.debugStructured({ event: 'generation_poll_unavailable' });
      return;
    }
    // "No generator" is itself an observation, which the holder records as
    // `null` against the read time.
    const generationW = read.state === 'measured' ? read.watts : null;
    this.deps.setGenerationW(generationW, readAtMs);
    this.deps.debugStructured({ event: 'generation_poll', generationW });
  }
}
