import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const FILE = fileURLToPath(new URL('../../server/bot-policy.js', import.meta.url));
const CASE = fileURLToPath(new URL('./probe-case.mjs', import.meta.url));
const src = fs.readFileSync(FILE, 'utf8');
const run = () => console.log(execFileSync('node', [CASE], { encoding: 'utf8' }).trimEnd());
try {
  console.log('【改动前】旧的探件条件：');
  fs.writeFileSync(FILE, src.replace(
    'if (mine >= 1 && unseen >= 1 && cards.length >= tuning.pieceProbeMinLength) {',
    'if (unseen >= 2 && cards.length >= tuning.pieceProbeMinLength) {'
  ).replace(
    'if (low) options.push({ card: low, score: cards.length * 10 + mine * 30 });',
    'if (low) options.push({ card: low, score: cards.length * 10 - mine * 2 });'
  ));
  run();
  console.log('\n【改动后】：');
  fs.writeFileSync(FILE, src);
  run();
} finally {
  fs.writeFileSync(FILE, src);
}
