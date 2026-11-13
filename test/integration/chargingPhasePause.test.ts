import { HomeyRequestTimeoutError } from '../../lib/utils/errorUtils';
import { ChargingPhasePauseRecorder } from '../../lib/executor/chargingPhasePause';
import { PendingBinaryCommandStore } from '../../lib/observer/pendingBinaryCommands';
import type { ControlContestRecording } from '../../lib/ports/controlContest';

const NOW = 1_800_000_000_000;
const ID = 'charger';
const fixture = () => {
  const main = new PendingBinaryCommandStore({});
  const area = new PendingBinaryCommandStore({});
  let owningHome = { homeId: 'main', pendingCommands: main };
  const contests: ControlContestRecording = { commandSent: vi.fn(), controlReported: vi.fn(),
    commandReleased: vi.fn(), retainPlanned: vi.fn() };
  const recorder = new ChargingPhasePauseRecorder(contests, () => owningHome);
  return { main, area, contests, recorder, move: () => { owningHome = { homeId: 'area', pendingCommands: area }; } };
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

it('resolves the owning home at pause dispatch and keeps acceptance with that home', () => {
  const f = fixture();
  const pause = f.recorder.forDevice(ID);
  f.move();
  pause.onStarting(NOW);
  expect(f.main.peek(ID)).toBeUndefined();
  expect(f.area.peek(ID)).toMatchObject({ desired: false, dispatchState: 'dispatching', lifecycleRelease: true });
  pause.onAccepted();
  expect(f.area.peek(ID)?.dispatchState).toBe('accepted');
  expect(f.contests.commandSent).toHaveBeenCalledWith(expect.objectContaining({ homeId: 'area', value: false }));
});

it('retains an existing capacity off without changing its pressure provenance', () => {
  const f = fixture();
  f.main.record(ID, { desired: false, startedMs: NOW - 1000, logContext: 'capacity' });
  f.main.recordDispatchAccepted(ID, { deviceId: ID, desired: false, startedAtMs: NOW - 1000 });
  const original = f.main.peek(ID);
  const pause = f.recorder.forDevice(ID);
  pause.onStarting(NOW);
  pause.onAccepted();
  expect(f.main.peek(ID)).toBe(original);
  expect(f.main.peek(ID)?.lifecycleRelease).toBeUndefined();
});

it('clears a definitely failed pause from its dispatch home', () => {
  const f = fixture();
  const pause = f.recorder.forDevice(ID);
  pause.onStarting(NOW);
  f.move();
  pause.onFailed(new Error('Rejected'));
  expect(f.main.peek(ID)).toBeUndefined();
  expect(f.area.peek(ID)).toBeUndefined();
  expect(f.contests.commandSent).not.toHaveBeenCalled();
});

it('retains a timed-out pause as an accepted command whose physical outcome is unknown', () => {
  const f = fixture();
  const pause = f.recorder.forDevice(ID);
  pause.onStarting(NOW);
  pause.onFailed(new HomeyRequestTimeoutError('PUT', '/capability'));
  expect(f.main.peek(ID)?.dispatchState).toBe('accepted');
  expect(f.contests.commandSent).toHaveBeenCalledOnce();
});
