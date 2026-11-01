/**
 * Parses the YAML subset Fri Nettleie's tariff files use
 * (https://github.com/kraftsystemet/fri-nettleie, `tariffer/*.yml`): block maps,
 * block lists of scalars or maps, flow lists of scalars, quoted and plain
 * scalars, numbers, booleans, null and comments. Anything else throws, so a
 * format change reads as an unreadable file rather than as a wrong tariff.
 *
 * A general YAML parser costs about 0.6–1.4 MB of retained heap on the Homey;
 * this one costs next to nothing. `npm run check:grid-tariffs` parses every
 * published file with it each week.
 */

/* eslint-disable functional/immutable-data, no-param-reassign -- A line parser builds its result in place. */

type Line = { indent: number; text: string };

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const UNSUPPORTED_START = /^[{}&*!|>%@`]/;

const splitFlowList = (inner: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ',') {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
};

const parseScalar = (raw: string): unknown => {
  const text = raw.trim();
  if (text === '' || text === '~' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) throw new Error(`Unterminated scalar: ${text}`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('"')) return JSON.parse(text) as unknown;
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw new Error(`Unterminated flow list: ${text}`);
    const inner = text.slice(1, -1).trim();
    return inner === '' ? [] : splitFlowList(inner).map(parseScalar);
  }
  if (NUMBER.test(text)) return Number(text);
  if (UNSUPPORTED_START.test(text)) throw new Error(`Unsupported scalar: ${text}`);
  return text;
};

const stripComment = (line: string): string => {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
      return line.slice(0, i);
    }
  }
  return line;
};

const splitKey = (text: string): { key: string; rest: string } | null => {
  const match = /^([^\s:'"][^:]*?|'[^']*'|"[^"]*"):(\s+|$)(.*)$/.exec(text);
  if (!match) return null;
  return { key: String(parseScalar(match[1] ?? '')), rest: match[3] ?? '' };
};

const isListItem = (line: Line): boolean => line.text === '-' || line.text.startsWith('- ');

/** The document `source` holds, as plain objects, arrays and scalars. */
export const parseFriNettleieYaml = (source: string): unknown => {
  const lines: Line[] = source.split(/\r?\n/)
    .map(stripComment)
    .filter((line) => line.trim() !== '' && line.trim() !== '---')
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  let index = 0;

  const parseBlock = (indent: number): unknown => {
    const first = lines[index];
    if (!first || first.indent < indent) return null;
    return isListItem(first) ? parseList(first.indent) : parseMap(first.indent, {});
  };

  const parseValue = (rest: string, parentIndent: number): unknown => {
    if (rest.trim() !== '') return parseScalar(rest);
    const next = lines[index];
    if (!next) return null;
    // A block list may sit at the same indent as its key.
    if (next.indent > parentIndent || (next.indent === parentIndent && isListItem(next))) {
      return parseBlock(next.indent);
    }
    return null;
  };

  function parseMap(indent: number, map: Record<string, unknown>): Record<string, unknown> {
    while (index < lines.length && lines[index]?.indent === indent && !isListItem(lines[index] as Line)) {
      const line = lines[index] as Line;
      const entry = splitKey(line.text);
      if (!entry) throw new Error(`Expected a key: ${line.text}`);
      index += 1;
      map[entry.key] = parseValue(entry.rest, indent);
    }
    return map;
  }

  function parseList(indent: number): unknown[] {
    const list: unknown[] = [];
    while (index < lines.length && lines[index]?.indent === indent && isListItem(lines[index] as Line)) {
      const line = lines[index] as Line;
      const itemText = line.text.replace(/^-\s*/, '');
      const itemIndent = indent + (line.text.length - itemText.length);
      index += 1;
      const entry = itemText.startsWith("'") || itemText.startsWith('"') ? null : splitKey(itemText);
      if (itemText === '') {
        list.push(parseBlock(indent + 1));
      } else if (entry) {
        // "- key: value" opens a map whose further keys sit at the item's indent.
        list.push(parseMap(itemIndent, { [entry.key]: parseValue(entry.rest, itemIndent) }));
      } else {
        list.push(parseScalar(itemText));
      }
    }
    return list;
  }

  const document = parseBlock(0);
  const unparsed = lines[index];
  if (unparsed) throw new Error(`Unparsed line: ${unparsed.text}`);
  return document;
};
