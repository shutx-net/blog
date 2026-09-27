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

/**
 * 既存記事の差し替え。**新規作成には使わない。**
 *
 * `PublishInput` と分けているのは、**`sha` を省略できない形にするため。**
 * 1 つの型に `sha?: string` として混ぜると、作成経路が省略するのに倣って
 * 更新経路でも省略できてしまい、楽観的並行制御を外して呼べる経路ができる。
 */
export interface UpdateInput {
  /**
   * 差し替える記事のスラッグ。**pubDate から導出し直した値ではない。**
   *
   * front matter の pubDate がファイル名と食い違う記事（`blog-content` を手で
   * 編集すれば作れる）を編集したとき、導出値を使うと**別のパスに書いて
   * 新しい記事を作ってしまう**。読んだときのパスをそのまま使う。
   */
  slug: string;
  markdown: string;
  /** コミットメッセージ。更新は常に差し替えなので 1 本だけ受ける。 */
  message: string;
  /**
   * 呼び出し側が読んだときの blob sha。**省略不可。**
   *
   * 一致しなければ `StalePostError` になる。読んでから書くまでの間に
   * 別の経路が同じ記事を変えていたら、その変更を踏み潰さずに落とす。
   */
  sha: string;
}

/**
 * 既存記事の削除。**これが唯一の破壊的操作。**
 *
 * `UpdateInput` と同じ理由で `sha` を必須にしている。削除は取り消せないので、
 * 「読んだときと同じものを消している」ことを確かめずに実行させない。
 */
export interface DeleteInput {
  /** 消す記事のスラッグ。**`UpdateInput.slug` と同じく、読んだときのパス。** */
  slug: string;
  /** コミットメッセージ。削除は 1 種類なので 1 本だけ受ける。 */
  message: string;
  /** 呼び出し側が読んだときの blob sha。**省略不可。** */
  sha: string;
}

export interface PostPublisher {
  publish(input: PublishInput): Promise<PublishResult>;
  update(input: UpdateInput): Promise<PublishResult>;
  remove(input: DeleteInput): Promise<PublishResult>;
}

/**
 * 一覧に出す 1 記事。**body を含まない。**
 *
 * 一覧は記事数ぶんの blob 取得になるので、本文まで返すと転送量が記事の長さに比例する。
 * 編集のために本文が要るのは 1 本だけなので、そこは `PostDetail` が担う。
 */
export interface PostSummary {
  /** `DATE_SLUG_PATTERN` に合致する日付パス。ファイル名から復元した値。 */
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  draft: boolean;
  tags: string[];
  /**
   * blob の sha。**楽観的並行制御のトークン。**
   *
   * 更新・削除のときに「読んだときと同じ中身か」を確かめるために使う。
   * commit の sha ではなく blob の sha なので、他の記事が変わっても無効にならない。
   */
  sha: string;
}

export interface PostDetail extends PostSummary {
  body: string;
}

/**
 * 記事を読む。**書き込みは一切しない。**
 *
 * publisher と別の interface にしているのは、認可されないときに
 * 「どちらも呼ばれない」ことを個別に主張できるようにするため。
 */
export interface PostReader {
  list(): Promise<PostSummary[]>;
  read(slug: string): Promise<PostDetail>;
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
  /**
   * 記事の読み取り。**必須にしている。**
   *
   * オプショナルにすると、新しい呼び出し側が組み立てを忘れても型が通り、
   * 一覧が「常に空」で静かに動く経路ができる。
   */
  reader: PostReader;
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
