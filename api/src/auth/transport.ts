/**
 * **トークン輸送の契約。** admin/ はこの 2 定数に対して実装する。
 *
 * `x-blog-authorization: Bearer <Cognito ID token>`
 *
 * ## なぜ Authorization ではないのか
 *
 * OAC は `SigningBehavior: always` で動いており、AWS のドキュメントに『CloudFront signs all
 * origin requests, **overwriting the Authorization header from the viewer request** if one
 * exists』と明記されている。実測でも一致（bogus な `Authorization: Bearer ...` を付けても
 * `GET /api/health` は 200 のまま。転送されていれば Function URL の SigV4 検証が落ちて
 * 403 -> 404 HTML になる）。`no-override` に変えると **viewer 側が Lambda URL のホストに
 * SigV4 署名しなければならず**、ブラウザにはできない。
 *
 * ## なぜ Cookie ではないのか
 *
 * Cookie は転送される（`Managed-AllViewerExceptHostHeader` の `CookieBehavior: all`。実測で
 * `Cookie:` を付けても 200）。**しかし採らない。** ブラウザが自動で送るため同一オリジンの
 * `/api/*` に対する CSRF が成立する。カスタムヘッダはクロスオリジンから preflight 無しに
 * 付けられないので **CSRF が構造的に防がれる**。SPA が Managed Login のリダイレクトから
 * トークンを受け取る以上 HttpOnly にもできず、Cookie 側に利点が無い。
 *
 * ## なぜこの名前なのか
 *
 * OAC は `x-amz-date` / `x-amz-security-token` / `x-amz-content-sha256` / `Authorization` を
 * 自分で付けるので、その名前空間を避ける。全部小文字なのは event.ts が
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
 * **標準の `authorization` にフォールバックしない。** あると、CloudFront が上書きした OAC の
 * SigV4 署名文字列（`AWS4-HMAC-SHA256 Credential=...`）をトークンとしてパースしにいく。
 *
 * **寛容に受け取らない。** 前後の空白も、区切りの二重空白も、トークン後ろの余分な語も拒否
 * する。寛容にすると「意図した値」と「たまたま通った値」の区別が消える（config.ts の
 * AUTH_MODE と同じ思想）。**Logger を受け取らない** — 引数はヘッダ 1 つだけで、トークンを
 * ログに出す経路が構造的に存在しない。
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
