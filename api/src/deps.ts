import type { Authorizer } from './auth.ts';
import type { AuthMode } from './config.ts';

/** 1 記事 = 1 コミット。markdown は front matter を含む完成品。 */
export interface PublishInput {
  slug: string;
  markdown: string;
  /** 新規作成のときのコミットメッセージ。AGENTS.md の Conventional Commits に従う 1 行目。 */
  createMessage: string;
  /**
   * 既存を置き換えたときのコミットメッセージ。
   *
   * **2 本受け取るのは、どちらになるかを publisher しか知らないから。** 存在確認は
   * publisher の中（コミットと同じ base）で行うので、ルータは事前に判定できない。
   * 1 本にして overwrite から推測すると、承認の合間に記事が消えた場合に
   * 「更新」と書かれた作成コミットが残る。
   */
  replaceMessage: string;
  /**
   * 既存のスラッグを置き換えてよいか。**必須。**
   *
   * 省略可能にしない。既定値をここに持たせると、新しい呼び出し側が「上書きするか」を
   * 考えないまま書けてしまう。既定の決定は validateOverwrite が 1 箇所で持つ。
   */
  overwrite: boolean;
}

export interface PublishResult {
  commitSha: string;
  path: string;
  /** 既存の記事を置き換えたか。**overwrite の要求ではなく、実際に起きたこと。** */
  replaced: boolean;
}

/**
 * 201 のレスポンスボディ。
 *
 * **deployTriggered を PublishResult に混ぜないのは、publisher が関与しないから。**
 * publisher の責務はコミットまでで、デプロイの起動はルータが publisher の外で行う。
 * 同じ型にすると「publisher が設定し忘れた undefined」と「dispatch が無効」が
 * 区別できなくなる。
 */
export interface PublishResponse extends PublishResult {
  /**
   * デプロイの起動に成功したか。**dispatch を試みたときだけ現れる。**
   *
   * キーが無い = dispatch が無効（DEPLOY_WORKFLOW_FILE 未設定）。
   * false = 記事はコミット済みだがワークフローが起動していない。
   */
  deployTriggered?: boolean;
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

/**
 * デプロイのワークフローを起動する。
 *
 * 記事が別リポジトリに移ると code repo には push が起きないので、
 * `on: push` では発火しない。これが唯一の起動経路になる。
 */
export interface DeployDispatcher {
  dispatch(): Promise<void>;
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
  /**
   * デプロイの起動器。**未設定なら dispatch しない。**
   *
   * オプショナルにしているのが opt-in の実体である。記事がまだ code repo に
   * あるあいだは push でデプロイが走るので、ここで起動すると同じコミットに
   * 対してデプロイが 2 本走る。
   */
  deployDispatcher?: DeployDispatcher;
  /** 注入するクロック（ミリ秒）。Date.now() を関数内で読むと時計依存のテストになる。 */
  now: () => number;
}
