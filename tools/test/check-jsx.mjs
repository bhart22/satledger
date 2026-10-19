// Parses the <script type="text/babel"> block in app.dev.html as JSX.
//
// Because Babel runs in the browser, a syntax error anywhere in that block produces a blank
// page with nothing but a console message — so this is the cheapest way to catch one before
// it ships. Reported line numbers are remapped back onto app.dev.html.
//
//   npm run check
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT } from './lib/harness.mjs';

const file = process.argv[2] ? process.argv[2] : join(REPO_ROOT, 'app.dev.html');
const html = readFileSync(file, 'utf8');

const open = html.indexOf('<script type="text/babel">');
if (open === -1) { console.error('no <script type="text/babel"> block found in ' + file); process.exit(2); }
const start = html.indexOf('>', open) + 1;
const end = html.indexOf('</script>', start);
if (end === -1) { console.error('unterminated babel script block'); process.exit(2); }

const jsx = html.slice(start, end);
const lineOffset = html.slice(0, start).split('\n').length - 1;

const dir = mkdtempSync(join(tmpdir(), 'satledger-jsx-'));
const tmp = join(dir, 'extracted.jsx');
writeFileSync(tmp, jsx);

try {
  execFileSync('npx', ['--yes', 'esbuild@0.25.10', tmp, '--outfile=' + tmp + '.out.js'], {
    stdio: 'pipe', shell: true,
  });
  console.log(`OK — JSX parses (${jsx.split('\n').length} lines, block starts at app.dev.html:${lineOffset + 1})`);
} catch (e) {
  // Remap esbuild's line numbers back onto app.dev.html and strip the temp path, so the reported
  // location is somewhere you can actually go and look.
  const out = (e.stderr || e.stdout || '')
    .toString()
    .replace(/\S*extracted\.jsx:(\d+):/g, (_, n) => `app.dev.html:${Number(n) + lineOffset}:`);
  console.error(out);
  process.exit(1);
}
