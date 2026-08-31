## Code fences

**このフィクスチャを消さないこと。** 公開済みの記事にはコードフェンスが 1 つも
無いため、admin 側で強調表示を切っても `site/dist` との比較
（parity/published-html.test.ts）は**全件緑のまま通る**（実測で確認済み）。
そのドリフトを検出できるのはこのコーパスだけである。

A TypeScript fence:

```ts
export const greet = (name: string): string => {
  // shiki が走っていればキーワードが色つきの span に分解される。
  // **このコメントに shiki が出力するクラス名を書かないこと。**
  // 書くとフィクスチャ本文がそのまま出力に現れ、クラス名の存在を見る
  // アサーションが「shiki が動いていなくても通る」形になる（実際に踏んだ）。
  return `hello, ${name}`;
};
```

A fence with no language at all:

```
plain text, no highlighting requested
  indented line
```

A fence with a language shiki does not know:

```notalanguage
this should fall back to plaintext without throwing
```

A fence with a language that is excluded by default (`excludeLangs: ['math']`):

```math
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
```

An indented code block:

    indented four spaces
    still code
