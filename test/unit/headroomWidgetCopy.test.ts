import {
  headroomHeldBackLabel,
  headroomLimitStateLabel,
  headroomPriceAriaLabel,
  headroomPriceChipLabel,
} from '../../packages/shared-domain/src/headroomWidgetCopy';

describe('headroomHeldBackLabel', () => {
  it('uses the singular "held back" word for one device', () => {
    expect(headroomHeldBackLabel(1)).toBe('1 held back');
  });

  it('uses "held back" for the plural count', () => {
    expect(headroomHeldBackLabel(3)).toBe('3 held back');
  });
});

describe('headroomLimitStateLabel', () => {
  it('reuses the hero chip vocabulary for the trajectory danger state', () => {
    // Same canonical label as the Overview hero's "Above hard cap" chip — one
    // vocabulary for the same signal across surfaces.
    expect(headroomLimitStateLabel('over_cap')).toBe('Above hard cap');
    expect(headroomLimitStateLabel('at_pace')).toBe('At safe pace');
  });

  it('stays silent for the unexceptional states', () => {
    expect(headroomLimitStateLabel('under')).toBe('');
    expect(headroomLimitStateLabel('near')).toBe('');
  });
});

describe('headroomPriceChipLabel', () => {
  it('reuses the canonical "Price low" / "Price high" pair', () => {
    expect(headroomPriceChipLabel('cheap')).toBe('Price low');
    expect(headroomPriceChipLabel('expensive')).toBe('Price high');
  });

  it('returns an empty chip for normal hours and a dash for unknown', () => {
    expect(headroomPriceChipLabel('normal')).toBe('');
    expect(headroomPriceChipLabel('unknown')).toBe('—');
  });

  it('never re-introduces the retired bare "Cheap" / "Expensive" copy', () => {
    expect(headroomPriceChipLabel('cheap')).not.toBe('Cheap');
    expect(headroomPriceChipLabel('expensive')).not.toBe('Expensive');
  });
});

describe('headroomPriceAriaLabel', () => {
  it('builds a grammatical "Price: <level>" phrase, never "Price Cheap"', () => {
    expect(headroomPriceAriaLabel('cheap')).toBe('Price: low');
    expect(headroomPriceAriaLabel('expensive')).toBe('Price: high');
  });

  it('announces nothing for normal or unknown levels', () => {
    expect(headroomPriceAriaLabel('normal')).toBe('');
    expect(headroomPriceAriaLabel('unknown')).toBe('');
  });
});
