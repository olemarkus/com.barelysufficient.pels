/**
 * The owner's Homey Energy price formula: parsed into a closure tree, then
 * evaluated against each price period.
 *
 * Homey hands an app RAW SPOT prices and nothing else: `pricesPerInterval` in
 * `manager/energy/price/electricity/dynamic` carries the wholesale value, while
 * the owner's grid tariff, taxes and VAT live separately as a math expression
 * under `.../dynamic/user-costs` (export: `.../dynamic/exported-user-costs`).
 * Homey applies that expression inside its OWN features — the current-price
 * Flow token, the cheapest-hours cards, the day high/low/average — and exposes
 * no route that returns a per-interval series with it applied (verified against
 * firmware 13.5 on the test Homey, and confirmed live: setting the expression
 * to `1 + [[price]]` moved `highestPriceWithUserCosts` from 1.3117 to 2.3117
 * while every `pricesPerInterval` value stayed at the raw 1.3117). The firmware
 * says this is deliberate — consumers are expected to apply the expression on
 * read, and Homey's own mobile app does exactly that.
 *
 * So does this module. Without it, a Homey Energy owner whose formula adds
 * tariff and tax is planned against bare wholesale spot: too low in absolute
 * terms, and — because a VAT multiplier scales the gaps too — with the hour-to-
 * hour differences that drive shifting compressed.
 *
 * ## Why a parser and not mathjs
 *
 * The expression is free-form: Homey's guided modes emit predictable text
 * (`{{ (a + [[price]]) * b }}` for tariff and tax, `{{ [[importPrice]] - n }}`
 * for the export offset), but its Formula mode stores whatever the owner types,
 * validated only by evaluating it once at `price = 1`. Pulling mathjs in to
 * cover that would be a large dependency, carried permanently, inside an app
 * whose resident memory Homey kills at ~160 MB — to evaluate arithmetic.
 *
 * This parser covers `+ - * / ^`, parentheses, unary signs, decimal literals
 * and the two price tokens — every formula the guided modes can produce and
 * every ordinary hand-written one. Anything else (a function call, an unknown
 * name) does not compile, and the caller gets `null`: an explicit "this price
 * is unavailable", never a silent partial evaluation. Same for an expression
 * that parses but evaluates non-finite at some spot value — division by zero
 * reaches `Infinity`, not a throw — which is the firmware's own rule
 * (`evaluatePriceMathExpression` rejects a non-finite result centrally).
 */

/**
 * The inputs a formula may reference.
 *
 * `spot` is `[[price]]`, the raw wholesale value for the interval.
 * `importPrice` is `[[importPrice]]`, the all-in import price (spot with the
 * import formula already applied) — available only to an export formula, which
 * is why it is optional here. An import formula that referenced it would be
 * rejected by Homey at write time; one that somehow does anyway evaluates to
 * `null` rather than to a number built from a missing input.
 */
export type PriceFormulaInputs = {
  spot: number;
  importPrice?: number;
};

/** A parsed formula, ready to evaluate against any number of intervals. */
export type CompiledPriceFormula = {
  /** The resolved price, or `null` when this formula cannot price these inputs. */
  evaluate(inputs: PriceFormulaInputs): number | null;
};

type Node = (inputs: PriceFormulaInputs) => number;

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'name'; value: string }
  | { kind: 'operator'; value: '+' | '-' | '*' | '/' | '^' | '(' | ')' };

/**
 * The two ways a formula fails, as one type because they are raised from the
 * same recursive walk and never escape this module.
 *
 * `syntax` is a compile-time verdict: the text is not arithmetic this evaluator
 * can reproduce. `missing-input` is an evaluate-time one — a reference to an
 * input the caller did not supply, e.g. `[[importPrice]]` in an import formula
 * — and cannot be decided at compile time, because the same compiled formula is
 * valid for inputs that do carry the value.
 */
class FormulaError extends Error {
  constructor(readonly kind: 'syntax' | 'missing-input', message: string) {
    super(message);
  }
}

type OperatorSymbol = '+' | '-' | '*' | '/' | '^' | '(' | ')';

const OPERATORS: readonly string[] = ['+', '-', '*', '/', '^', '(', ')'];

/**
 * Whitespace, a decimal literal, a name, or one operator character.
 *
 * Decimals may lead with a dot (`.05`), which Homey's Formula mode accepts.
 * Deliberately no exponent syntax (`1e-2`): the `e` is indistinguishable from a
 * name here, and no price formula needs it. Anything the pattern does not match
 * is left uncovered, which is how an unexpected character is detected below —
 * `matchAll` silently skips it.
 */
