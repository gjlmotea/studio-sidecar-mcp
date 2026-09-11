import { describe, expect, it } from 'vitest';

import { classifyUpdate } from '../../src/domain/revision.js';

describe('classifyUpdate', () => {
  it('revisionId 遞增＝內容確實換掉了', () => {
    const outcome = classifyUpdate('1', '2');
    expect(outcome.verdict).toBe('updated');
    expect(outcome.message).toContain('1 → 2');
  });

  it('revisionId 不動＝Open Cloud 靜默去重，不是成功的更新', () => {
    // 2026-08-30 實測：位元組相同的檔案 PATCH，HTTP 200、operation done、無錯誤欄位，
    // 但 revisionId 不動。只看回應會誤判成功 —— 這正是本判定存在的理由。
    const outcome = classifyUpdate('1', '1');
    expect(outcome.verdict).toBe('deduplicated');
    expect(outcome.message).toContain('沒有變更');
  });

  it('revisionId 倒退也算沒有更新', () => {
    expect(classifyUpdate('3', '2').verdict).toBe('deduplicated');
  });

  it.each([
    ['前值缺席', undefined, '2'],
    ['後值缺席', '1', undefined],
    ['兩邊都缺', undefined, undefined],
    ['不是數字', 'abc', '2'],
  ])('拿不到可比對的 revisionId 時不亂猜（%s）', (_label, before, after) => {
    expect(classifyUpdate(before, after).verdict).toBe('indeterminate');
  });

  it('把前後值原樣帶回，方便呼叫端自行複查', () => {
    const outcome = classifyUpdate('7', '8');
    expect(outcome.revisionBefore).toBe('7');
    expect(outcome.revisionAfter).toBe('8');
  });
});
