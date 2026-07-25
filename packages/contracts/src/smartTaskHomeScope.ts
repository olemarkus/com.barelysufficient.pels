/**
 * Reason-bearing Main-home scope for new smart-task promises.
 *
 * `sub_home` and `source_device` are durable product scope: the device belongs
 * behind another meter, or is itself an active meter source. `unavailable` is
 * transient global/provisional authority and must be surfaced as retryable,
 * never mislabeled as either durable exclusion.
 */
export type SmartTaskHomeScope = 'main' | 'sub_home' | 'source_device' | 'unavailable';
