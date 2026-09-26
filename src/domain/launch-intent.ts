/**
 * Roblox Studio 的啟動意圖（launch intent）。
 *
 * 內建 Studio MCP 活在某一個 Studio 行程裡面，所以它**結構上不可能**開啟一個還沒開的
 * place —— 生一個兄弟行程是作業系統層級的事。這個模組負責產生正確的啟動參數。
 *
 * 形狀取自 Roblox 官方啟動器實際下的命令列（2026-08-30 於 Windows 實測）：
 *
 * ```
 * RobloxStudioBeta.exe -launchIntentString "{\"task\":\"EditPlace\",\"universeid\":\"…\",\"placeid\":\"…\"}"
 * ```
 */

/** 目前只支援編輯既有 place；其餘 task 沒有實測過，不先宣稱支援。 */
export const LAUNCH_TASK_EDIT_PLACE = 'EditPlace' as const;

export type LaunchIntentRequest = {
  /** `scene/place.json` 的 `placeId`。 */
  readonly placeId: string;
  /** `scene/place.json` 的 `gameId`。Roblox 在這個參數裡叫它 universeid。 */
  readonly universeId: string;
};

export class LaunchIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchIntentError';
  }
}

const DIGITS = /^[0-9]+$/;

/**
 * 產生 `-launchIntentString` 的值。
 *
 * id 一律當字串處理並嚴格檢查為十進位數字：placeId 會超過 2^53
 * （目前的 placeId 約在 10¹⁴ 量級，還在範圍內，但沒有理由賭下一個），
 * 而且這個值會被塞進命令列，不能讓非數字內容流進去。
 */
export function buildLaunchIntent(request: LaunchIntentRequest): string {
  for (const [label, value] of [
    ['placeId', request.placeId],
    ['universeId', request.universeId],
  ] as const) {
    if (!DIGITS.test(value)) {
      throw new LaunchIntentError(`${label} 必須是十進位數字字串，收到：${JSON.stringify(value)}`);
    }
  }

  // 欄位順序刻意與官方啟動器一致，方便和真實命令列逐字比對。
  return JSON.stringify({
    task: LAUNCH_TASK_EDIT_PLACE,
    universeid: request.universeId,
    placeid: request.placeId,
  });
}

/** Studio 執行檔的參數陣列。交給 `child_process.spawn`，由它負責平台的引號處理。 */
export function buildStudioArgs(request: LaunchIntentRequest): readonly string[] {
  return ['-launchIntentString', buildLaunchIntent(request)];
}

/**
 * 依 Windows 的 `CommandLineToArgvW` 規則替單一參數加引號。
 *
 * 🔴 這是這整招唯一的陷阱，而且失敗時**完全無聲**：裸 JSON 的 `"` 會被命令列解析吃掉，
 * Studio 收到壞掉的 JSON 之後**靜默忽略整個 intent**、開一個空白 session。沒有錯誤訊息，
 * 唯一線索是視窗標題停在 `Roblox Studio` 而不是 `<place 名> - Roblox Studio`。
 *
 * 執行期不靠這個函式（`spawn` 自己會處理），但它讓規則變成可測的，
 * 也用來產生診斷用的「預期命令列」字串。
 */
export function quoteWindowsArgument(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value;

  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1;
      continue;
    }
    if (char === '"') {
      // 引號前面的反斜線要加倍，引號本身再多一個反斜線。
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  // 結尾的反斜線會和收尾引號黏在一起，也要加倍。
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

/**
 * 產生預期的完整命令列，僅供診斷與人工比對，不用來執行。
 *
 * 執行檔路徑**一律**加引號：`CommandLineToArgvW` 的規則說沒有空白就不必加，
 * 但官方啟動器實測就是加引號的形狀，而且 Roblox 的安裝路徑隨時可能出現空白。
 * 診斷輸出要能跟真實命令列逐字比對，所以這裡跟著官方走而不是跟著最小規則走。
 */
export function describeWindowsCommandLine(
  executablePath: string,
  request: LaunchIntentRequest,
): string {
  const executable = `"${executablePath.replaceAll('"', '\\"')}"`;
  return [executable, ...buildStudioArgs(request).map(quoteWindowsArgument)].join(' ');
}
