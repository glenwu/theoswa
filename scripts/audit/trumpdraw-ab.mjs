import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const FILE = fileURLToPath(new URL('../../server/bot-policy.js', import.meta.url));
const CASE = fileURLToPath(new URL('./trumpdraw-case.mjs', import.meta.url));
const N = process.argv[2] ?? '12';
const src = fs.readFileSync(FILE, 'utf8');
const run = () => console.log(execFileSync('node', [CASE, N], { encoding: 'utf8' }).trimEnd());
try {
  console.log('【改动前】关掉持续吊主提案：');
  fs.writeFileSync(FILE, src.replace('    if (drawBonus > 0) {', '    if (false && drawBonus > 0) {'));
  run();
  console.log('\n【改动后】：');
  fs.writeFileSync(FILE, src);
  run();
} finally { fs.writeFileSync(FILE, src); }
