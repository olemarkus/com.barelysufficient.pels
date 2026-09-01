/**
 * The power-source epoch fence: which observed generation of the configured
 * power source has been durably handled, and therefore whether a sub-home
 * bundle may consume meter samples right now.
 *
 * `HomeRuntimeRegistry` (`setup/homeRuntime/`) is its only caller, but the
 * question it answers is a power question, so the state lives here and the
 * registry is handed the fence. It takes the settings boundary as a
 * `() => PowerSource | null` reader; `null` means the read failed, and the
 * fence is the thing that decides that is UNKNOWN rather than Flow.
 *
 * A sub-home bundle is only allowed to consume meter samples while the
 * configured power source is `homey_energy` AND the latest OBSERVED source
 * generation has been durably handled. The synchronous settings edge
 * (`observeChange`) runs before the serialized handler, so even a same-turn
 * A→B→A round trip advances the generation twice and closes authorization
 * immediately. A failed settings read is UNKNOWN, never authoritative Flow
 * configuration: it latches `transitionIncomplete` so nothing can be committed
 * or authorized until a successful reread.
 *
 * Behaviour is byte-for-byte what the registry did inline — same double read in
 * `reconcileObservedFromSettings` (the caller's read plus `observeChange`'s),
 * same latch points, same predicates.
 */
import type { PowerSource } from './powerSource';

export type PowerSourceEpochFenceOutcome = 'unchanged' | 'observed' | 'unreadable';

export class PowerSourceEpochFence {
  private observedSource: PowerSource;
  private handledSource: PowerSource;
  private observedGenerationCount = 0;
  private handledGenerationCount = 0;
  private transitionIncomplete = false;

  constructor(private readonly readSource: () => PowerSource | null) {
    const initial = readSource();
    // A failed boot read is UNKNOWN, not authoritative Flow configuration.
    // Keep Flow only as a fail-closed placeholder and require a successful
    // reread before the first bundle can be committed or authorized.
    this.transitionIncomplete = initial === null;
    this.observedSource = initial ?? 'flow';
    this.handledSource = initial ?? 'flow';
  }

  /** The source every currently-committed bundle was constructed against. */
  get handledPowerSource(): PowerSource {
    return this.handledSource;
  }

  /** Latest observed generation; the value a transition attempt commits against. */
  get observedGeneration(): number {
    return this.observedGenerationCount;
  }

  /**
   * Synchronous settings-event edge: advance the observed generation and close
   * authorization, whether or not the accompanying read succeeded.
   */
  observeChange(): void {
    const configured = this.readSource();
    if (configured !== null) this.observedSource = configured;
    this.observedGenerationCount += 1;
    this.transitionIncomplete = true;
  }

  /** Whether a transition is still outstanding (nothing may be authorized). */
  isTransitionPending(): boolean {
    return this.transitionIncomplete;
  }

  /** Latch the fence closed after a failed durable reset / bundle replacement. */
  markIncomplete(): void {
    this.transitionIncomplete = true;
  }

  /**
   * Raw-source fallback for a serialized settings edge that arrived without the
   * synchronous `observeChange` (direct callers and one-way tests). Preserves
   * the synchronous ABA fence: a differing read observes a fresh generation.
   */
  reconcileObservedFromSettings(): PowerSourceEpochFenceOutcome {
    const configured = this.readSource();
    if (configured === null) {
      this.transitionIncomplete = true;
      return 'unreadable';
    }
    if (configured !== this.observedSource) {
      this.observeChange();
      return 'observed';
    }
    return 'unchanged';
  }

  /** Whether per-meter samples may be consumed right now. */
  isMeterSourceAuthorized(): boolean {
    return !this.isEpochDiscarded() && this.readSource() === 'homey_energy';
  }

  /** Whether the current meter-source epoch is fenced (samples must be dropped). */
  isEpochDiscarded(): boolean {
    return this.transitionIncomplete
      || this.handledGenerationCount !== this.observedGenerationCount
      || this.observedSource !== 'homey_energy'
      || this.handledSource !== 'homey_energy';
  }

  /** True when `generation` is already durably handled and no latch is open. */
  isHandledCurrent(generation: number): boolean {
    return !this.transitionIncomplete
      && this.handledGenerationCount === generation;
  }

  /**
   * Re-read the boundary and adopt a source change observed since the last
   * read. `null` = the read failed, which latches the fence closed.
   */
  resolveAuthoritativeSource(): PowerSource | null {
    const configured = this.readSource();
    if (configured === null) {
      this.transitionIncomplete = true;
      return null;
    }
    if (configured !== this.observedSource) {
      this.observedSource = configured;
      this.observedGenerationCount += 1;
      this.transitionIncomplete = true;
    }
    return configured;
  }

  /**
   * Final pre-commit check: the boundary still reports the source this
   * transition was prepared against, and no newer generation was observed.
   */
  isTransitionCurrent(powerSource: PowerSource, generation: number): boolean {
    const sourceBeforeCommit = this.resolveAuthoritativeSource();
    return sourceBeforeCommit !== null
      && sourceBeforeCommit === powerSource
      && this.observedGenerationCount === generation;
  }

  /** Adopt `powerSource`/`generation` as durably handled and open the fence. */
  commitTransition(powerSource: PowerSource, generation: number): void {
    this.handledSource = powerSource;
    this.handledGenerationCount = generation;
    this.transitionIncomplete = false;
  }
}
