/**
 * `undefined` / `null` を落としてから値を返す。
 *
 * **`!` を使わないために置いてある。** `!` は型を黙らせるだけで、実際に `undefined` が
 * 来たときの挙動を何も保証しない。`expect(x).toBeDefined()` も同じで、あれは実行時の
 * 主張であって TS の型は絞らないので、直後の `x.name` は依然 `possibly undefined` になる。
 *
 * この関数は型を絞り、かつ**外れたときに何が欠けたかを名指しして落ちる**。
 */
export const defined = <T>(value: T | undefined | null, what: string): T => {
  if (value === undefined || value === null) {
    throw new Error(`${what} is not defined`);
  }

  return value;
};
