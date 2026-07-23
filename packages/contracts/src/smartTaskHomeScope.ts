/**
 * Reason-bearing Main-home scope for new smart-task promises.
 *
 * `sub_home` is durable product scope: the device belongs behind another
 * meter. `unavailable` is transient global/provisional authority and must be
 * surfaced as retryable, never mislabeled as relocation.
 */
export type SmartTaskHomeScope = 'main' | 'sub_home' | 'unavailable';
