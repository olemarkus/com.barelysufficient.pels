import {
  createPreShedAnchorStore,
  PRE_SHED_ANCHOR_LOAD_GRACE_MS,
  type PreShedAnchorSettingsPort,
} from '../../setup/preShedAnchorStoreAdapter';
import { maintainPreShedAnchors } from '../../lib/plan/preShedAnchor';
import { PRE_SHED_ANCHORS, PRE_SHED_ANCHORS_INITIALIZED } from '../../lib/utils/settingsKeys';

/**
 * Fake settings port exercising the adapter's outward seam. `values` is the
 * live backing map; `failing` makes every access throw (a transient SDK
 * failure); `hideKeys` returns a non-array from `getKeys` (unreadable list).
 */
const makePort = (initial: Record<string, unknown> = {}) => {
  const values: Record<string, unknown> = { ...initial };
  const state = { failing: false, failWrites: false, hideKeys: false };
  const port: PreShedAnchorSettingsPort = {
    get: (key) => {
      if (state.failing) throw new Error('sdk read failed');
      // Homey answers an unset key with null, not undefined.
      return key in values ? values[key] : null;
    },
    set: (key, value) => {
      if (state.failing || state.failWrites) throw new Error('sdk write failed');
      values[key] = value;
    },
    getKeys: () => {
      if (state.failing) throw new Error('sdk read failed');
      return state.hideKeys ? undefined : Object.keys(values);
    },
  };
  return { port, values, state };
};

const ENTRY = { anchorC: 21, shedFloorC: 16 };

