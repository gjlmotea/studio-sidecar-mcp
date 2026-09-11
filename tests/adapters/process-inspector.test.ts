import { describe, expect, it } from 'vitest';

import {
  parseLsofPids,
  parsePsLine,
  parsePsOutput,
} from '../../src/adapters/darwin-process-inspector.js';
import { asArray, toRawProcess } from '../../src/adapters/windows-process-inspector.js';
import { createProcessInspector } from '../../src/composition.js';
import { StudioHostError } from '../../src/ports/studio-host.js';

describe('darwin: parsePsLine', () => {
  it('拆得出 pid / ppid / 啟動時間 / 執行檔', () => {
    const row = parsePsLine(
      ' 1234   567 Fri Aug 30 02:48:00 2026 /Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio',
    );
    expect(row).toBeDefined();
    expect(row?.pid).toBe(1234);
    expect(row?.parentPid).toBe(567);
    expect(row?.name).toBe('RobloxStudio');
    expect(row?.executablePath).toBe('/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio');
    // `ps lstart` 是**本地時間且不帶時區**，正規化成 ISO(UTC) 後日期會隨執行機器的時區
    // 位移（UTC+8 這台就會退到前一天）。所以斷言要比時間點，不能比字串前綴。
    expect(row?.startedAt).toBeDefined();
    expect(new Date(row?.startedAt as string).getTime()).toBe(
      new Date('Fri Aug 30 02:48:00 2026').getTime(),
    );
  });

  it('執行檔路徑含空白時不會被切斷', () => {
    const row = parsePsLine(' 10 1 Fri Aug 30 02:48:00 2026 /Applications/My App/Contents/MacOS/StudioMCP');
    expect(row?.name).toBe('StudioMCP');
    expect(row?.executablePath).toBe('/Applications/My App/Contents/MacOS/StudioMCP');
  });

  it('日期無法解析時 startedAt 為 undefined，不整個放棄該行', () => {
    const row = parsePsLine(' 10 1 xxx xxx xxx xxx xxx /usr/bin/foo');
    expect(row?.pid).toBe(10);
    expect(row?.startedAt).toBeUndefined();
  });

  it.each(['', '   ', 'garbage', 'pid ppid lstart comm'])('丟得掉不成形的行：%s', (line) => {
    expect(parsePsLine(line)).toBeUndefined();
  });
});

describe('darwin: parsePsOutput', () => {
  it('略過空行與雜訊，只留成形的紀錄', () => {
    const rows = parsePsOutput(
      [
        ' 1 0 Fri Aug 30 02:00:00 2026 /sbin/launchd',
        '',
        'not a process line',
        ' 42 1 Fri Aug 30 02:48:00 2026 /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP',
      ].join('\n'),
    );
    expect(rows.map((r) => r.pid)).toEqual([1, 42]);
    expect(rows.map((r) => r.name)).toEqual(['launchd', 'StudioMCP']);
  });
});

describe('darwin: parseLsofPids', () => {
  it('只取 p 開頭的行', () => {
    expect(parseLsofPids('p1234\nn127.0.0.1:13469\np5678\nn127.0.0.1:13469')).toEqual([1234, 5678]);
  });

  it('去重', () => {
    expect(parseLsofPids('p99\nn:1\np99\nn:2')).toEqual([99]);
  });

  it('lsof 找不到連線時輸出為空 —— 那是正常結果不是錯誤', () => {
    expect(parseLsofPids('')).toEqual([]);
  });
});

describe('windows: asArray', () => {
  it('ConvertTo-Json 把單一元素塌成物件時補回陣列', () => {
    expect(asArray({ Pid: 1 })).toEqual([{ Pid: 1 }]);
  });

  it('null / undefined 視為空', () => {
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });

  it('本來就是陣列就原樣帶過', () => {
    expect(asArray([{ Pid: 1 }, { Pid: 2 }])).toHaveLength(2);
  });
});

describe('windows: toRawProcess', () => {
  it('把 PowerShell 的 null 轉成 undefined', () => {
    const row = toRawProcess({ Pid: 5, Ppid: 4, Started: null, Name: 'StudioMCP.exe', Path: null });
    expect(row.startedAt).toBeUndefined();
    expect(row.executablePath).toBeUndefined();
    expect(row.pid).toBe(5);
  });
});

describe('createProcessInspector', () => {
  it.each([
    ['win32', 'win32'],
    ['darwin', 'darwin'],
  ] as const)('%s 有對應的實作', (platform, expected) => {
    expect(createProcessInspector(platform).platform).toBe(expected);
  });

  it('其他平台明確拒絕，而不是靜默失敗', () => {
    // Roblox Studio 根本不存在於 Linux —— 與其回空快照讓呼叫端誤以為「沒有 Studio 在跑」，
    // 不如直接說不支援。
    expect(() => createProcessInspector('linux')).toThrow(StudioHostError);
  });
});
