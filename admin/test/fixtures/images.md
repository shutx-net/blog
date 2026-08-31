## Images

AGENTS.md「画像を Git に入れない」の帰結として、記事に書ける画像は
presigned PUT で S3 に上げた `/media/...` か、外部の絶対 URL だけ。
**相対パスはここに書かない** — 相対パスだけが fileURL の有無で出力が変わる
唯一の構成で、それは test/unit/preview-images.test.ts が専用に固定している。

An uploaded image:

![アップロードした画像](/media/2026/08/0123456789abcdef01234567.png)

A remote image:

![リモート画像](https://example.com/remote.png)

A remote image with a title:

![alt text](https://example.com/titled.png "the title")

A reference-style image:

![参照形式][ref]

An image inside a link:

[![リンク内の画像](/media/2026/08/inside-a-link.png)](https://example.com/target)

[ref]: /media/2026/08/reference-style.png
