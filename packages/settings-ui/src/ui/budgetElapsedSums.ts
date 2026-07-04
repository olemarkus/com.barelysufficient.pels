// Elapsed-bucket summation helpers for the Budget resolvers. Split out of
// `budgetRedesignResolvers.ts` so that module stays under the max-lines cap
// without trimming load-bearing comments. Non-finite entries are skipped, so
// a partially-populated bucket array degrades to the sum of what is real.
export const sumElapsed = (values: number[], buckets: number): number => {
  let total = 0;
  for (let index = 0; index < buckets && index < values.length; index += 1) {
    const value = values[index];
    if (Number.isFinite(value)) total += value;
  }
  return total;
};

export const sumElapsedNullable = (values: Array<number | null>, buckets: number): number => {
  let total = 0;
  for (let index = 0; index < buckets && index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === 'number' && Number.isFinite(value)) total += value;
  }
  return total;
};
