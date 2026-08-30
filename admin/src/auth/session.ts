/**
 * **認証の継ぎ目。認証に関する知識はこのファイルの外に 1 行も無い。**
 *
 * 実装（Cognito・トークンの取得・リフレッシュ・輸送方式の決定）は別エージェントの
 * 担当で、決まったらこのファイルだけを差し替える。他のすべてのテストは偽の
 * transport を注入するので、実装が決まっても 1 ファイルの差し替えで済む。
 * test/unit/auth-seam.test.ts がその構造を機械的に固定している。
 *
 * ## 置いている仮定
 *
 * a) admin と `/api/*` は**同一オリジン**（同じ CloudFront ディストリビューション
 *    配下）なので、API 呼び出しに CORS は要らない。
 * b) 輸送方式は「リクエストヘッダの集合」か「`credentials` モード（Cookie）」の
 *    どちらかに落ちる。`AuthTransport` の 3 メンバはその両方を表現できる。
 * c) **`Authorization` は使えない。** CloudFront は OAC の SigV4
 *    （`SigningBehavior: always`）で閲覧者の `Authorization` を上書きするので、
 *    ここに書いても届かない。カスタムヘッダ（例 `x-blog-authorization`）か Cookie。
 *    `/api/*` のビヘイビアは既に `ALL_VIEWER_EXCEPT_HOST_HEADER` を使っている
 *    （infra/lib/site-stack.ts）ので、カスタムヘッダ方式なら infra の変更は要らない。
 * d) トークン取得の手順は全部このモジュールの内側で完結する。
 */
export interface AuthTransport {
  /**
   * 各リクエストに足すヘッダ。
   *
   * **`authorization` を返してはいけない**（上の仮定 c）。返した場合、
   * api/client.ts が黙って無視するのではなく **例外を投げる** —
   * CloudFront に上書きされて「認証が通らない理由が分からない」状態になるより、
   * その場で落ちるほうが直せる。
   */
  authHeaders(): Promise<Record<string, string>>;

  /** Cookie 方式に差し替えたときに `'include'` を効かせるための口。 */
  credentials: RequestCredentials;

  /** 画面の出し分け用。**認可の判断には使わない**（判断は必ずサーバ側）。 */
  isAuthenticated(): boolean;
}

/**
 * 実装が入るまでのスタブ。
 *
 * **何も足さない。** `AUTH_MODE=deny-all` の API は 503 を返すので、admin は
 * 「認証が未設定」と表示するところまでが正しい振る舞いになる。ここで偽の
 * トークンを送ると、認証が入ったときに壊れ方が分かりにくくなるだけ。
 *
 * ## 差し替えるときにやること（このファイルの中だけで完結する）
 *
 * 1. `createStubAuthTransport` を実装版に置き換える（名前は変えてよい）。
 * 2. `src/main.ts` の 1 行を新しいファクトリに向ける。
 * 3. `authHeaders()` が返すヘッダ名を決める。**`authorization` は使えない** —
 *    api/client.ts が例外を投げる。確認済みの選択は
 *    `x-blog-authorization: Bearer <token>` で、`/api/*` は同一オリジンなので
 *    CORS は絡まず、`ALL_VIEWER_EXCEPT_HOST_HEADER` がそのまま転送する。
 *    api 側が `api/src/auth/transport.ts` から `AUTH_HEADER` / `AUTH_SCHEME` を
 *    export する予定なので、**綴りを写さずそこから import すること。**
 * 4. Cookie 方式にするなら `credentials` を `'include'` にするだけでよい。
 *
 * 他のテストはこのスタブに依存していない（すべて偽の transport を注入する）。
 */
export const createStubAuthTransport = (): AuthTransport => ({
  authHeaders: async () => ({}),
  credentials: 'same-origin',
  isAuthenticated: () => false,
});
