/**
 * **走査関数自身を検証するためのフィクスチャ。実行されない。**
 *
 * ここに書いてある違反を `findRawFetchUsages` が全部見つけられなければ、
 * 走査は「何も検出できないのに緑を出す」道具になっている。
 * test/unit/no-raw-fetch.test.ts がこのファイルを読んで件数を主張する。
 *
 * **このファイルを直さないこと。** 違反が入っているのが仕様。
 */

export const viaBareFetch = async (): Promise<Response> => fetch('/api/health');

export const viaGlobalThis = async (): Promise<Response> => globalThis.fetch('/api/health');

export const viaWindow = async (): Promise<Response> => window.fetch('/api/health');

export const viaRequest = (): Request => new Request('/api/health');

export const viaXhr = (): void => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/health');
  xhr.send();
};

export const viaBeacon = (): boolean => navigator.sendBeacon('/api/health');
