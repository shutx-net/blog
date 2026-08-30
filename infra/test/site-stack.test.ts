import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { App, Token } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SiteStack } from '../lib/site-stack.ts';

interface CdkJson {
  app?: string;
  context?: Record<string, unknown>;
}

const readCdkJson = (): CdkJson => {
  const path = fileURLToPath(new URL('../cdk.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as CdkJson;
};

describe('SiteStack の合成', () => {
  it('Template.fromStack() に渡して例外なく合成できる', () => {
    const stack = new SiteStack(new App(), 'TestStack');
    expect(() => Template.fromStack(stack)).not.toThrow();
  });

  it('env を指定していない（env-agnostic である）', () => {
    const stack = new SiteStack(new App(), 'TestStack');
    // env を渡していなければ region / account は疑似パラメータのトークンになる。
    expect(Token.isUnresolved(stack.region)).toBe(true);
    expect(Token.isUnresolved(stack.account)).toBe(true);
    expect(stack.environment).toBe('aws://unknown-account/unknown-region');
  });
});

describe('cdk.json', () => {
  it('app が "node bin/blog.ts" である（ts-node / tsx を使っていない）', () => {
    const cdkJson = readCdkJson();
    expect(cdkJson.app).toBe('node bin/blog.ts');
  });

  it('app にトランスパイラを噛ませていない', () => {
    const app = readCdkJson().app ?? '';
    expect(app).not.toMatch(/ts-node|tsx|esbuild|swc/);
  });
});
