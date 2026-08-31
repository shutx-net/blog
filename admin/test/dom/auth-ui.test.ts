import { describe, expect, it, vi } from 'vitest';

import INDEX_HTML from '../../index.html?raw';
import { beginSignIn, signOut } from '../../src/auth/session.ts';
import type { AuthTransport } from '../../src/auth/session.ts';
import { PENDING_LOGIN_KEY } from '../../src/auth/pending-login.ts';
import { createApp } from '../../src/editor/app.ts';
import { loadDraft, saveDraft } from '../../src/editor/draft-persistence.ts';
import { createSessionStore } from '../../src/storage/session-store.ts';
import type { SessionStore, WebStorageLike } from '../../src/storage/session-store.ts';

const NOW = () => Date.parse('2026-08-31T02:30:00.000Z');
const ORIGIN = 'https://d8gsxbwzr6ft8.cloudfront.net';

const memoryStorage = (): WebStorageLike => {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
};

const newStore = (): SessionStore => createSessionStore(memoryStorage());

const fakeAuth = (signedIn: () => boolean): AuthTransport => ({
  authHeaders: async (): Promise<Record<string, string>> =>
    signedIn() ? { 'x-blog-authorization': 'Bearer t' } : {},
  credentials: 'same-origin',
  isAuthenticated: signedIn,
});

const mount = (): HTMLElement => {
  document.body.innerHTML = INDEX_HTML.slice(
    INDEX_HTML.indexOf('<main'),
    INDEX_HTML.indexOf('</main>') + '</main>'.length,
  );
  const root = document.querySelector<HTMLElement>('#editor');
  if (root === null) throw new Error('index.html から #editor を切り出せなかった');
  return root;
};

const el = <T extends HTMLElement>(root: HTMLElement, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`${selector} が無い`);
  return found;
};

const set = (root: HTMLElement, id: string, value: string): void => {
  const element = el<HTMLInputElement | HTMLTextAreaElement>(root, `#${id}`);
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

const submit = (root: HTMLElement): void => {
  el<HTMLFormElement>(root, '#post-form').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  );
};

const statusText = (root: HTMLElement): string => el(root, '#status').textContent ?? '';
const statusHtml = (root: HTMLElement): string => el(root, '#status').innerHTML;

const fillValid = (root: HTMLElement): void => {
  set(root, 'slug', 'a-post');
  set(root, 'title', 'A title');
  set(root, 'description', 'A description');
  set(root, 'body', 'Body text.');
};

const noPreview = async (): Promise<string> => '<p>preview</p>';

const json = (status: number, payload: unknown): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('**未認証で起動したとき**', () => {
  it('#signin が現れ、#signout は隠れている', () => {
    const root = mount();
    createApp({ root, auth: fakeAuth(() => false), renderPreview: noPreview, now: NOW });

    expect(el(root, '#signin').hidden).toBe(false);
    expect(el(root, '#signout').hidden).toBe(true);
  });

  it('送信ボタンが disabled である', () => {
    const root = mount();
    createApp({ root, auth: fakeAuth(() => false), renderPreview: noPreview, now: NOW });
    expect(el<HTMLButtonElement>(root, '#submit').disabled).toBe(true);
  });

  it('状態表示に「ログインしていない」旨が出る', () => {
    const root = mount();
    createApp({ root, auth: fakeAuth(() => false), renderPreview: noPreview, now: NOW });
    expect(statusText(root)).toContain('ログイン');
  });

  it('**deny-all という古い文言が出ない**（api は cognito モードで動いている）', () => {
    const root = mount();
    createApp({ root, auth: fakeAuth(() => false), renderPreview: noPreview, now: NOW });
    expect(statusText(root)).not.toContain('deny-all');
  });

  it('**起動時に redirect が 1 度も呼ばれない**', () => {
    // 自動化すると (a) 設定ミスでリダイレクトループになり、
    // (b) 未認証状態が観測できなくなり、(c) 開いただけで書きかけが飛ぶ。
    const redirects: string[] = [];
    const root = mount();
    createApp({
      root,
      auth: fakeAuth(() => false),
      renderPreview: noPreview,
      now: NOW,
      onSignIn: () => {
        redirects.push('should not happen');
      },
    });

    expect(redirects).toEqual([]);
  });

  it('**未認証でも編集とプレビューは動く**', async () => {
    const root = mount();
    const previews: string[] = [];
    createApp({
      root,
      auth: fakeAuth(() => false),
      renderPreview: async (markdown) => {
        previews.push(markdown);
        return `<p>${markdown}</p>`;
      },
      now: NOW,
    });

    set(root, 'body', '# 書ける');

    // ログインしていないことは、書けないことではない。書いてからログインできる。
    expect(el<HTMLTextAreaElement>(root, '#body').value).toBe('# 書ける');
    await vi.waitFor(() => {
      expect(previews).toContain('# 書ける');
    });
  });
});

