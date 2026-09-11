/**
 * 判定一次 PATCH 到底有沒有真的換掉內容。
 *
 * 🔴 這是本 server 存在的主要理由之一。2026-08-30 實測：用**位元組完全相同**的檔案
 * PATCH 同一個 assetId，Open Cloud 回 `HTTP 200`、operation 回 `done: true` 且
 * **沒有任何錯誤欄位**，但 `revisionId` 不動 —— 內容其實沒換。
 *
 * 這是正確的去重行為，不是失敗。但只要呼叫端拿 HTTP 狀態或 `done` 當成功判準，
 * 就會誤以為更新已經套用。唯一可靠的判準是 `revisionId` 有沒有遞增。
 */

export type UpdateVerdict =
  /** revisionId 遞增：內容確實換掉了。 */
  | 'updated'
  /** revisionId 沒動：內容與現有版本相同，Roblox 跳過建立新版本。 */
  | 'deduplicated'
  /** 拿不到前後其中一邊的 revisionId，無法判定。 */
  | 'indeterminate';

export type UpdateOutcome = {
  readonly verdict: UpdateVerdict;
  readonly revisionBefore: string | undefined;
  readonly revisionAfter: string | undefined;
  readonly message: string;
};

function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function classifyUpdate(
  revisionBefore: string | undefined,
  revisionAfter: string | undefined,
): UpdateOutcome {
  const before = toNumber(revisionBefore);
  const after = toNumber(revisionAfter);

  const base = { revisionBefore, revisionAfter } as const;

  if (before === undefined || after === undefined) {
    return {
      ...base,
      verdict: 'indeterminate',
      message: '拿不到前後的 revisionId，無法確認更新是否生效；請自行以 roblox_get_asset 複查。',
    };
  }

  if (after > before) {
    return {
      ...base,
      verdict: 'updated',
      message: `內容已更新：revisionId ${before} → ${after}。`,
    };
  }

  return {
    ...base,
    verdict: 'deduplicated',
    message:
      `revisionId 仍為 ${after}，內容沒有變更。`
      + 'Open Cloud 對位元組相同的檔案會跳過建立新版本，並且不回報錯誤 —— '
      + '這不是失敗，但也不是更新。要真的換版請確認來源檔確實改過。',
  };
}
