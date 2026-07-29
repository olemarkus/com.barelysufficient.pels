import { readFileSync } from 'node:fs';
import { classifyChangeImpact } from './lib/change-impact.mjs';

const files = readFileSync(0, 'utf8')
  .split('\n')
  .map((file) => file.trim())
  .filter(Boolean);
const impact = classifyChangeImpact(files);

for (const [name, value] of Object.entries(impact)) {
  console.log(`${name}=${Array.isArray(value) ? value.join(' ') : String(value)}`);
}