describe('**#signin を押して初めてリダイレクトする**', () => {
  const clickSignIn = (root: HTMLElement): void => {
    el<HTMLButtonElement>(root, '#signin').dispatchEvent(new Event('click', { bubbles: true }));
  };

  it('押すと onSignIn が 1 回だけ呼ばれる', () => {
    const root = mount();
    let calls = 0;
    createApp({
      root,
      auth: fakeAuth(() => false),
      renderPreview: noPreview,
      now: NOW,
      onSignIn: () => {
        calls += 1;
      },
    });

    clickSignIn(root);
    expect(calls).toBe(1);
  });

  it('本物の beginSignIn を繋ぐと authorize URL に 1 回だけ遷移する', async () => {
    const root = mount();
    const store = newStore();
    const redirects: string[] = [];

    createApp({
      root,
      auth: fakeAuth(() => false),
      store,
      renderPreview: noPreview,
      now: NOW,
      onSignIn: () =>
        beginSignIn({
          store,
          now: NOW,
          random: () => new Uint8Array(32).fill(6),
          origin: ORIGIN,
          redirect: (url) => {
            redirects.push(url);
          },
        }),
    });

    clickSignIn(root);
    await vi.waitFor(() => {
      expect(redirects).toHaveLength(1);
    });

    const url = new URL(redirects[0] as string);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('**押した時点で pending login レコードと下書きが store に入っている**', async () => {
    const root = mount();
    const store = newStore();
    let seen: { pending: unknown; draft: unknown } | undefined;

    createApp({
      root,
      auth: fakeAuth(() => false),
      store,
      renderPreview: noPreview,
      now: NOW,
      onSignIn: () =>
        beginSignIn({
          store,
          now: NOW,
          random: () => new Uint8Array(32).fill(8),
          origin: ORIGIN,
          redirect: () => {
            // 偽 redirect の中から覗く。**順序ではなく観測で固定する。**
            seen = { pending: store.get(PENDING_LOGIN_KEY), draft: loadDraft(store) };
          },
        }),
    });

    set(root, 'title', '書きかけのタイトル');
    clickSignIn(root);

    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    expect(seen?.pending).toBeDefined();
    expect((seen?.draft as { title?: string } | undefined)?.title).toBe('書きかけのタイトル');
  });
});

describe('**認証済みで起動したとき**', () => {
  it('#signin が隠れ、#signout が現れ、送信ボタンが有効', () => {
    const root = mount();
    createApp({ root, auth: fakeAuth(() => true), renderPreview: noPreview, now: NOW });

    expect(el(root, '#signin').hidden).toBe(true);
    expect(el(root, '#signout').hidden).toBe(false);

    fillValid(root);
    expect(el<HTMLButtonElement>(root, '#submit').disabled).toBe(false);
  });

  it('#signout を押すと onSignOut が呼ばれ、下書きは残る', async () => {
    const root = mount();
    const store = newStore();
    const redirects: string[] = [];
    saveDraft(store, {
      slug: '',
      title: '残るはず',
      description: '',
      pubDate: '',
      tags: '',
      draft: true,
      body: '',
    });

    createApp({
      root,
      auth: fakeAuth(() => true),
      store,
      renderPreview: noPreview,
      now: NOW,
      onSignOut: () =>
        signOut({
          store,
          origin: ORIGIN,
          redirect: (url) => {
            redirects.push(url);
          },
          fetchImpl: async () => new Response('', { status: 200 }),
        }),
    });

    el<HTMLButtonElement>(root, '#signout').dispatchEvent(new Event('click', { bubbles: true }));

    await vi.waitFor(() => {
      expect(redirects).toHaveLength(1);
    });
    expect(loadDraft(store)?.title).toBe('残るはず');
  });
});

describe('**セッション切れの伝え方**', () => {
  const runSubmit = async (
    errorCode: string,
  ): Promise<{ root: HTMLElement; postCalls: string[]; redirects: string[] }> => {
    const root = mount();
    const postCalls: string[] = [];
    const redirects: string[] = [];
    let signedIn = true;

    createApp({
      root,
      auth: fakeAuth(() => signedIn),
      renderPreview: noPreview,
      now: NOW,
      origin: '',
      onSignIn: () => {
        redirects.push('signin');
      },
      fetchImpl: async (input) => {
        postCalls.push(String(input));
        // api が 401 を返す状況は、セッションが失われた状況でもある。
        signedIn = false;
        return json(401, { error: errorCode });
      },
    });

    fillValid(root);
    submit(root);
    await vi.waitFor(() => {
      expect(statusText(root)).not.toBe('送信中…');
    });
    return { root, postCalls, redirects };
  };

  it('invalid_token では「もう一度ログイン」の旨が出て #signin が戻る', async () => {
    const { root } = await runSubmit('invalid_token');
    expect(statusText(root)).toContain('ログイン');
    expect(el(root, '#signin').hidden).toBe(false);
  });

  it('**redirect は呼ばれない**（編集中に勝手に飛ばさない）', async () => {
    const { redirects } = await runSubmit('invalid_token');
    expect(redirects).toEqual([]);
  });

  it('**1 回の送信操作で POST /api/posts はちょうど 1 回**（再送しない）', async () => {
    const { postCalls } = await runSubmit('invalid_token');
    expect(postCalls).toEqual(['/api/posts']);
  });

  it('3 つの拒否コードで別々の文言になる', async () => {
    const invalid = await runSubmit('invalid_token');
    const unauth = await runSubmit('unauthenticated');
    const notAuthorized = await runSubmit('not_authorized');

    const texts = [statusText(invalid.root), statusText(unauth.root), statusText(notAuthorized.root)];
    expect(new Set(texts).size, `文言が重複している: ${texts.join(' / ')}`).toBe(3);
  });

  it('not_authorized は「再ログインでは直らない」旨を含む', async () => {
    // 別のユーザでログインしている状態。単一著者プールなので再ログインでは直らない。
    const { root } = await runSubmit('not_authorized');
    expect(statusText(root)).toContain('直らない');
  });
});

describe('**認可サーバのエラー文字列を innerHTML に入れない**', () => {
  it('タグを含む error_description が textContent 経由で入る', () => {
    const root = mount();
    createApp({
      root,
      auth: fakeAuth(() => false),
      renderPreview: noPreview,
      now: NOW,
      callback: {
        kind: 'provider_error',
        error: 'invalid_request',
        description: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      },
    });

    // **プレビューは生 HTML を通す設計なので、状態表示まで innerHTML にすると
    // そのまま XSS になる。** #status は必ず textContent。
    expect(statusHtml(root)).not.toContain('<img');
    expect(statusHtml(root)).not.toContain('<script');
    expect(statusText(root)).toContain('onerror');
  });

  it('通常の callback 失敗でも状態表示に出る', () => {
    const root = mount();
    createApp({
      root,
      auth: fakeAuth(() => false),
      renderPreview: noPreview,
      now: NOW,
      callback: { kind: 'failed', reason: 'state_mismatch' },
    });
    expect(statusText(root).length).toBeGreaterThan(0);
  });

  it('kind:"no_callback" では未認証の通常メッセージのまま', () => {
    const root = mount();
    createApp({
      root,
      auth: fakeAuth(() => false),
      renderPreview: noPreview,
      now: NOW,
      callback: { kind: 'no_callback' },
    });
    expect(statusText(root)).toContain('ログイン');
  });

  it('kind:"signed_in" では成功の旨が出る', () => {
    const root = mount();
    createApp({
      root,
      auth: fakeAuth(() => true),
      renderPreview: noPreview,
      now: NOW,
      callback: { kind: 'signed_in', returnTo: '/admin/' },
    });
    expect(statusText(root)).toContain('ログインした');
  });
});
