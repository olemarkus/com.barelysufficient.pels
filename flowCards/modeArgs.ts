export function getModeOptions(modes: Iterable<string>, query: string): Array<{ id: string; name: string }> {
  const q = (query || '').toLowerCase();
  return Array.from(modes)
    .filter((m) => !q || m.toLowerCase().includes(q))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map((m) => ({ id: m, name: m }));
}
