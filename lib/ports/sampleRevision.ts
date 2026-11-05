/** Whether every requested sample has finished, or one is still in flight. */
export type StableSampleRevision =
  | { state: 'stable'; revision: number }
  | { state: 'pending' };
