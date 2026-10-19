import { describe, expect, it } from 'vitest';

import {
  BUFFER_IDLE_SECONDS,
  buildScriptStreamLuau,
  newBufferKey,
  releaseBufferLuau,
  runUserLuau,
  sliceBufferLuau,
} from '../../src/domain/luau-payloads.js';

/**
 * 這裡沒有 Luau 直譯器，只能檢查送出去的程式長什麼樣子；實際在 Studio 裡跑要靠 `verify:extract`。
 */
describe('🔴 buffer 會到期，釋放不掉的 key 不會永遠留在 shared 裡', () => {
  const key = newBufferKey();

  it.each([
    ['抽取', buildScriptStreamLuau(key)],
    ['執行 Luau', runUserLuau(key, 'return "x"')],
  ])('%s建立 buffer 前先清掉到期的，再登記自己的到期時間', (_name, code) => {
    expect(code).toContain('shared.RBXEXTRACT_EXPIRES');
    expect(code).toContain('deadline < now');
    expect(code).toContain('shared[name] = nil');
    // 只清名字是 buffer key 格式的項目，不會誤刪 shared 裡別的東西。
    expect(code).toContain('string.match(name, "^RBXEXTRACT_%x+$")');
    expect(code).toContain(`expires["${key}"] = now + ${String(BUFFER_IDLE_SECONDS)}`);
    // 登記在 buffer 寫入之前：清理出錯也包在 pcall 裡，不會擋住後面的工作。
    expect(code.indexOf('RBXEXTRACT_EXPIRES')).toBeLessThan(code.indexOf(`shared.${key} =`));
    expect(code.trimStart().startsWith('pcall(function()')).toBe(true);
  });

  it('每次切片把到期時間往後延，進行中的抽取不會被當成閒置', () => {
    expect(sliceBufferLuau(key, 1, 100)).toContain(`expires["${key}"] = os.time() + ${String(BUFFER_IDLE_SECONDS)}`);
  });

  it('釋放時連到期表裡的登記一起拿掉', () => {
    const code = releaseBufferLuau(key);
    expect(code).toContain(`shared.${key} = nil`);
    expect(code).toContain(`expires["${key}"] = nil`);
  });

  it('閒置門檻遠大於一次切片呼叫的上限（180 秒）', () => {
    expect(BUFFER_IDLE_SECONDS).toBeGreaterThanOrEqual(5 * 180);
  });
});
