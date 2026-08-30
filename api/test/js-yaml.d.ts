/**
 * js-yaml の最小宣言。
 *
 * **@types/js-yaml を足さずにここで宣言している。** js-yaml は astro が front matter の
 * 解釈に使っている実物（astro@7.2.9 -> js-yaml@4.3.2）で、契約テストが「site のビルドと
 * 同じパーサ」で読み直すために **テストからだけ** 使う。Lambda のバンドルには入らない。
 */
declare module 'js-yaml' {
  export function load(input: string): unknown;
}
