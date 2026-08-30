import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

interface CloudFrontRequest {
  uri: string;
  method?: string;
  querystring?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

type Handler = (event: { request: CloudFrontRequest }) => CloudFrontRequest;

const SOURCE_PATH = fileURLToPath(new URL('../functions/rewrite-uri.js', import.meta.url));

/** デプロイされるのと同じバイト列を読む。テスト専用の写しは作らない。 */
const source = readFileSync(SOURCE_PATH, 'utf8');

/**
 * CloudFront Functions は常に strict mode で動作し、これは変更できない。
 * ローカル評価でも条件を揃えるため 'use strict'; を前置して評価する。
 */
const loadHandler = (): Handler => {
  const sandbox: { handler?: Handler } = {};
  const context = createContext(sandbox);
  new Script(`'use strict';\n${source}`, { filename: SOURCE_PATH }).runInContext(context);
  const handler = sandbox.handler;
  if (typeof handler !== 'function') {
    throw new Error('rewrite-uri.js が handler を定義していない');
  }
  return handler;
};

const rewrite = (uri: string): string => loadHandler()({ request: { uri } }).uri;

const REWRITTEN = [
  { input: '/about', expected: '/about/index.html' },
  { input: '/about/', expected: '/about/index.html' },
  { input: '/', expected: '/index.html' },
  { input: '/posts/hello-world', expected: '/posts/hello-world/index.html' },
  { input: '/posts/hello-world/', expected: '/posts/hello-world/index.html' },
];

const UNCHANGED = ['/assets/app.css', '/favicon.ico', '/robots.txt', '/index.html'];

describe('rewrite-uri.js の URI 書き換え', () => {
  it('node:vm で評価して handler を取り出せる', () => {
    expect(typeof loadHandler()).toBe('function');
  });

  it.each(REWRITTEN)('$input を $expected に書き換える', ({ input, expected }) => {
    expect(rewrite(input)).toBe(expected);
  });

  it.each(UNCHANGED)('%s は書き換えない', (uri) => {
    expect(rewrite(uri)).toBe(uri);
  });

  it('handler は request オブジェクトそのものを返し、uri 以外を保持する', () => {
    const request: CloudFrontRequest = {
      uri: '/about',
      method: 'GET',
      querystring: { q: { value: 'x' } },
      headers: { host: { value: 'example.com' } },
    };
    const result = loadHandler()({ request });

    expect(result).toBe(request);
    expect(result.uri).toBe('/about/index.html');
    expect(result.method).toBe('GET');
    expect(result.querystring).toEqual({ q: { value: 'x' } });
    expect(result.headers).toEqual({ host: { value: 'example.com' } });
  });

  it('【既知の限界】最終セグメントにドットを含むスラッグは書き換えない', () => {
    // 記事スラッグにドットを使うとこの偽陰性を踏む。運用でドットを使わないこと。
    expect(rewrite('/posts/node-24.19-notes')).toBe('/posts/node-24.19-notes');
  });

  it('コードサイズが CloudFront Functions の上限 10 KB 未満', () => {
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThan(10240);
  });
});
