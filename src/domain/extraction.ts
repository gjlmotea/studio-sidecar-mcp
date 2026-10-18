/**
 * 把 place 內容搬出 Studio 的協定。
 *
 * 全部的複雜度都來自一件事：**`execute_luau` 的回傳硬上限是 100,000 個字元，
 * 超過會被靜默截斷**，尾端只留 `... (truncated)`，不會拋錯。
 *
 * 2026-08-30 直連 StudioMCP 實測（`scripts/probe-payload-limit.mjs`）：
 * 100,000 字元完整收到，120,000 只收到 100,015 且尾端是截斷標記。
 * 這是 StudioMCP 自己的限制，不是某個 MCP 客戶端加的 —— 換客戶端繞不過去。
 *
 * 對策是三層，缺一不可：
 * 1. **哨兵**：每一塊的尾端放一個固定字串，收到的內容沒有哨兵就是被截了。
 *    不能只看長度 —— 剛好等於上限的回應可能是完整的，也可能是被切的。
 * 2. **按位元組切、且不切斷 UTF-8 續接位元組**：`JSONEncode` 吐單一行，沒有換行可切。
 * 3. **用位元組數逐檔校驗**：Lua 的 `#s` 數位元組、JS 的 `String.length` 數字元，
 *    同一份資料在兩邊對不起來，一律用 `Buffer.byteLength` 比。
 */

/** `execute_luau` 單次回傳的字元上限（實測值）。 */
export const MAX_PAYLOAD_CHARS = 100_000;

/** 被截斷時 StudioMCP 附在尾端的標記。 */
export const TRUNCATION_MARKER = '... (truncated)';

/**
 * 預設每塊的位元組數。
 *
 * 留了三成餘裕：回傳是**字元**計算而切片是**位元組**，非 ASCII 內容下一個字元可能
 * 佔多個位元組，貼著上限切遲早會撞到。
 */
export const DEFAULT_CHUNK_BYTES = 70_000;

/** 哨兵。內容裡不可能自然出現的字串。 */
export const SENTINEL = '<<<RBXEXTRACT_OK>>>';

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractionError';
  }
}

/**
 * 檢查一次回傳有沒有被截斷，並剝掉哨兵。
 *
 * 🔴 這是整條管線唯一的防線。少了它，被截斷的內容會被當成完整內容寫進檔案，
 * 而且因為沒有錯誤，沒有人會發現。
 */
export function unwrapChunk(text: string, context: string): string {
  if (text.endsWith(TRUNCATION_MARKER)) {
    throw new ExtractionError(
      `${context}: the reply was truncated by StudioMCP (it ends with ${TRUNCATION_MARKER}). `
      + `A single reply is capped at ${MAX_PAYLOAD_CHARS} characters; reduce chunkBytes.`,
    );
  }
  const index = text.lastIndexOf(SENTINEL);
  if (index === -1) {
    throw new ExtractionError(
      `${context}: the reply has no sentinel, so it is treated as incomplete. `
      + `Received ${text.length} characters; tail: ${JSON.stringify(text.slice(-80))}`,
    );
  }
  return text.slice(0, index);
}

export type Slice = { readonly index: number; readonly start: number; readonly length: number };

/** 依總位元組數規劃切片。start 是 1-based，配合 Lua 的 `string.sub`。 */
export function planSlices(totalBytes: number, chunkBytes: number = DEFAULT_CHUNK_BYTES): readonly Slice[] {
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new ExtractionError(`totalBytes must be a non-negative integer, got ${totalBytes}`);
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new ExtractionError(`chunkBytes must be a positive integer, got ${chunkBytes}`);
  }
  if (chunkBytes >= MAX_PAYLOAD_CHARS) {
    throw new ExtractionError(
      `chunkBytes (${chunkBytes}) must be less than the single-reply limit of ${MAX_PAYLOAD_CHARS}, or it is bound to be truncated.`,
    );
  }
  const slices: Slice[] = [];
  for (let start = 1, index = 0; start <= totalBytes; start += chunkBytes, index += 1) {
    slices.push({ index, start, length: Math.min(chunkBytes, totalBytes - start + 1) });
  }
  return slices;
}

export type ExtractedFile = {
  /** DataModel 路徑，例如 `ServerScriptService/Foo/Bar`。 */
  readonly path: string;
  readonly className: string;
  /** header 宣告的位元組數。 */
  readonly declaredBytes: number;
  readonly source: string;
};

const HEADER = /^<<<RBXFILE\|([^|]*)\|([^|]*)\|(\d+)>>>$/;

/**
 * 解析腳本資料流。
 *
 * 格式是每份腳本前面一行 header，後面接原始碼：
 * ```
 * <<<RBXFILE|路徑|類別|位元組數>>>
 * <原始碼>
 * ```
 *
 * **每一份都用 header 宣告的位元組數校驗**，對不上就整批中止 —— 局部正確的抽取
 * 比抽取失敗更危險，因為它看起來成功了。
 */
