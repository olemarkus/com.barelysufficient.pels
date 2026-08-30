// Elapsed-bucket summation helpers for the Budget resolvers. Split out of
// `budgetRedesignResolvers.ts` so that module stays under the max-lines cap
// without trimming load-bearing comments. Non-finite entries are skipped, so
// a partially-populated bucket array degrades to the sum of what is real.

// `buckets` is derived from `payload.currentBucketIndex`, which crosses the
// Homey API bridge into the WebView, so it is gated here rather than trusted:
// a non-finite bound sums nothing, which is what a comparison against NaN did
// before this was a `break`.
const elapsedLimit = (buckets: number): number => (Number.isFinite(buckets) ? buckets : 0);
export const sumElapsed = (values: number[], buckets: number): number => {
  const limit = elapsedLimit(buckets);
  let total = 0;
  for (const [index, value] of values.entries()) {
    if (index >= limit) break;
    if (Number.isFinite(value)) total += value;
  }
  return total;
};

export const sumElapsedNullable = (values: Array<number | null>, buckets: number): number => {
  const limit = elapsedLimit(buckets);
  let total = 0;
  for (const [index, value] of values.entries()) {
    if (index >= limit) break;
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
};
