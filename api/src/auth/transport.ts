/**
 * **トークン輸送の契約。** admin/ はこの 2 定数に対して実装する。
 *
 * `x-blog-authorization: Bearer <Cognito ID token>`
 *
 * ## なぜ Authorization ではないのか
 *
 * CloudFront の OAC は `SigningBehavior: always` で動いており、AWS のドキュメントに
 * 『CloudFront signs all origin requests, **overwriting the Authorization header from
 * the viewer request** if one exists』と明記されている。実測でも一致した
 * （bogus な `Authorization: Bearer ...` を付けても `GET /api/health` は 200 のまま。
 * もし転送されていれば Function URL の SigV4 検証が落ちて 403 -> 404 HTML になる）。
 * `no-override` に変える選択肢はあるが、その場合 **viewer 側が Lambda URL のホストに
 * 対して SigV4 署名しなければならず**、ブラウザにはできない。
 *
 * ## なぜ Cookie ではないのか
 *
 * Cookie は転送される（オリジンリクエストポリシー `Managed-AllViewerExceptHostHeader` の
 * `CookieBehavior: all`。実測で `Cookie:` を付けても 200）。**しかし採らない。**
 * Cookie はブラウザが自動で送るため、同一オリジンの `/api/*` に対する CSRF が成立する。
 * カスタムヘッダはクロスオリジンからは preflight 無しに付けられないので、
 * **CSRF が構造的に防がれる**。SPA が Managed Login のリダイレクトからトークンを
 * 受け取る以上 HttpOnly にもできず、Cookie 側に利点が無い。
 *
 * ## なぜこの名前なのか
 *
 * OAC は `x-amz-date` / `x-amz-security-token` / `x-amz-content-sha256` / `Authorization`
 * を自分で付けるので、その名前空間を避ける。全部小文字なのは event.ts が
 * `headers[name.toLowerCase()]` で正規化しているため（1 文字でも大文字が混ざると引けない）。
 */
export const AUTH_HEADER = 'x-blog-authorization';

/** RFC 6750 の Bearer。値の照合は RFC 7235 に従い大文字小文字を区別しない。 */
export const AUTH_SCHEME = 'Bearer';

/** スキームとトークンの区切りは **半角スペース 1 つちょうど**。 */
const SEPARATOR = ' ';

/**
 * 専用ヘッダから Bearer トークンを取り出す。取れなければ `undefined`。
 *
 * **標準の `authorization` にフォールバックしない。** フォールバックがあると、
 * CloudFront が上書きした OAC の SigV4 署名文字列（`AWS4-HMAC-SHA256 Credential=...`）を
 * トークンとしてパースしにいくことになる。
 *
 * **寛容に受け取らない。** 前後の空白も、区切りの二重空白も、トークン後ろの余分な語も
 * 拒否する。寛容にすると「意図した値」と「たまたま通った値」の区別が消える
 * （config.ts の AUTH_MODE と同じ思想）。
 *
 * **Logger を受け取らない。** 引数はヘッダ 1 つだけで、トークンをログに出す経路が
 * 構造的に存在しない。
 */
export const extractBearerToken = (headers: Record<string, string>): string | undefined => {
  const value = headers[AUTH_HEADER];
  if (value === undefined) return undefined;

  const separator = value.indexOf(SEPARATOR);
  if (separator < 0) return undefined;

  const scheme = value.slice(0, separator);
  if (scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) return undefined;

  const token = value.slice(separator + SEPARATOR.length);
  if (token.length === 0) return undefined;
  // 空白が 1 文字でも残っていたら、区切りが二重・前後に空白・後ろに余分な語のいずれか。
  if (/\s/.test(token)) return undefined;

  return token;
};
