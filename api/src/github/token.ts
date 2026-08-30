import type { InstallationTokenProvider, Logger, SecretReader, SecretVersionOptions } from '../deps.ts';
import { createAppJwt } from './jwt.ts';

export const GITHUB_API_BASE = 'https://api.github.com';

/**
 * 明示的に固定する API バージョン。
 *
 * GET https://api.github.com/versions が返すのは ["2026-03-10","2022-11-28"] の 2 つ。
 * 既定任せにすると将来の破壊的変更を無防備に受ける。
 *
 * **上げるときは Git Data API の 6 エンドポイントの契約テスト
 * （test/unit/github-commit.test.ts）を必ず回すこと。**
 */
export const GITHUB_API_VERSION = '2026-03-10';

/**
 * 期限の何ミリ秒前で取り直すか。
 *
 * TTL ちょうどまで使うと、飛行中のリクエストが GitHub 側で 401 になる。
 * installation token の TTL は 1 時間なので、60 秒の余裕は十分に安い。
 */
const REFRESH_MARGIN_MS = 60_000;

export interface TokenProviderDeps {
  secretReader: SecretReader;
  /** GitHub App の client ID。JWT の iss になる。**秘密ではない。** */
  clientId: string;
  owner: string;
  repo: string;
  logger: Logger;
  /** 注入するクロック（ミリ秒）。 */
  now: () => number;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

/**
 * GitHub の応答本文を **読まない** ままエラーにする。
 *
 * 4xx/5xx の本文をそのまま例外に載せると、将来リクエストをエコーする実装に
 * 変わったときトークンが漏れる。status だけを転記する。
 */
const statusError = (what: string, status: number): Error =>
  new Error(`GitHub ${what} failed with status ${status}`);

/**
 * installation access token の取得器を作る。
 *
 * **キャッシュはクロージャに閉じ込める。** モジュールスコープのミュータブル変数に
 * すると、テスト間で状態が漏れるうえ「provider ごとに独立」を主張できない。
 * Lambda の実行環境が生きている間だけ残り、環境が破棄されれば消える
 * ＝ 設計判断9 の「token は保管しない」。ディスクにも環境変数にも書かない。
 */
export const createTokenProvider = (deps: TokenProviderDeps): InstallationTokenProvider => {
  let cached: CachedToken | undefined;
  // 一度解決したら同居させる。運用者の設定項目が 1 つ減り、App を別リポジトリに
  // インストールし直しても追随する。
  let installationId: number | undefined;

  const request = async (
    method: string,
    path: string,
    jwt: string,
    body?: unknown,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': GITHUB_API_VERSION,
      authorization: `Bearer ${jwt}`,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await fetch(`${GITHUB_API_BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      // **元の例外を素通ししない。** fetch の例外メッセージには URL や、実装によっては
      // リクエストの一部が載る。名前だけを転記する。
      throw new Error(`GitHub request ${method} ${path} failed (${(error as Error).name})`);
    }
  };

  const appJwt = async (options?: SecretVersionOptions): Promise<string> =>
    createAppJwt({
      privateKeyPem: await deps.secretReader.readPrivateKey(options),
      issuer: deps.clientId,
      nowSeconds: Math.floor(deps.now() / 1000),
    });

  const resolveInstallationId = async (jwt: string): Promise<number> => {
    // docs: "You must use a JWT to access this endpoint."
    const response = await request('GET', `/repos/${deps.owner}/${deps.repo}/installation`, jwt);
    if (!response.ok) {
      throw new Error(
        `GitHub App installation lookup for ${deps.owner}/${deps.repo} failed with status ${response.status}`,
      );
    }
    const payload = (await response.json()) as { id?: unknown };
    if (typeof payload.id !== 'number') {
      throw new Error('GitHub App installation response has no numeric id');
    }
    return payload.id;
  };

  const exchange = async (jwt: string, id: number): Promise<Response> =>
    // docs: "If permissions is not specified, the installation access token will have
    // all of the permissions that were granted to the app." — 明示してスコープダウンする。
    // contents: write だけで Git Data API の 6 本すべてが通る（.github/workflows/ を
    // 書くときだけ workflows: write が要るが、本 API は site/ しか書かない）。
    request('POST', `/app/installations/${id}/access_tokens`, jwt, {
      repositories: [deps.repo],
      permissions: { contents: 'write' },
    });

  const attempt = async (
    forceResolve: boolean,
    options?: SecretVersionOptions,
  ): Promise<Response> => {
    const jwt = await appJwt(options);
    if (forceResolve || installationId === undefined) {
      installationId = await resolveInstallationId(jwt);
    }
    return exchange(jwt, installationId);
  };

  const getToken = async (options?: SecretVersionOptions): Promise<string> => {
    // **VersionStage を明示したときはキャッシュを使わない。** 鍵ローテーションの
    // 検証で古い鍵から作ったトークンが返ると、検証したことにならない。
    const bypassCache = options?.versionStage !== undefined;
    const nowMs = deps.now();
    if (!bypassCache && cached !== undefined && cached.expiresAtMs - REFRESH_MARGIN_MS > nowMs) {
      return cached.token;
    }

    let response = await attempt(false, options);
    if (response.status === 401) {
      // App JWT が拒否された（時計ずれ・鍵の入れ替え・installation の移動）。
      // **1 度だけ**やり直す。ここでループを作ると 401 が続く間ずっと回り続ける。
      cached = undefined;
      installationId = undefined;
      deps.logger.warn('installation token exchange returned 401; retrying once');
      response = await attempt(true, options);
    }
    if (!response.ok) throw statusError('access_tokens request', response.status);

    const payload = (await response.json()) as { token?: unknown; expires_at?: unknown };
    // **トークンの長さも形式も検査しない。** GitHub は 2026-04-27 からステートレス形式
    // （ghs_APPID_JWT）へ段階移行しており、「40 文字」の前提は壊れる。不透明な文字列として扱う。
    if (typeof payload.token !== 'string' || payload.token.length === 0) {
      throw new Error('GitHub access_tokens response has no token');
    }
    const expiresAtMs =
      typeof payload.expires_at === 'string' ? Date.parse(payload.expires_at) : Number.NaN;
    if (Number.isNaN(expiresAtMs)) throw new Error('GitHub access_tokens response has no expires_at');

    // **トークンをログに出さない。** 期限だけを記録する。
    deps.logger.info('minted installation access token', { expiresAtMs });
    if (!bypassCache) cached = { token: payload.token, expiresAtMs };
    return payload.token;
  };

  return { getToken };
};