export function parseScriptStream(stream: string): readonly ExtractedFile[] {
  if (stream.trim() === '') return [];

  const files: ExtractedFile[] = [];
  const lines = stream.split('\n');
  let current: { path: string; className: string; declaredBytes: number } | undefined;
  let body: string[] = [];

  const flush = (): void => {
    if (current === undefined) return;
    // 各行之間補回被 split 拿掉的換行；最後一行後面不補。
    const source = body.join('\n');
    const actual = Buffer.byteLength(source, 'utf8');
    if (actual !== current.declaredBytes) {
      throw new ExtractionError(
        `${current.path}: byte count mismatch: the header declared ${current.declaredBytes}, got ${actual}. `
        + 'Aborting the whole batch: a partially correct extraction is more dangerous than a failed one.',
      );
    }
    files.push({ ...current, source });
    current = undefined;
    body = [];
  };

  for (const line of lines) {
    const match = HEADER.exec(line);
    if (match) {
      flush();
      const [, path, className, bytes] = match;
      current = {
        path: path ?? '',
        className: className ?? '',
        declaredBytes: Number.parseInt(bytes ?? '0', 10),
      };
      continue;
    }
    if (current !== undefined) body.push(line);
  }
  flush();

  if (files.length === 0) {
    throw new ExtractionError('No <<<RBXFILE|...>>> header found in the stream; the format does not match.');
  }
  return files;
}

/** Rojo 慣例：副檔名本身就標示實例型別。 */
export function scriptExtension(className: string): string {
  switch (className) {
    case 'Script':
      return '.server.luau';
    case 'LocalScript':
      return '.client.luau';
    default:
      return '.luau';
  }
}

export function fileNameFor(path: string, className: string): string {
  return `${path.slice(path.lastIndexOf('/') + 1)}${scriptExtension(className)}`;
}

/**
 * 把 DataModel 路徑裡不能當檔名的東西換掉。
 *
 * 🔴 Roblox 的實例名稱幾乎沒有限制 —— 可以叫 `..`、可以含 `:`、可以含路徑分隔符。
 * 直接拿來拼檔案路徑會穿越出輸出目錄。
 */
export function sanitizeSegment(segment: string): string {
  // 只換掉在 Windows 或 POSIX 真的不能當檔名的字元。空白與連字號是合法的，
  // 換掉只會讓快照的檔名跟 DataModel 的實例名對不起來。
  // 用明確字元集而不是正規表示式字面值 —— 這串要跳脫的東西太多，寫錯不會報錯只會靜默漏掉。
  const FORBIDDEN = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const cleaned = [...segment]
    .map((char) => (FORBIDDEN.has(char) || char.charCodeAt(0) < 0x20 ? '_' : char))
    .join('')
    // Windows 不允許檔名以點或空白結尾。
    .replace(/[. ]+$/, '');
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  return cleaned;
}

/** Windows 與 macOS 預設的檔案系統不分大小寫，比對檔名一律用這個。 */
function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

type NameNode = {
  /** 這一層已經用掉的名字（資料夾與檔案共用），存 foldName 後的值。 */
  readonly taken: Set<string>;
  /** 原始實例名 → 這一層給它的資料夾名與下一層。 */
  readonly dirs: Map<string, { readonly name: string; readonly node: NameNode }>;
};

function claimName(node: NameNode, candidate: (n: number) => string): string {
  for (let n = 1; ; n += 1) {
    const name = candidate(n);
    const key = foldName(name);
    if (!node.taken.has(key)) {
      node.taken.add(key);
      return name;
    }
  }
}

/**
 * 在寫任何一個檔之前，一次排好每份腳本的相對路徑（`src/<Service>/…/<名>.<型別>.luau`）。
 *
 * 🔴 三種碰撞都會讓後寫的檔**靜默覆蓋**先寫的：
 * - 清理後同名：`A:B` 與 `A?B` 都變成 `A_B`。
 * - 只差大小寫：`Foo` 與 `foo` 在 Windows 與 macOS 預設的檔案系統上是同一個檔。
 * - DataModel 本來就允許兄弟實例同名。
 *
 * 撞名時依資料流順序加 `~2`、`~3`…（資料夾加在名字後，檔案加在副檔名前），
 * 同一份 place 每次抽出來的檔名都一樣。回傳的順序與輸入相同。
 */
export function planScriptPaths(
  files: readonly Pick<ExtractedFile, 'path' | 'className'>[],
): readonly string[] {
  const newNode = (): NameNode => ({ taken: new Set(), dirs: new Map() });
  const root = newNode();
  return files.map((file) => {
    const segments = file.path.split('/');
    const leaf = segments.pop() ?? '';
    const out = ['src'];
    let node = root;
    for (const raw of segments) {
      let dir = node.dirs.get(raw);
      if (dir === undefined) {
        const base = sanitizeSegment(raw);
        dir = { name: claimName(node, (n) => (n === 1 ? base : `${base}~${n}`)), node: newNode() };
        node.dirs.set(raw, dir);
      }
      out.push(dir.name);
      node = dir.node;
    }
    const ext = scriptExtension(file.className);
    out.push(claimName(node, (n) => sanitizeSegment(n === 1 ? `${leaf}${ext}` : `${leaf}~${n}${ext}`)));
    return out.join('/');
  });
}
