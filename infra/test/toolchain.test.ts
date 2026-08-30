import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 完全固定バージョン。^ ~ >= x * のいずれも許さない。 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const readPackageJson = (relative: string): PackageJson => {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
};

const infraPkg = (): PackageJson => readPackageJson('../package.json');
const rootPkg = (): PackageJson => readPackageJson('../../package.json');

describe('infra ワークスペースの CDK バージョン固定', () => {
  it('devDependencies.aws-cdk-lib が完全固定の "2.267.0" である', () => {
    const pkg = infraPkg();
    expect(pkg.devDependencies).toBeDefined();
    expect(pkg.devDependencies?.['aws-cdk-lib']).toBe('2.267.0');
    expect(pkg.devDependencies?.['aws-cdk-lib']).toMatch(EXACT_VERSION);
  });

  it('devDependencies.aws-cdk が完全固定の "2.1139.0" で、dependencies 側には存在しない', () => {
    const pkg = infraPkg();
    expect(pkg.devDependencies?.['aws-cdk']).toBe('2.1139.0');
    expect(pkg.devDependencies?.['aws-cdk']).toMatch(EXACT_VERSION);
    expect(pkg.dependencies?.['aws-cdk']).toBeUndefined();
    expect(pkg.dependencies?.['aws-cdk-lib']).toBeUndefined();
  });

  it('aws-cdk-lib と aws-cdk が両方 devDependencies にあり、片方だけずらせない', () => {
    const pkg = infraPkg();
    const dev = pkg.devDependencies ?? {};
    expect(Object.keys(dev)).toEqual(expect.arrayContaining(['aws-cdk-lib', 'aws-cdk']));
    for (const name of ['aws-cdk-lib', 'aws-cdk']) {
      expect(dev[name], `${name} は範囲指定ではなく完全固定でなければならない`).toMatch(EXACT_VERSION);
    }
  });

  it('infra/package.json の "type" が "module" である', () => {
    expect(infraPkg().type).toBe('module');
  });
});

describe('npm workspaces のルート', () => {
  it('workspaces 配列に "infra" が含まれる', () => {
    const root = rootPkg();
    expect(Array.isArray(root.workspaces)).toBe(true);
    expect(root.workspaces).toContain('infra');
  });

  it('private: true である（誤って publish しないため）', () => {
    expect(rootPkg().private).toBe(true);
  });
});
