import { describe, expect, it } from 'vitest';

import { sanitizeSegment } from '../../src/composition.js';
import {
  DEFAULT_CHUNK_BYTES,
  ExtractionError,
  fileNameFor,
  MAX_PAYLOAD_CHARS,
  parseScriptStream,
  planSlices,
  SENTINEL,
  TRUNCATION_MARKER,
  unwrapChunk,
} from '../../src/domain/extraction.js';
import { parseSliceHeader } from '../../src/domain/luau-payloads.js';

describe('unwrapChunk', () => {
  it('剝掉哨兵回傳內容', () => {
    expect(unwrapChunk(`hello${SENTINEL}`, 'x')).toBe('hello');
  });

  it('🔴 認出 StudioMCP 的截斷標記', () => {
    // 實測：要求 120000 字元只收到 100015，尾端是這個標記且不會拋錯。
    expect(() => unwrapChunk(`xxx${TRUNCATION_MARKER}`, '切片 @1')).toThrow(ExtractionError);
    expect(() => unwrapChunk(`xxx${TRUNCATION_MARKER}`, '切片 @1')).toThrow(/被 StudioMCP 截斷/);
  });

  it('🔴 沒有哨兵一律視為不完整 —— 不能只看長度', () => {
    // 剛好等於上限的回應可能是完整的、也可能是被切的，長度分不出來，只有哨兵分得出來。
    expect(() => unwrapChunk('x'.repeat(MAX_PAYLOAD_CHARS), 'x')).toThrow(/沒有哨兵/);
  });

  it('內容本身含哨兵字樣時取最後一個', () => {
    expect(unwrapChunk(`a${SENTINEL}b${SENTINEL}`, 'x')).toBe(`a${SENTINEL}b`);
  });
});

describe('planSlices', () => {
  it('切得剛好蓋滿，不重疊不漏', () => {
    const slices = planSlices(250, 100);
    expect(slices).toEqual([
      { index: 0, start: 1, length: 100 },
      { index: 1, start: 101, length: 100 },
      { index: 2, start: 201, length: 50 },
    ]);
  });

  it('空內容不產生切片', () => {
    expect(planSlices(0, 100)).toEqual([]);
  });

  it('🔴 chunkBytes 不得大於等於回傳上限，否則必被截斷', () => {
    expect(() => planSlices(10, MAX_PAYLOAD_CHARS)).toThrow(/必須小於單次回傳上限/);
  });

  it('預設值留有餘裕（位元組 vs 字元）', () => {
    expect(DEFAULT_CHUNK_BYTES).toBeLessThan(MAX_PAYLOAD_CHARS);
  });

  it.each([[-1, 100], [10, 0], [10, -5]])('拒絕不合理的參數 (%i, %i)', (total, chunk) => {
    expect(() => planSlices(total, chunk)).toThrow(ExtractionError);
  });
});

