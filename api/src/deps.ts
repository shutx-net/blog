import type { Authorizer } from './auth.ts';
import type { AuthMode } from './config.ts';

/** 1 記事 = 1 コミット。markdown は front matter を含む完成品。 */
export interface PublishInput {
  slug: string;
  markdown: string;
  /** AGENTS.md の Conventional Commits に従う 1 行目。 */
  message: string;
}

export interface PublishResult {
  commitSha: string;
  path: string;
}

export interface PostPublisher {
  publish(input: PublishInput): Promise<PublishResult>;
}

export interface PresignInput {
  contentType: string;
  size: number;
  /** 参考情報。**キーには使わない**（拡張子は content type から導出する）。 */
  filename?: string;
}

export interface PresignResult {
  url: string;
  key: string;
  expiresIn: number;
  /** 署名済みヘッダ。1 つでも送り忘れると S3 は 403 を返すので API 側から明示する。 */
  requiredHeaders: Record<string, string>;
}

export interface MediaPresigner {
  presign(input: PresignInput): Promise<PresignResult>;
}

export interface SecretVersionOptions {
  /** 'AWSPENDING' を指すと鍵ローテーションの検証ができる（DEVELOPERS.md）。 */
  versionStage?: string;
}

export interface SecretReader {
  readPrivateKey(options?: SecretVersionOptions): Promise<string>;
}

export interface InstallationTokenProvider {
  getToken(options?: SecretVersionOptions): Promise<string>;
}

/** 秘密を絶対に渡さない前提のロガー。テストは受け取った全引数を走査する。 */
export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * ルータがハンドラに渡す依存一式。
 *
 * **引数で受け取る形にしているのは、テストがスパイを差し込んで
 * 「認可されないとき 1 度も呼ばれない」ことを主張できるようにするため。**
 * モジュールスコープで生成すると、この主張が構造的に不可能になる。
 */
export interface Deps {
  authorizer: Authorizer;
  publisher: PostPublisher;
  presigner: MediaPresigner;
  secretReader: SecretReader;
  tokenProvider: InstallationTokenProvider;
  logger: Logger;
  authMode: AuthMode;
  /** 注入するクロック（ミリ秒）。Date.now() を関数内で読むと時計依存のテストになる。 */
  now: () => number;
}
