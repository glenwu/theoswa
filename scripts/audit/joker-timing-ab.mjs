import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const FILE = fileURLToPath(new URL('../../server/bot-policy.js', import.meta.url));
const CASE = fileURLToPath(new URL('./joker-timing-case.mjs', import.meta.url));
const N = process.argv[2] ?? '10';
const src = fs.readFileSync(FILE, 'utf8');
const run = () => console.log(execFileSync('node', [CASE, N], { encoding: 'utf8' }).trimEnd());
try {
  console.log('【改动前】：');
  fs.writeFileSync(FILE, src
    .replace('const withoutJokers = trumps.filter(card => card.rank !== 15 && card.rank !== 16);\n  return highCards(withoutJokers.length ? withoutJokers : trumps, 1, ctx)[0];',
             'return highCards(trumps, 1, ctx)[0];')
    .replace(/        const wasted = cards\.reduce[\s\S]*?settings\.controlReserve \* controlCaution;/,
             '        score -= 15;'));
  run();
  console.log('\n【改动后】：');
  fs.writeFileSync(FILE, src);
  run();
} finally { fs.writeFileSync(FILE, src); }
