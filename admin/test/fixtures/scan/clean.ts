/**
 * **違反を含まないフィクスチャ。実行されない。**
 *
 * 走査が「何にでも反応する」道具になっていないことの確認。
 * `fetch` という語を**含む**が、呼び出しではない書き方をわざと並べてある —
 * 素朴すぎる正規表現（例 `/fetch/`）ならここで誤検出して落ちる。
 */

/** 語としての fetch はコメントにも識別子にも出てくるが、呼び出しではない。 */
export const description = 'この関数は fetch を呼ばない';

export const prefetchHint = 'prefetch';

/** メソッド呼び出しは許可リストの client 経由なので違反ではない。 */
export interface Caller {
  fetchImpl: (url: string) => Promise<Response>;
}

export const callThroughInjected = async (caller: Caller): Promise<Response> =>
  // ドット付きのメソッド呼び出しは素の fetch ではない。
  caller.fetchImpl('/api/health');

export const notARequest = (): string => 'new Requests are not created here';
