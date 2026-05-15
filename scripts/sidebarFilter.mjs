function isInternalLink(link) {
  return typeof link === 'string' && link.startsWith('/');
}

export function splitArrayEntries(arrayLiteral) {
  const entries = [];
  let depth = 0;
  let current = '';
  let inString = null;
  let escaped = false;

  for (const ch of arrayLiteral) {
    if (inString) {
      current += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      current += ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;

    if (ch === ',' && depth === 0) {
      entries.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  entries.push(current);
  return entries;
}

export function matchNestedItems(entry) {
  const keyMatch = entry.match(/items\s*:\s*\[/);
  if (!keyMatch) return null;

  const startIdx = keyMatch.index + keyMatch[0].length;
  let depth = 1;
  let i = startIdx;
  let inString = null;
  let escaped = false;

  while (i < entry.length && depth > 0) {
    const ch = entry[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
    } else if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    i += 1;
  }

  if (depth !== 0) return null;

  return {
    inner: entry.slice(startIdx, i - 1),
    fullMatch: entry.slice(keyMatch.index, i),
  };
}

function extractOwnLink(entry, nestedMatch) {
  const stripped = nestedMatch ? entry.replace(nestedMatch.fullMatch, '') : entry;
  const m = stripped.match(/link\s*:\s*(['"`])([^'"`]+)\1/);
  return m ? m[2] : undefined;
}

export async function filterArrayLiteral(arrayLiteral, pageExists) {
  const entries = splitArrayEntries(arrayLiteral);
  const kept = [];

  for (const entry of entries) {
    if (!entry.trim()) continue;

    const nestedMatch = matchNestedItems(entry);

    if (nestedMatch) {
      // Section with children — recurse first so the entry-level link check
      // never sees nested children's links. Drop the section only when every
      // child is also dropped.
      const filteredNested = await filterArrayLiteral(nestedMatch.inner, pageExists);
      if (filteredNested.trim().length === 0) continue;
      kept.push(entry.replace(nestedMatch.fullMatch, `items: [${filteredNested}]`));
      continue;
    }

    const ownLink = extractOwnLink(entry, null);
    if (ownLink !== undefined && isInternalLink(ownLink) && !(await pageExists(ownLink))) {
      continue;
    }

    kept.push(entry);
  }

  return kept.join(',');
}

export async function rewriteSidebarSource(source, pageExists) {
  const patterns = [
    /(\bexport\s+const\s+navItems\s*:[^=]+=\s*\[)([\s\S]*?)(\];)/,
    /(\bexport\s+const\s+sidebar\s*:[^=]+=\s*\[)([\s\S]*?)(\];)/,
  ];

  let rewritten = source;
  for (const pattern of patterns) {
    const match = rewritten.match(pattern);
    if (!match) continue;
    const filtered = await filterArrayLiteral(match[2], pageExists);
    rewritten = rewritten.replace(pattern, `$1${filtered}$3`);
  }

  return rewritten;
}
