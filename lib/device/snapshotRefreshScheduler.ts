/**
 * When the device snapshot is refreshed: the single-flight refresh loop and the
 * clocks that drive it — the device poll, the twice-hourly status log, the
 * stuck-confirmation poll and the post-actuation refresh — with the latch that
 * stops them all.
 *
 * It lives here, not in `setup/`, because it is runtime state (`setup/AGENTS.md`
 * § "No state"), built the way `targetPowerProbeScheduler.ts` is: the refresh
 * cycle itself fans out across plan, power and home, so it stays in `setup/`
 * and is handed in as a function, as is the check for stuck target commands,
 * which is the plan's question.
 */
import type { Logger as PinoLogger } from '../logging/logger';
import { getDebugEmitter } from '../logging/logger';
import { runWithoutContext } from '../logging/alsContext';
import { normalizeError } from '../utils/errorUtils';
import { createSingleFlightLoop } from '../utils/singleFlightLoop';
import type { TimerRegistry } from '../utils/timerRegistry';
import type { DeviceTransportPort } from './deviceTransport';

const PERIODIC_STATUS_MINUTE_INTERVALS = [25, 55];
// How often PELS checks for target commands a device has not confirmed. The
// plan says which commands count as stuck; this is only how often it asks.
const TARGET_CONFIRMATION_POLL_INTERVAL_MS = 60 * 1000;
const POST_ACTUATION_REFRESH_DELAY_MS = 5_000;
// The app's device poll. A Homey driver pushes a capability only on value
// CHANGE, so a device that keeps doing the same thing sends nothing — and the
// EV car-link probe's correlation pass runs over the FETCHED device list
// (`observeEvCarLinkAndResubscribe`), which is also where a class-`car` device,
// dropped at parse, becomes visible at all. Something has to ask.
//
// This is a poll, not a verdict about any device. It used to be gated on a
// 40-minute per-device "stale observation" window, which meant the app polled
// whenever some device happened to have been quiet for a while — an arbitrary
// trigger dressed up as a health signal, and one that produced a
// `stale_device_observation_refresh` log line per window per device for the
// entire uptime. In production that gate was open continuously, so the app in
// fact fetched every managed device roughly once a minute. The gate is gone and
// the cadence is now stated outright, at the slowest value nothing needs faster
// than: the tightest consumer is the EV car-link probe (a car's `measure_battery`
// only reaches PELS on a fetch), and a charging session tolerates 5 minutes.
//
// This is the app's ONLY device fetch loop. The `:25`/`:55` timer below used to
// fetch too; it now only writes the periodic status log, because a second
// fetcher on a coarser schedule adds nothing a 5-minute poll has not already
// done.
const DEVICE_POLL_INTERVAL_MS = 5 * 60 * 1000;

export type SnapshotRefreshOptions = {
  fast?: boolean;
  targeted?: boolean;
  recordHomeyEnergySample?: boolean;
  emitFlowBackedRefresh?: boolean;
};

/** One pass of the refresh loop: the transport to read, and the intent. */
type SnapshotRefreshRequest = {
  transport: DeviceTransportPort;
  options: SnapshotRefreshOptions;
};

/** What the scheduler drives and reports through; the cycle itself is the wiring's. */
export type SnapshotRefreshSchedulerDeps = {
  timers: TimerRegistry;
  getNow: () => Date;
  /** The transport to refresh from; `undefined` before device management starts. */
  getTransport: () => DeviceTransportPort | undefined;
  /** One refresh cycle over `transport`, owned by the wiring that fans it out. */
  runCycle: (transport: DeviceTransportPort, options: SnapshotRefreshOptions) => Promise<void>;
  logPeriodicStatus: (options: { includeDeviceHealth: boolean }) => void;
  /** Refresh when the plan holds target commands no device has confirmed in time. */
  pollStuckTargetConfirmations: () => Promise<void>;
  getLogger: () => PinoLogger;
};

export class SnapshotRefreshScheduler {
  private stopped = true;

  /**
   * One refresh at a time, with a single queued re-run. A caller arriving
   * mid-refresh awaits the loop, so `/ui_refresh_devices` sees the post-refresh
   * in-memory snapshot rather than returning while the refresh is still
   * running; a synchronously re-entrant caller queues and returns instead,
   * because awaiting there would be awaiting its own frame.
   *
   * A queued re-run repeats THIS refresh's options rather than adopting the
   * queued caller's — a queued request means "do that again" — with
   * `emitFlowBackedRefresh` cleared, so the flow-backed refresh is emitted at
   * most once per drain.
   */
  private readonly loop = createSingleFlightLoop<SnapshotRefreshRequest>({
    run: (request) => this.deps.runCycle(request.transport, request.options),
    nextRequest: (_queued, ran) => ({
      ...ran,
      options: { ...ran.options, emitFlowBackedRefresh: false },
    }),
    mayContinue: () => !this.stopped,
    onRequest: ({ join }) => {
      if (join === 'started') return;
      getDebugEmitter('snapshot', 'devices')({
        event: 'snapshot_refresh_coalesced',
        mode: join === 'joined' ? 'awaiting_in_flight' : 'queued',
      });
    },
    onRerun: () => {},
  });

