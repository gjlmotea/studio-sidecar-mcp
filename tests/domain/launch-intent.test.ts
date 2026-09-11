import { describe, expect, it } from 'vitest';

import {
  buildLaunchIntent,
  buildStudioArgs,
  describeWindowsCommandLine,
  LaunchIntentError,
  quoteWindowsArgument,
} from '../../src/domain/launch-intent.js';

const SAMPLE_GAME = { placeId: '100000000000123', universeId: '10000000123' } as const;

describe('buildLaunchIntent', () => {
  it('產生與官方啟動器同形狀的意圖', () => {
    expect(buildLaunchIntent(SAMPLE_GAME)).toBe(
      '{"task":"EditPlace","universeid":"10000000123","placeid":"100000000000123"}',
    );
  });

  it('id 一律當字串，不因超過 2^53 而失真', () => {
    const intent = buildLaunchIntent({ placeId: '9007199254740993', universeId: '1' });
    expect(intent).toContain('"placeid":"9007199254740993"');
  });

  it.each([
    ['空字串', ''],
    ['帶引號', '123"456'],
    ['帶空白', '123 456'],
    ['非數字', 'abc'],
    ['負號', '-1'],
  ])('拒絕不是十進位數字的 placeId（%s）', (_label, placeId) => {
    expect(() => buildLaunchIntent({ placeId, universeId: '1' })).toThrow(LaunchIntentError);
  });
});

describe('quoteWindowsArgument', () => {
  it('沒有空白與引號時不加引號', () => {
    expect(quoteWindowsArgument('-launchIntentString')).toBe('-launchIntentString');
  });

  it('把 JSON 的內層引號跳脫成 \\" —— 這是整招唯一的陷阱', () => {
    // 裸 JSON 的引號會被 Windows 命令列吃掉，Studio 收到壞掉的 JSON 之後
    // 靜默忽略整個 intent、開一個空白 session，而且完全沒有錯誤訊息。
    expect(quoteWindowsArgument('{"task":"EditPlace"}')).toBe('"{\\"task\\":\\"EditPlace\\"}"');
  });

  it('引號前的反斜線要加倍', () => {
    expect(quoteWindowsArgument('a\\"b')).toBe('"a\\\\\\"b"');
  });

  it('沒有空白也沒有引號時不加引號 —— 這是 CommandLineToArgvW 的規則', () => {
    expect(quoteWindowsArgument('C:\\path\\')).toBe('C:\\path\\');
  });

  it('需要加引號時，結尾的反斜線要加倍，才不會跟收尾引號黏在一起', () => {
    expect(quoteWindowsArgument('C:\\my path\\')).toBe('"C:\\my path\\\\"');
  });

  it('空字串仍要有引號', () => {
    expect(quoteWindowsArgument('')).toBe('""');
  });
});

describe('buildStudioArgs', () => {
  it('參數以陣列交出，由 spawn 負責平台引號規則', () => {
    expect(buildStudioArgs(SAMPLE_GAME)).toEqual([
      '-launchIntentString',
      '{"task":"EditPlace","universeid":"10000000123","placeid":"100000000000123"}',
    ]);
  });
});

describe('describeWindowsCommandLine', () => {
  it('重現實測成功的那條命令列', () => {
    const line = describeWindowsCommandLine('C:\\Roblox\\RobloxStudioBeta.exe', SAMPLE_GAME);
    expect(line).toBe(
      '"C:\\Roblox\\RobloxStudioBeta.exe" -launchIntentString '
      + '"{\\"task\\":\\"EditPlace\\",\\"universeid\\":\\"10000000123\\",\\"placeid\\":\\"100000000000123\\"}"',
    );
  });
});