describe('parseScriptStream', () => {
  function frame(path: string, className: string, source: string): string {
    return `<<<RBXFILE|${path}|${className}|${Buffer.byteLength(source, 'utf8')}>>>\n${source}`;
  }

  it('拆得出多份腳本並保留內容', () => {
    const stream = [
      frame('ServerScriptService/A', 'Script', 'print("a")'),
      frame('ReplicatedStorage/B', 'ModuleScript', 'return {}'),
    ].join('\n');
    const files = parseScriptStream(stream);
    expect(files.map((f) => f.path)).toEqual(['ServerScriptService/A', 'ReplicatedStorage/B']);
    expect(files[0]?.source).toBe('print("a")');
  });

  it('多行原始碼原樣保留', () => {
    const source = 'local x = 1\n\nreturn x';
    const files = parseScriptStream(frame('X/Y', 'ModuleScript', source));
    expect(files[0]?.source).toBe(source);
  });

  it('空白原始碼也算一份', () => {
    const files = parseScriptStream(frame('X/Empty', 'Script', ''));
    expect(files).toHaveLength(1);
    expect(files[0]?.source).toBe('');
  });

  it('🔴 位元組數對不上就整批中止', () => {
    // 局部正確的快照比抽取失敗更危險 —— 它看起來成功了。
    const bad = '<<<RBXFILE|X/Y|Script|999>>>\nshort';
    expect(() => parseScriptStream(bad)).toThrow(/位元組數不符/);
  });

  it('🔴 用位元組數而非字元數校驗', () => {
    // 「中文」是 2 個字元、6 個位元組。用 String.length 比會誤判成不符。
    const source = '-- 中文';
    expect(source.length).not.toBe(Buffer.byteLength(source, 'utf8'));
    expect(() => parseScriptStream(frame('X/Y', 'ModuleScript', source))).not.toThrow();
  });

  it('腳本內容裡出現偽 header 時，會被位元組校驗擋下來而不是靜默吃掉', () => {
    // 框架是文字協定，理論上原始碼可以包含一行長得像 header 的東西。
    // 那會讓解析器誤以為換了一份檔案 —— 但接著位元組數就對不上，整批中止。
    // 這是**失效安全**：寧可抽取失敗，也不要寫出被截半的原始碼。
    const evil = 'print(1)\n<<<RBXFILE|Fake/Path|Script|5>>>\nprint(2)';
    const stream = `<<<RBXFILE|Real/Path|Script|${Buffer.byteLength(evil, 'utf8')}>>>\n${evil}`;
    expect(() => parseScriptStream(stream)).toThrow(/位元組數不符/);
  });

  it('完全沒有 header 時報錯而不是靜默回空', () => {
    expect(() => parseScriptStream('just some text')).toThrow(/找不到任何/);
  });

  it('真的空的資料流回空陣列', () => {
    expect(parseScriptStream('')).toEqual([]);
  });
});

describe('fileNameFor', () => {
  it.each([
    ['A/B/Handler', 'Script', 'Handler.server.luau'],
    ['A/B/Controller', 'LocalScript', 'Controller.client.luau'],
    ['A/B/Config', 'ModuleScript', 'Config.luau'],
  ])('%s (%s) → %s', (path, className, expected) => {
    expect(fileNameFor(path, className)).toBe(expected);
  });
});

describe('parseSliceHeader', () => {
  it('讀得出 Lua 回報的實際結束位置', () => {
    expect(parseSliceHeader('<<<AT|1234>>>payload')).toEqual({ endOffset: 1234, body: 'payload' });
  });

  it('缺少前綴時報錯 —— 沒有它就不知道下一段從哪開始', () => {
    expect(() => parseSliceHeader('payload')).toThrow(/缺少/);
  });
});

describe('sanitizeSegment', () => {
  it('🔴 擋掉會穿越出輸出目錄的名稱', () => {
    // Roblox 的實例可以叫 `..`，直接拿來拼路徑會寫到目錄外面。
    expect(sanitizeSegment('..')).toBe('_');
    expect(sanitizeSegment('.')).toBe('_');
    expect(sanitizeSegment('')).toBe('_');
  });

  it('換掉不能當檔名的字元', () => {
    expect(sanitizeSegment('a/b')).toBe('a_b');
    expect(sanitizeSegment('a\\b')).toBe('a_b');
    expect(sanitizeSegment('a:b?c*d')).toBe('a_b_c_d');
  });

  it('保留空白與連字號 —— 換掉會讓檔名跟實例名對不起來', () => {
    expect(sanitizeSegment('Main Menu-v2')).toBe('Main Menu-v2');
  });

  it('保留副檔名的點', () => {
    expect(sanitizeSegment('Config.luau')).toBe('Config.luau');
  });

  it('去掉 Windows 不允許的結尾點與空白', () => {
    expect(sanitizeSegment('name.')).toBe('name');
    expect(sanitizeSegment('name ')).toBe('name');
  });
});
