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
      `${context}：回應被 StudioMCP 截斷（尾端是 ${TRUNCATION_MARKER}）。`
      + `單次回傳上限 ${MAX_PAYLOAD_CHARS} 字元，請縮小 chunkBytes。`,
    );
  }
  const index = text.lastIndexOf(SENTINEL);
  if (index === -1) {
    throw new ExtractionError(
      `${context}：回應沒有哨兵，視為不完整。`
      + `收到 ${text.length} 字元，尾端：${JSON.stringify(text.slice(-80))}`,
    );
  }
  return text.slice(0, index);
}

export type Slice = { readonly index: number; readonly start: number; readonly length: number };

/** 依總位元組數規劃切片。start 是 1-based，配合 Lua 的 `string.sub`。 */
export function planSlices(totalBytes: number, chunkBytes: number = DEFAULT_CHUNK_BYTES): readonly Slice[] {
  if (!Number.isInteger(totalBytes) || totalBytes < 0) {
    throw new ExtractionError(`totalBytes 必須是非負整數，收到 ${totalBytes}`);
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw new ExtractionError(`chunkBytes 必須是正整數，收到 ${chunkBytes}`);
  }
  if (chunkBytes >= MAX_PAYLOAD_CHARS) {
    throw new ExtractionError(
      `chunkBytes（${chunkBytes}）必須小於單次回傳上限 ${MAX_PAYLOAD_CHARS}，否則必被截斷。`,
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
        `${current.path}：位元組數不符 —— header 宣告 ${current.declaredBytes}，實得 ${actual}。`
        + '整批中止：局部正確的抽取比失敗更危險。',
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
    throw new ExtractionError('資料流裡找不到任何 <<<RBXFILE|…>>> header，格式不符。');
  }
  return files;
}

/** Rojo 慣例：副檔名本身就標示實例型別。 */
export function fileNameFor(path: string, className: string): string {
  const leaf = path.slice(path.lastIndexOf('/') + 1);
  switch (className) {
    case 'Script':
      return `${leaf}.server.luau`;
    case 'LocalScript':
      return `${leaf}.client.luau`;
    default:
      return `${leaf}.luau`;
  }
}
