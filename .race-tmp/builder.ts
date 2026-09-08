import { buildApiBundle } from '../api/build.ts';
const [, , dir, ms] = process.argv;
const deadline = Date.now() + Number(ms);
const entries = [`${dir}/src/a.ts`, `${dir}/src/b.ts`];
let i = 0;
while (Date.now() < deadline) {
  buildApiBundle({ entry: entries[i++ % 2], outfile: `${dir}/out/index.mjs` });
}
