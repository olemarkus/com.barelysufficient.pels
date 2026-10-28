// What in a change sends a Homey build to Athom's manual review. A build whose
// app.json (apart from its version) and store page match the Live build is
// released without review; anything listed here holds it in review for days.

const STORE_PAGE_FILES = Object.freeze([
  /^README(\.[a-z]{2})?\.txt$/,
  /^assets\/(icon\.svg$|images\/)/,
  /^drivers\/[^/]+\/assets\/(icon\.svg$|images\/)/,
  /^widgets\/[^/]+\/preview-(dark|light)\.png$/,
]);

// The version changes in every release, and _comment is a note to developers.
const IGNORED_MANIFEST_KEYS = new Set(['version', '_comment']);

// Key order inside an object is not a change; array order is.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const keyedChanges = (label, base = {}, head = {}) => {
  const ids = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  return ids.flatMap((id) => {
    if (!(id in base)) return [`${label}: added ${id}`];
    if (!(id in head)) return [`${label}: removed ${id}`];
    return same(base[id], head[id]) ? [] : [`${label}: changed ${id}`];
  });
};

const byId = (items = []) => Object.fromEntries(items.map((item) => [item.id, item]));

const manifestChanges = (base, head) => {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(head)])]
    .filter((key) => !IGNORED_MANIFEST_KEYS.has(key))
    .sort();
  return keys.flatMap((key) => {
    if (same(base[key], head[key])) return [];
    if (key === 'api' || key === 'widgets' || key === 'capabilities') {
      return keyedChanges(key, base[key], head[key]);
    }
    if (key === 'drivers') return keyedChanges('drivers', byId(base.drivers), byId(head.drivers));
    if (key === 'flow') {
      const kinds = [...new Set([...Object.keys(base.flow ?? {}), ...Object.keys(head.flow ?? {})])].sort();
      return kinds.flatMap((kind) => keyedChanges(`flow ${kind}`, byId(base.flow?.[kind]), byId(head.flow?.[kind])));
    }
    if (key === 'permissions') {
      const before = new Set(base.permissions ?? []);
      const after = new Set(head.permissions ?? []);
      return [
        ...[...after].filter((p) => !before.has(p)).map((p) => `permissions: added ${p}`),
        ...[...before].filter((p) => !after.has(p)).map((p) => `permissions: removed ${p}`),
      ];
    }
    return [`app.json: changed ${key}`];
  });
};

export const athomReviewChanges = ({ baseManifest, headManifest, changedFiles }) => [
  ...manifestChanges(baseManifest, headManifest),
  ...changedFiles
    .filter((file) => STORE_PAGE_FILES.some((pattern) => pattern.test(file)))
    .sort()
    .map((file) => `store page: ${file}`),
];
