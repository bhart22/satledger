// Loads the pure-JS helper region of app.dev.html (between the React hook destructuring and the
// SVG Icons block) so command-line tools run the very same code the app does.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadAppHelpers(names) {
  const lines = readFileSync(join(ROOT, 'app.dev.html'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex(l => l.includes('const { useState, useEffect'));
  const end = lines.findIndex(l => l.includes('─── SVG Icons'));
  if (start === -1 || end === -1) throw new Error('could not locate the helper region in app.dev.html');
  // The region touches localStorage/crypto only inside functions the tools never call
  globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
  return new Function(`${lines.slice(start + 1, end).join('\n')}\nreturn {${names.join(',')}};`)();
}
