import { defineConfig } from 'vite';

/**
 * `base: '/admin/'` が本体。
 *
 * admin は site と同じ S3 バケットの `admin/` 配下に置かれ、同じ CloudFront
 * ディストリビューションから配信される。既定の `base: '/'` のままだと
 * `<script src="/assets/index-*.js">` が出て、`/admin/` を開いたブラウザが
 * **バケットのルート**（site 側）を取りにいって 404 になる。
 * test/build/output.test.ts が全アセット URL の接頭辞を固定している。
 *
 * `target: 'es2023'` は tsconfig の target と揃えている。片方だけ動かすと
 * 「型検査は通るのに出力が古い構文に落ちる（あるいはその逆）」が起きる。
 */
export default defineConfig({
  base: '/admin/',
  build: {
    target: 'es2023',
    emptyOutDir: true,
  },
});
