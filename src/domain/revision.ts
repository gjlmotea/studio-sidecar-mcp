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
      message: 'Could not get the revisionId from before and after the update, so whether it took effect cannot be confirmed; check it yourself with roblox_get_asset.',
    };
  }

  if (after > before) {
    return {
      ...base,
      verdict: 'updated',
      message: `Content updated: revisionId ${before} → ${after}.`,
    };
  }

  return {
    ...base,
    verdict: 'deduplicated',
    message:
      `revisionId is still ${after}; the content did not change. `
      + 'For a byte-identical file, Open Cloud skips creating a new version and reports no error. '
      + 'This is not a failure, but it is not an update either. To really publish a new version, make sure the source file actually changed.',
  };
}
