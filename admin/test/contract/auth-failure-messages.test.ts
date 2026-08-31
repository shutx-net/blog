import { AUTH_FAILURE_REASONS, AUTH_FAILURE_RESPONSES } from '@blog/api/src/auth.ts';
import { describe, expect, it } from 'vitest';

import { AUTH_FAILURE_MESSAGES } from '../../src/editor/app.ts';

/**
 * **admin の文言表と api の拒否コードが 1 対 1 で対応していることの突き合わせ。**
 *
 * # なぜ import ではなく突き合わせなのか
 *
 * `app.ts` から `@blog/api/src/auth.ts` を import すれば綴りを書き写さずに済むが、
 * **あのモジュールは `./auth/cognito.ts` 経由で `aws-jwt-verify` を引き込む。**
 * import するとそれがブラウザのバンドルに入り、「ブラウザに配る依存を増やさない」
 * という Phase 4 からの判断に反する（`test/unit/toolchain.test.ts` が
 * dependencies を 1 本に固定しているのも同じ理由）。
 *
 * **そこで実行時の結合は作らず、テストだけが両方を読む。** これは
 * `test/contract/post-schema.test.ts` が site の postSchema と api の
 * バリデータを突き合わせているのと同じ形で、この contract プロジェクトが
 * node 環境である理由でもある。
 *
 * api が拒否コードを 1 つでも足せば、ここが赤くなる。
 */
describe('api の拒否コードと admin の文言が対応している', () => {
  const apiCodes = AUTH_FAILURE_REASONS.map((reason) => AUTH_FAILURE_RESPONSES[reason].error);

  it('api の拒否理由が空でない（表が消えていない）', () => {
    expect(AUTH_FAILURE_REASONS.length).toBeGreaterThan(0);
  });

  it('**キーの集合が完全に一致する**（過不足なし）', () => {
    expect(Object.keys(AUTH_FAILURE_MESSAGES).sort()).toEqual([...apiCodes].sort());
  });

  it.each(apiCodes)('%s に文言がある', (code) => {
    expect(AUTH_FAILURE_MESSAGES[code], `${code} の文言が無い`).toBeDefined();
    expect((AUTH_FAILURE_MESSAGES[code] ?? '').length).toBeGreaterThan(0);
  });

  it('**文言がすべて相異なる**（区別できない文言を出さない）', () => {
    const messages = Object.values(AUTH_FAILURE_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('not_authorized は「再ログインでは直らない」ことを伝えている', () => {
    // 正当なトークンだが別ユーザ。単一著者プールなので再ログインしても通らない。
    expect(AUTH_FAILURE_MESSAGES['not_authorized']).toContain('直らない');
  });

  it('invalid_token は再ログインを促している', () => {
    expect(AUTH_FAILURE_MESSAGES['invalid_token']).toContain('ログイン');
  });

  it('**api 側は 401 か 503 しか返さない**（403 / 404 は CloudFront に食われる）', () => {
    for (const reason of AUTH_FAILURE_REASONS) {
      expect([401, 503]).toContain(AUTH_FAILURE_RESPONSES[reason].statusCode);
    }
  });
});
