import { describe, expect, it } from 'vitest';
import { compilePriceFormula } from '../../lib/price/priceFormula';

const evaluate = (expression: string, spot: number, importPrice?: number): number | null => {
  const formula = compilePriceFormula(expression);
  if (!formula) return null;
  return formula.evaluate(importPrice === undefined ? { spot } : { spot, importPrice });
};

describe('compilePriceFormula', () => {
  it('applies the guided tariff-and-tax expression Homey stores', () => {
    // The shape Homey's guided import mode emits: a per-kWh addition, then a
    // VAT multiplier over the sum.
    expect(evaluate('{{ (0.4 + [[price]]) * 1.25 }}', 1)).toBeCloseTo(1.75, 10);
  });

  it('applies the guided export offset expression against the all-in import price', () => {
    expect(evaluate('{{ [[importPrice]] - 0.1 }}', 1, 1.75)).toBeCloseTo(1.65, 10);
  });

  it('prices an export formula off raw spot when it references only [[price]]', () => {
    expect(evaluate('{{ [[price]] * 0.9 }}', 2, 2.5)).toBeCloseTo(1.8, 10);
  });

  it('reads an identity expression as the raw spot price', () => {
    // The test Homey's own stored expression.
    expect(evaluate('{{ (0 + [[price]]) * 1 }}', 1.3117)).toBeCloseTo(1.3117, 10);
  });

  it('honours precedence, parentheses and unary signs', () => {
    expect(evaluate('{{ 1 + 2 * 3 }}', 0)).toBe(7);
    expect(evaluate('{{ (1 + 2) * 3 }}', 0)).toBe(9);
    expect(evaluate('{{ -[[price]] + 1 }}', 0.25)).toBeCloseTo(0.75, 10);
    expect(evaluate('{{ 2 ^ 3 ^ 2 }}', 0)).toBe(512);
    expect(evaluate('{{ -2 ^ 2 }}', 0)).toBe(-4);
  });

  it('accepts a decimal written without its leading zero', () => {
    // Homey's Formula mode takes `.05`; reading the dot as an operator would
    // drop every price the formula touches.
    expect(evaluate('{{ [[price]] + .05 }}', 1)).toBeCloseTo(1.05, 10);
    expect(evaluate('{{ [[price]] * .9 }}', 2)).toBeCloseTo(1.8, 10);
  });

  it('prices a negative spot hour without clamping', () => {
    expect(evaluate('{{ (0.4 + [[price]]) * 1.25 }}', -0.6)).toBeCloseTo(-0.25, 10);
  });

  it('does not compile an expression naming something it cannot resolve', () => {
    // Homey's free Formula mode accepts any mathjs expression; anything this
    // evaluator cannot reproduce must refuse rather than guess.
    expect(compilePriceFormula('{{ max([[price]], 0) }}')).toBeNull();
    expect(compilePriceFormula('{{ [[price]] * vat }}')).toBeNull();
  });

  it('does not compile malformed or empty input', () => {
    expect(compilePriceFormula('{{ (1 + [[price]] }}')).toBeNull();
    expect(compilePriceFormula('{{ 1 + }}')).toBeNull();
    expect(compilePriceFormula('{{ 1 2 }}')).toBeNull();
    expect(compilePriceFormula('{{ }}')).toBeNull();
    expect(compilePriceFormula('')).toBeNull();
    expect(compilePriceFormula(null)).toBeNull();
    expect(compilePriceFormula(42)).toBeNull();
  });

  it('reports no price when the expression needs an import price the caller lacks', () => {
    // An import formula can never reference [[importPrice]] (Homey rejects it
    // at write time); if one somehow does, the answer is "unavailable", never a
    // number built from a missing input.
    expect(evaluate('{{ [[importPrice]] - 0.1 }}', 1)).toBeNull();
  });

  it('reports no price when the spot value is not finite', () => {
    expect(evaluate('{{ (0.4 + [[price]]) * 1.25 }}', Number.NaN)).toBeNull();
    expect(evaluate('{{ (0.4 + [[price]]) * 1.25 }}', Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('reports no price when a valid expression evaluates non-finite', () => {
    // Division by zero yields Infinity rather than throwing; the firmware
    // rejects it centrally and so does this.
    expect(evaluate('{{ 1 / [[price]] }}', 0)).toBeNull();
  });

  it('compiles once and prices many intervals', () => {
    const formula = compilePriceFormula('{{ (0.4 + [[price]]) * 1.25 }}');
    expect(formula).not.toBeNull();
    const prices = [1, 2, 3].map((spot) => formula?.evaluate({ spot }));
    expect(prices).toEqual([1.75, 3, 4.25]);
  });
});