const TOKEN_PATTERN = /\s+|\d+(?:\.\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[+\-*/^()]/g;

const toToken = (text: string): Token => {
  if (OPERATORS.includes(text)) return { kind: 'operator', value: text as OperatorSymbol };
  // `.05` is as valid as `0.05` and Homey's Formula mode accepts it; reading it
  // as an operator would drop every price the formula touches.
  if (/^[\d.]/.test(text)) return { kind: 'number', value: Number(text) };
  return { kind: 'name', value: text };
};

const tokenize = (text: string): Token[] => {
  const matches = [...text.matchAll(TOKEN_PATTERN)].map((match) => match[0]);
  const covered = matches.reduce((total, match) => total + match.length, 0);
  if (covered !== text.length) throw new FormulaError('syntax', 'Unexpected character');
  return matches.filter((match) => match.trim() !== '').map(toToken);
};

/**
 * Recursive-descent parse into a closure tree. Precedence, lowest first:
 * `+ -`, then `* /`, then unary `+ -`, then right-associative `^`.
 */
const parse = (tokens: Token[]): Node => {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];

  const takeOperator = (...candidates: string[]): string | null => {
    const token = peek();
    if (token?.kind === 'operator' && candidates.includes(token.value)) {
      position += 1;
      return token.value;
    }
    return null;
  };

  const parseExpression = (): Node => {
    let left = parseTerm();
    for (;;) {
      const operator = takeOperator('+', '-');
      if (!operator) return left;
      const right = parseTerm();
      const leftNode = left;
      left = operator === '+'
        ? (inputs) => leftNode(inputs) + right(inputs)
        : (inputs) => leftNode(inputs) - right(inputs);
    }
  };

  const parseTerm = (): Node => {
    let left = parseUnary();
    for (;;) {
      const operator = takeOperator('*', '/');
      if (!operator) return left;
      const right = parseUnary();
      const leftNode = left;
      left = operator === '*'
        ? (inputs) => leftNode(inputs) * right(inputs)
        : (inputs) => leftNode(inputs) / right(inputs);
    }
  };

  const parseUnary = (): Node => {
    const operator = takeOperator('+', '-');
    if (operator === '-') {
      const operand = parseUnary();
      return (inputs) => -operand(inputs);
    }
    if (operator === '+') return parseUnary();
    return parsePower();
  };

  const parsePower = (): Node => {
    const base = parsePrimary();
    if (!takeOperator('^')) return base;
    // Right-associative, and the exponent may carry its own sign: `2 ^ -1`.
    const exponent = parseUnary();
    return (inputs) => base(inputs) ** exponent(inputs);
  };

  const parsePrimary = (): Node => {
    const token = peek();
    if (!token) throw new FormulaError('syntax', 'Unexpected end of expression');
    if (token.kind === 'number') {
      position += 1;
      const { value } = token;
      return () => value;
    }
    if (token.kind === 'name') {
      position += 1;
      if (token.value === 'price') return (inputs) => inputs.spot;
      if (token.value === 'importPrice') {
        return (inputs) => {
          if (inputs.importPrice === undefined) {
            throw new FormulaError('missing-input', 'importPrice not supplied');
          }
          return inputs.importPrice;
        };
      }
      // Anything else is a name this evaluator cannot resolve — a mathjs
      // function or constant the owner typed in Formula mode. Refusing to
      // compile is the whole point: a guess here becomes a planning price.
      throw new FormulaError('syntax', `Unknown name '${token.value}'`);
    }
    if (token.value === '(') {
      position += 1;
      const inner = parseExpression();
      if (!takeOperator(')')) throw new FormulaError('syntax', 'Missing closing parenthesis');
      return inner;
    }
    throw new FormulaError('syntax', `Unexpected operator '${token.value}'`);
  };

  const root = parseExpression();
  if (position !== tokens.length) throw new FormulaError('syntax', 'Trailing input after expression');
  return root;
};

/**
 * Compile one of Homey's math expressions, e.g. `{{ (0.4 + [[price]]) * 1.25 }}`.
 *
 * Returns `null` for anything this evaluator cannot faithfully reproduce — a
 * non-string, an empty expression, a syntax error, an unknown name. A `null`
 * here means the owner's prices are unavailable, which is the honest answer;
 * it must never be read as "no formula configured" (that is an absent
 * expression, and it leaves raw spot correct as-is).
 */
export const compilePriceFormula = (expression: unknown): CompiledPriceFormula | null => {
  if (typeof expression !== 'string') return null;
  const normalized = expression
    .replaceAll('{{', ' ')
    .replaceAll('}}', ' ')
    .replaceAll('[[price]]', ' price ')
    .replaceAll('[[importPrice]]', ' importPrice ')
    .trim();
  if (!normalized) return null;
  let root: Node;
  try {
    root = parse(tokenize(normalized));
  } catch (error) {
    if (error instanceof FormulaError) return null;
    throw error;
  }
  return {
    evaluate: (inputs) => {
      if (!Number.isFinite(inputs.spot)) return null;
      try {
        const value = root(inputs);
        return Number.isFinite(value) ? value : null;
      } catch (error) {
        if (error instanceof FormulaError) return null;
        throw error;
      }
    },
  };
};
