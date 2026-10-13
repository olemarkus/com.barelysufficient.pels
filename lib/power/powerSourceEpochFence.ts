/**
 * The power-source epoch fence: which observed generation of the configured
 * power source has been durably handled, and therefore whether a sub-home
 * bundle may consume meter samples right now.
 *
 * `HomeRuntimeRegistry` (`lib/home/homeRuntimeRegistry.ts`) is its only
 * caller, but the question it answers is a power question, so the state lives
 * here and the wiring hands the registry the fence. It takes the settings
 * boundary's classified read; a suspect read means the read failed, and the
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
import type { ConfiguredPowerSourceRead, PowerSource } from './powerSource';

export type PowerSourceEpochFenceOutcome = 'unchanged' | 'observed' | 'unreadable';

export class PowerSourceEpochFence {
  private observedSource: PowerSource;
  private handledSource: PowerSource;
  private observedGenerationCount = 0;
  private handledGenerationCount = 0;
  private transitionIncomplete = false;

  constructor(private readonly readConfigured: () => ConfiguredPowerSourceRead) {
    const initial = readConfigured();
    // A failed boot read is UNKNOWN, not authoritative Flow configuration.
    // Keep Flow only as a fail-closed placeholder and require a successful
    // reread before the first bundle can be committed or authorized.
    const source = initial.state === 'resolved' ? initial.value : 'flow';
    this.transitionIncomplete = initial.state !== 'resolved';
    this.observedSource = source;
    this.handledSource = source;
  }

  /** The source every currently-committed bundle was constructed against. */
  get handledPowerSource(): PowerSource {
    return this.handledSource;
  }

  /**
   * The configured source as the settings boundary classified it, read fresh
   * on every call: the registry's misconfiguration warning asks it directly.
   */
  readConfiguredSource(): ConfiguredPowerSourceRead {
    return this.readConfigured();
  }

  /** Latest observed generation; the value a transition attempt commits against. */
  get observedGeneration(): number {
    return this.observedGenerationCount;
  }

  /**
   * The source the latest successful read observed (the Flow placeholder until
   * one succeeds). Read it only after `refreshObservedSource` answered true: it
   * is then the source a transition is prepared and committed against.
   */
  get observedPowerSource(): PowerSource {
    return this.observedSource;
  }

  /**
   * Synchronous settings-event edge: advance the observed generation and close
   * authorization, whether or not the accompanying read succeeded.
   */
  observeChange(): void {
    const configured = this.readConfigured();
    if (configured.state === 'resolved') this.observedSource = configured.value;
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
    const configured = this.readConfigured();
    if (configured.state !== 'resolved') {
      this.transitionIncomplete = true;
      return 'unreadable';
    }
    if (configured.value !== this.observedSource) {
      this.observeChange();
      return 'observed';
    }
    return 'unchanged';
  }

  /** Whether per-meter samples may be consumed right now. */
  isMeterSourceAuthorized(): boolean {
    if (this.isEpochDiscarded()) return false;
    const configured = this.readConfigured();
    return configured.state === 'resolved' && configured.value === 'homey_energy';
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
   * read, which `observedPowerSource` then reports. A failed read is UNKNOWN:
   * it latches the fence closed and answers false, so nothing is prepared
   * against it, and `observedPowerSource` keeps the last source a read accepted.
   */
  refreshObservedSource(): boolean {
    const configured = this.readConfigured();
    if (configured.state !== 'resolved') {
      this.transitionIncomplete = true;
      return false;
    }
    if (configured.value !== this.observedSource) {
      this.observedSource = configured.value;
      this.observedGenerationCount += 1;
      this.transitionIncomplete = true;
    }
    return true;
  }

  /**
   * Final pre-commit check: the boundary still reports the source this
   * transition was prepared against, and no newer generation was observed.
   */
  isTransitionCurrent(powerSource: PowerSource, generation: number): boolean {
    return this.refreshObservedSource()
      && this.observedSource === powerSource
      && this.observedGenerationCount === generation;
  }

  /** Adopt `powerSource`/`generation` as durably handled and open the fence. */
  commitTransition(powerSource: PowerSource, generation: number): void {
    this.handledSource = powerSource;
    this.handledGenerationCount = generation;
    this.transitionIncomplete = false;
  }
}
