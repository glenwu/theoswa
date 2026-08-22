import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const FILE = fileURLToPath(new URL('../../server/bot-policy.js', import.meta.url));
const CASE = fileURLToPath(new URL('./kitty-ace-case.mjs', import.meta.url));
const src = fs.readFileSync(FILE, 'utf8');
const run = () => console.log(execFileSync('node', [CASE], { encoding: 'utf8' }).trimEnd());
try {
  console.log('【改动前】把 pieceBurialCost 打回 0：');
  fs.writeFileSync(FILE, src.replace(
    'const unlockCost = pieceBurialCost(hand, buried, ctx);',
    'const unlockCost = 0 * pieceBurialCost(hand, buried, ctx);'
  ));
  run();
  console.log('\n【改动后】：');
  fs.writeFileSync(FILE, src);
  run();
} finally {
  fs.writeFileSync(FILE, src);   // 无论如何都还原
}
