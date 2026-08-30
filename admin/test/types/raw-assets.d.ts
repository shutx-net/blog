/**
 * Vite の `?raw` インポート。
 *
 * DOM テストが **実物の index.html** を読むために使う。テスト用に別の HTML を
 * 書き起こすと、フォームの id を index.html だけ変えたときに気づけない。
 *
 * `node:fs` + `fileURLToPath(import.meta.url)` を使わないのは、
 * **jsdom 環境では `import.meta.url` が file: スキームにならず
 * `fileURLToPath` が TypeError で落ちるため**（実測）。`?raw` は Vite が
 * 解決するので環境に依存しない。
 */
declare module '*.html?raw' {
  const content: string;
  export default content;
}