  constructor(private readonly deps: SnapshotRefreshSchedulerDeps) {}

  start(): void {
    this.stopped = false;
    this.schedulePeriodicStatusLog();
    this.scheduleNextDevicePoll();
    this.deps.timers.registerInterval(
      'targetConfirmationPoll',
      setInterval(() => {
        this.deps.pollStuckTargetConfirmations()
          .catch((error) => this.deps.getLogger().error({
            event: 'stuck_target_confirmation_poll_failed',
            err: normalizeError(error),
          }));
      }, TARGET_CONFIRMATION_POLL_INTERVAL_MS),
    );
  }

  stop(): void {
    this.stopped = true;
    this.deps.timers.clear('periodicStatus');
    this.deps.timers.clear('devicePoll');
    this.deps.timers.clear('targetConfirmationPoll');
    this.deps.timers.clear('postActuationRefresh');
  }

  async refresh(options: SnapshotRefreshOptions = {}): Promise<void> {
    const transport = this.deps.getTransport();
    if (!transport) return;
    await this.loop.request({
      transport,
      // Normalized here so the re-run policy above only has to clear it.
      options: { ...options, emitFlowBackedRefresh: options.emitFlowBackedRefresh !== false },
    });
  }

  /**
   * Whether a post-actuation refresh is already armed. The timer registry owns
   * the handle, and "is one pending?" is the only question any caller ever asked
   * of it — so it answers that, rather than handing out a handle for a caller to
   * null-check.
   */
  hasPendingPostActuationRefresh(): boolean {
    return this.deps.timers.has('postActuationRefresh');
  }

  schedulePostActuationRefresh(): void {
    if (this.deps.timers.has('postActuationRefresh')) {
      getDebugEmitter('snapshot', 'plan')({
        event: 'post_actuation_refresh_skipped',
        reason: 'already_scheduled',
      });
      return;
    }

    getDebugEmitter('snapshot', 'plan')({
      event: 'post_actuation_refresh_scheduled',
      delayMs: POST_ACTUATION_REFRESH_DELAY_MS,
    });
    runWithoutContext(() => (
      this.deps.timers.registerTimeout('postActuationRefresh', setTimeout(async () => {
        this.deps.timers.clear('postActuationRefresh');
        getDebugEmitter('snapshot', 'plan')({
          event: 'post_actuation_refresh_running',
        });
        try {
          await this.refresh({ targeted: true, recordHomeyEnergySample: false });
        } catch (error) {
          this.deps.getLogger().error({
            event: 'post_actuation_snapshot_refresh_failed',
            err: normalizeError(error),
          });
        }
      }, POST_ACTUATION_REFRESH_DELAY_MS))
    ));
  }

  /**
   * The twice-hourly status log. It used to fetch every device first and report
   * device health only if that fetch succeeded; the device poll owns fetching
   * now, so this reports on the committed snapshot — which is the device health,
   * never more than `DEVICE_POLL_INTERVAL_MS` old.
   */
  schedulePeriodicStatusLog(): void {
    const now = this.deps.getNow();
    const currentMinute = now.getMinutes();
    const nextMinute = PERIODIC_STATUS_MINUTE_INTERVALS.find((minute) => minute > currentMinute);

    const next = new Date(now);
    if (nextMinute !== undefined) {
      next.setMinutes(nextMinute, 0, 0);
    } else {
      next.setHours(now.getHours() + 1, PERIODIC_STATUS_MINUTE_INTERVALS[0], 0, 0);
    }

    this.deps.timers.registerTimeout('periodicStatus', setTimeout(() => {
      this.deps.timers.clear('periodicStatus');
      try {
        this.deps.logPeriodicStatus({ includeDeviceHealth: true });
      } finally {
        if (!this.stopped) this.schedulePeriodicStatusLog();
      }
    }, next.getTime() - now.getTime()));
  }

  /**
   * Self-rescheduling rather than an interval so a slow refresh cannot stack
   * polls on top of itself. `refresh` already coalesces a concurrent caller,
   * but not queueing in the first place is cheaper.
   *
   * The registry owns the handle: `registerTimeout` clears any timer already
   * under this key, so re-arming needs no local copy to check first.
   */
  private scheduleNextDevicePoll(): void {
    if (this.stopped) return;
    this.deps.timers.registerTimeout(
      'devicePoll',
      setTimeout(async () => {
        this.deps.timers.clear('devicePoll');
        try {
          await this.refresh({ targeted: true });
        } catch (error) {
          this.deps.getLogger().error({
            event: 'device_poll_failed',
            err: normalizeError(error),
          });
        } finally {
          this.scheduleNextDevicePoll();
        }
      }, DEVICE_POLL_INTERVAL_MS),
    );
  }
}