describe('PreShedAnchorStoreAdapter', () => {
  let nowMs: number;
  const now = () => nowMs;

  beforeEach(() => {
    nowMs = 1_000_000;
  });

  it('treats a fresh install as loaded-empty and persists write-through with the marker', () => {
    // Fresh install: other keys exist, but neither anchor key was ever written.
    const { port, values } = makePort({ some_other_key: true });
    const store = createPreShedAnchorStore(() => port, now);

    expect(store.read('heater')).toEqual({ kind: 'none' });

    store.record('heater', ENTRY);
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY });
    expect(values[PRE_SHED_ANCHORS_INITIALIZED]).toBe(true);
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });

    store.clear('heater');
    expect(values[PRE_SHED_ANCHORS]).toEqual({});
    expect(store.read('heater')).toEqual({ kind: 'none' });
  });

  it('loads a persisted blob and drops malformed entries individually', () => {
    const { port } = makePort({
      [PRE_SHED_ANCHORS]: {
        good: ENTRY,
        junk: { anchorC: 'sixteen', shedFloorC: 16 },
        worse: 42,
      },
      [PRE_SHED_ANCHORS_INITIALIZED]: true,
    });
    const store = createPreShedAnchorStore(() => port, now);

    expect(store.read('good')).toEqual({ kind: 'anchored', entry: ENTRY });
    expect(store.read('junk')).toEqual({ kind: 'none' });
    expect(store.read('worse')).toEqual({ kind: 'none' });
  });

  it('answers unavailable during the grace window after a transient miss, then recovers the blob', () => {
    // Marker present but the blob read comes back null: a transient SDK miss,
    // never a fresh install — the store must not fabricate an empty record.
    const { port, values } = makePort({ [PRE_SHED_ANCHORS_INITIALIZED]: true });
    const store = createPreShedAnchorStore(() => port, now);

    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    // The blob "reappears" (the transient miss passes) — adopted on next access.
    values[PRE_SHED_ANCHORS] = { heater: ENTRY };
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
  });

  it('abandons a persistently unreadable blob only after the grace window', () => {
    const { port } = makePort({ [PRE_SHED_ANCHORS_INITIALIZED]: true });
    const store = createPreShedAnchorStore(() => port, now);

    expect(store.read('heater')).toEqual({ kind: 'unavailable' });
    nowMs += PRE_SHED_ANCHOR_LOAD_GRACE_MS - 1;
    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    nowMs += 1;
    expect(store.read('heater')).toEqual({ kind: 'none' });
    // Writes are allowed after abandonment.
    store.record('heater', ENTRY);
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
  });

  it('engages the grace on a malformed blob even without the marker', () => {
    const { port } = makePort({ [PRE_SHED_ANCHORS]: 'not-an-object' });
    const store = createPreShedAnchorStore(() => port, now);

    expect(store.read('heater')).toEqual({ kind: 'unavailable' });
  });

  it('engages the grace when the key list is unreadable or empty', () => {
    // An absent blob is a genuine fresh install only when a non-empty key list
    // vouches that the anchor keys were never written.
    const unreadable = makePort({});
    unreadable.state.hideKeys = true;
    expect(createPreShedAnchorStore(() => unreadable.port, now).read('x'))
      .toEqual({ kind: 'unavailable' });

    const empty = makePort({});
    expect(createPreShedAnchorStore(() => empty.port, now).read('x'))
      .toEqual({ kind: 'unavailable' });
  });

  it('engages the grace when every read throws, and recovers when reads return', () => {
    const { port, values, state } = makePort({
      [PRE_SHED_ANCHORS]: { heater: ENTRY },
      [PRE_SHED_ANCHORS_INITIALIZED]: true,
    });
    state.failing = true;
    const store = createPreShedAnchorStore(() => port, now);

    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    state.failing = false;
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY });
  });

  it('keeps a failed write dirty and retries it on the next mutation (reads never write)', () => {
    const { port, values, state } = makePort({ some_other_key: true });
    const store = createPreShedAnchorStore(() => port, now);
    expect(store.read('heater')).toEqual({ kind: 'none' });

    state.failWrites = true;
    store.record('heater', ENTRY);
    // The mutation is live in memory even though persistence failed…
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
    expect(values[PRE_SHED_ANCHORS]).toBeUndefined();

    // …reads stay free of settings writes (they run per device per rebuild)…
    state.failWrites = false;
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
    expect(values[PRE_SHED_ANCHORS]).toBeUndefined();

    // …and the next mutation retries the whole record.
    const second = { anchorC: 22, shedFloorC: 15 };
    store.record('other', second);
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY, other: second });
  });

  it('stays dirty when the blob write lands but the marker write throws', () => {
    // Partial persist: blob ok, marker throws -> the store must stay dirty so
    // the next mutation retries BOTH (the marker is what protects the blob
    // from being misread as a fresh install after a transient miss).
    const values: Record<string, unknown> = { some_other_key: true };
    let markerThrows = true;
    const port: PreShedAnchorSettingsPort = {
      get: (key) => (key in values ? values[key] : null),
      set: (key, value) => {
        if (markerThrows && key === PRE_SHED_ANCHORS_INITIALIZED) throw new Error('marker write failed');
        values[key] = value;
      },
      getKeys: () => Object.keys(values),
    };
    const store = createPreShedAnchorStore(() => port, now);

    store.record('heater', ENTRY);
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY });
    expect(values[PRE_SHED_ANCHORS_INITIALIZED]).toBeUndefined();

    markerThrows = false;
    store.record('other', ENTRY);
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY, other: ENTRY });
    expect(values[PRE_SHED_ANCHORS_INITIALIZED]).toBe(true);
  });

  it('defers a capture during the grace window and lets a recovered anchor win', () => {
    // A shed decided while the boot read is suspect must not be lost — but a
    // recovered persisted anchor for the same device is the older truth of the
    // SAME episode and wins over the deferred (degenerate) capture.
    const { port, values } = makePort({ [PRE_SHED_ANCHORS_INITIALIZED]: true });
    const store = createPreShedAnchorStore(() => port, now);
    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    store.record('heater', { anchorC: 16, shedFloorC: 16 });
    store.record('fresh', { anchorC: 19, shedFloorC: 15 });
    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    // The blob reappears with the persisted anchor for `heater`.
    values[PRE_SHED_ANCHORS] = { heater: ENTRY };
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
    // The device with no persisted entry keeps its deferred capture.
    expect(store.read('fresh')).toEqual({ kind: 'anchored', entry: { anchorC: 19, shedFloorC: 15 } });
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY, fresh: { anchorC: 19, shedFloorC: 15 } });
  });

  it('keeps record-if-absent semantics when the blob recovers inside the record call itself', () => {
    // The caller decided to capture against an `unavailable` read; if the
    // blob recovers during record()'s own load attempt, the recovered entry
    // is the persisted truth and must win over the capture.
    const { port, values } = makePort({ [PRE_SHED_ANCHORS_INITIALIZED]: true });
    const store = createPreShedAnchorStore(() => port, now);
    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    values[PRE_SHED_ANCHORS] = { heater: ENTRY };
    store.record('heater', { anchorC: 18, shedFloorC: 16 });

    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
  });

  it('lands a transiently-failed capture write on the next maintenance pass', () => {
    // The next mutation is often the release-clear itself, possibly hours
    // away — the planner's per-rebuild maintenance pass carries the bounded
    // retry instead (reads stay write-free).
    const { port, values, state } = makePort({ some_other_key: true });
    const store = createPreShedAnchorStore(() => port, now);
    expect(store.read('heater')).toEqual({ kind: 'none' });

    state.failWrites = true;
    store.record('heater', ENTRY);
    expect(values[PRE_SHED_ANCHORS]).toBeUndefined();

    state.failWrites = false;
    maintainPreShedAnchors({ planDevices: [], anchors: store, normalizedShedFloorCByDevice: new Map(), captureEnabled: true });
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY });
  });

  it('applies a deferred capture when the grace expires with nothing recovered', () => {
    const { port, values } = makePort({ [PRE_SHED_ANCHORS_INITIALIZED]: true });
    const store = createPreShedAnchorStore(() => port, now);
    expect(store.read('heater')).toEqual({ kind: 'unavailable' });

    store.record('heater', ENTRY);
    nowMs += PRE_SHED_ANCHOR_LOAD_GRACE_MS;
    expect(store.read('heater')).toEqual({ kind: 'anchored', entry: ENTRY });
    expect(values[PRE_SHED_ANCHORS]).toEqual({ heater: ENTRY });
  });
});
