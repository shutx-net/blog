# 依存を足すときの測り方

判断の門（不採用条件）は `AGENTS.md` にある。

## 主張ではなく実測すること

```sh
npm view <pkg> time.modified time.created dist-tags --json    # 最終公開日
npm view <pkg> deprecated maintainers license --json          # 非推奨・メンテナ数
npm view <pkg> dependencies --json                            # 推移依存の表面積
gh api repos/<owner>/<repo> --jq '{archived, pushed_at, open_issues_count}'
```

## 依存を足さない選択を先に検討する

- **標準ライブラリで足りないか。** `node:crypto` の枯れたプリミティブで済むなら、依存ゼロが最も安全
- **既にある依存を再利用できないか。** 別系統の同種ライブラリを持ち込まない
  （Markdown は remark 系に統一する。プレビューと本番の一致という要件からも同じものを使う）
- **`<textarea>` で足りるものにリッチエディタを入れない**
