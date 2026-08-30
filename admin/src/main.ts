import './styles.css';

import { createStubAuthTransport } from './auth/session.ts';
import { createApp } from './editor/app.ts';
import { renderPreview } from './preview/pipeline.ts';

/**
 * Vite のエントリ。**実物を組み立てて createApp に渡すだけ。**
 *
 * `api/src/index.ts` と同じ思想で、ここに条件分岐を書かない。書いた瞬間に
 * そこがテストできない領域になる（ブラウザが無いので main.ts 自体は実行して
 * 確かめられない）。判断はすべて app.ts / bind.ts の側にあり、あちらは
 * すべての依存を引数で受け取るので DOM テストから駆動できる。
 *
 * **認証を差し替えるときに触るのはこのファイルの 1 行と auth/session.ts だけ。**
 */
const root = document.querySelector<HTMLElement>('#editor');
if (root === null) throw new Error('admin: #editor が見つからない');

createApp({
  root,
  auth: createStubAuthTransport(),
  renderPreview,
  now: () => Date.now(),
});
