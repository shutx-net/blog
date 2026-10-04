import { describe, expect, it } from 'vitest';
import {
  SUBJECT_MAX_LENGTH,
  commitMessages,
  foldSubjectTitle,
} from '../../src/posts/commit-message.ts';

describe('foldSubjectTitle', () => {
  it.each([
    ['改行を空白に畳む', 'まとも\ndraft: true', 'まとも draft: true'],
    ['CRLF も畳む', 'a\r\nb', 'a b'],
    ['タブを空白に畳む', 'a\tb', 'a b'],
    ['連続する空白を 1 つにする', 'a  \n \t b', 'a b'],
    ['前後の空白を落とす', '  a  ', 'a'],
  ])('%s', (_label, title, expected) => {
    expect(foldSubjectTitle(title)).toBe(expected);
  });

  it('**改行が 1 つも残らない**', () => {
    // 残ると Conventional Commits の 1 行目が壊れ、2 行目以降が本文に化ける。
    const folded = foldSubjectTitle('a\nb\r\nc d');
    expect(folded).not.toMatch(/[\r\n\u2028\u2029]/);
  });

  it('長い title は切り詰めて省略記号を付ける', () => {
    const folded = foldSubjectTitle('あ'.repeat(200));
    expect(folded.length).toBeLessThan(200);
    expect(folded.endsWith('…')).toBe(true);
  });

  it('短い title には省略記号を付けない', () => {
    expect(foldSubjectTitle('短い')).toBe('短い');
  });
});

describe('commitMessages', () => {
  it('**title を含み、slug を含まない**', () => {
    // 日付パスだと `記事 2026/09/08/054001 を追加` になり、履歴から中身が読めない。
    const messages = commitMessages('はじめての記事');
    expect(messages.createMessage).toContain('はじめての記事');
    expect(messages.replaceMessage).toContain('はじめての記事');
    expect(messages.createMessage).not.toContain('2026/');
  });

  it('Conventional Commits のプレフィックスが付く', () => {
    const messages = commitMessages('t');
    expect(messages.createMessage.startsWith('feat(site): ')).toBe(true);
    expect(messages.replaceMessage.startsWith('feat(site): ')).toBe(true);
  });

  it('追加と更新が区別できる', () => {
    const messages = commitMessages('t');
    expect(messages.createMessage).toContain('追加');
    expect(messages.replaceMessage).toContain('更新');
    expect(messages.createMessage).not.toBe(messages.replaceMessage);
  });

  it.each(['短い', 'あ'.repeat(200), 'a\nb', '  padded  ', '🎉 released'])(
    '%o でも 1 行目が 1 行に収まり、上限を超えない',
    (title) => {
      for (const message of Object.values(commitMessages(title))) {
        expect(message).not.toMatch(/[\r\n]/);
        // AGENTS.md「1 行目は 50 字程度」。
        expect([...message].length).toBeLessThanOrEqual(SUBJECT_MAX_LENGTH);
      }
    },
  );

  it('絵文字を壊さない（サロゲートペアを半分で切らない）', () => {
    // 素の slice はサロゲートペアを割り、不正な UTF-16 を GitHub に送りうる。
    const message = commitMessages('🎉'.repeat(100)).createMessage;
    expect(message).not.toContain('�');
    expect(message.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)).toBeNull();
  });
});
