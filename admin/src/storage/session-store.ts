/**
 * **Web Storage を名指しする唯一のファイル。**
 *
 * `test/unit/auth-seam.test.ts` の走査規則 1 が「`localStorage` / `sessionStorage` の
 * 綴りはこの 1 本にしか現れない」ことを機械的に固定している。保存先を変えたくなったら
 * 読む場所はここだけである。
 *
 * ## このファイルは認証を知らない
 *
 * トークン（`src/auth/`）も下書き（`src/editor/`）も同じ store を使うので、
 * `src/auth/` の下には置かない。**ここにあるのは「キーと値を名前空間つきで出し入れする」
 * だけ**で、何を入れるかは呼び出し側の責任。
 *
 * ## なぜ sessionStorage なのか
 *
 * 根拠は `src/auth/THREAT-MODEL.md`。要約すると:
 *
 * - **`localStorage` を採らない**: タブを閉じてもブラウザを再起動しても残り、
 *   24 時間有効な refresh トークンがディスク上に残り続ける。オリジンの全タブで共有される。
 * - **メモリ変数だけにしない**: リダイレクト往復でページが作り直されるのでそもそも
 *   残らず、F5 のたびに全画面遷移が要る。**その全画面遷移こそが下書きを失う事象**であり、
 *   発生頻度を上げる選択は下書き保全の目的と正面から衝突する。
 * - **Cookie を採らない**: `api/src/auth/transport.ts` が決着させている（CSRF）。
 *
 * **XSS には勝てない。** ページ内で動くスクリプトはメモリ変数も Web Storage も同じように
 * 読める。保存先の選択で XSS を防げるという主張はしない（対策は CSP）。
 *
 * **タブ単位で、同一タブ内の遷移（クロスオリジンの往復を含む）では保持される。**
 * これが PKCE の verifier と下書きの両方をリダイレクト越しに運ぶ土台になっている。
 * **ただし jsdom には本物のタブセッションが無いのでこの性質は検証できない** —
 * 人間の手動確認に送っている（DEVELOPERS.md）。
 */

/** `Storage` のうち実際に使う 3 つだけ。**偽物を注入できる形にするための最小面。** */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SessionStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  remove(key: string): void;
}

/** キーの名前空間。同じオリジンの他の何かと衝突しないようにするだけの接頭辞。 */
export const STORAGE_NAMESPACE = 'blog.admin.';

/**
 * レコードのスキーマ版。
 *
 * 保存する値を `{v, d}` で包み、読むときに `v` を見る。**版が違うレコードは
 * `undefined` として扱う**（消しはしない。次の `set` が上書きする）。
 * これが無いと、形を変えたときに古いレコードを持ったタブが起動不能になる。
 */
const SCHEMA_VERSION = 1;

interface Record_ {
  v: number;
  d: unknown;
}

/**
 * 既定のストレージ。
 *
 * **プロパティの読み取り自体が投げうる**（サイトデータをブロックしたブラウザ）ので
 * try/catch で包む。node 環境（unit テスト）では単に存在しないので `undefined` になる。
 */
const defaultStorage = (): WebStorageLike | undefined => {
  try {
    return globalThis.sessionStorage as WebStorageLike | undefined;
  } catch {
    return undefined;
  }
};

/**
 * 名前空間つきの薄い store。
 *
 * **全操作を try/catch で包む。** 保存できないこと（プライベートモード・容量超過・
 * サイトデータのブロック）でエディタが使えなくなってはいけない。
 * **投げる代わりに「無い」として振る舞う。**
 */
export const createSessionStore = (storage?: WebStorageLike): SessionStore => {
  const backing = storage ?? defaultStorage();
  const realKey = (key: string): string => `${STORAGE_NAMESPACE}${key}`;

  return {
    get: <T>(key: string): T | undefined => {
      try {
        const raw = backing?.getItem(realKey(key));
        if (raw === null || raw === undefined || raw.length === 0) return undefined;
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        const record = parsed as Partial<Record_>;
        if (record.v !== SCHEMA_VERSION) return undefined;
        return record.d as T;
      } catch {
        return undefined;
      }
    },

    set: (key: string, value: unknown): void => {
      try {
        backing?.setItem(realKey(key), JSON.stringify({ v: SCHEMA_VERSION, d: value }));
      } catch {
        // 握り潰す。**保存できないことは、書けないことではない。**
      }
    },

    remove: (key: string): void => {
      try {
        backing?.removeItem(realKey(key));
      } catch {
        // 握り潰す。
      }
    },
  };
};
