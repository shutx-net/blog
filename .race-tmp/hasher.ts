import { FileSystem } from 'aws-cdk-lib/core';
const [, , dir, ms] = process.argv;
const deadline = Date.now() + Number(ms);
let loops = 0;
const errors: string[] = [];
while (Date.now() < deadline) {
  loops += 1;
  try { FileSystem.fingerprint(`${dir}/out`); }
  catch (e) { errors.push((e as Error).message); }
}
// loops と件数を必ず出す。0 周なら「再現せず」ではなく「動いていない」。
console.log(JSON.stringify({ loops, count: errors.length, sample: errors.slice(0, 2) }));
