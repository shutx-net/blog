// CloudFront Functions (viewer-request): ディレクトリ風の URI を index.html に解決する。
//
// S3 を REST オリジンにすると DefaultRootObject はルート '/' にしか効かないため、
// /about のようなパスは CloudFront 側で /about/index.html に書き換える必要がある。
//
// 制約:
//   - CloudFront Functions は常に strict mode。ES モジュールではなく素のスクリプト。
//   - ランタイム互換性を最大化するため ES5.1 の範囲だけで書く（var / lastIndexOf / charAt）。
//   - event.request.uri にクエリ文字列は含まれない（querystring に分離されている）。
//   - 最終セグメントにドットがあるものは静的ファイルとみなして素通しする。
//     この帰結として /posts/node-24.19-notes のようなドット入りスラッグは書き換わらない。
//     記事スラッグにドットを使わないこと。
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.charAt(uri.length - 1) === '/') {
    request.uri = uri + 'index.html';
  } else if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) {
    request.uri = uri + '/index.html';
  }

  return request;
}
