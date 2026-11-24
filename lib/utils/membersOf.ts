/** Resolve members present in this view, in membership order. */
export function membersOf<T>(ids: readonly string[], byId: ReadonlyMap<string, T>): T[] {
  return ids.flatMap((id) => {
    const member = byId.get(id);
    return member === undefined ? [] : [member];
  });
}
