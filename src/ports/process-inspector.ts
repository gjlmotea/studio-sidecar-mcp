/**
 * 作業系統層的行程與 loopback 連線查詢。
 *
 * 這一層存在的唯一理由是**隔離平台差異**：Windows 走 PowerShell（CIM + Get-NetTCPConnection），
 * macOS 走 `ps` 與 `lsof`。broker 判定、stub 分類、清理策略等邏輯全部在
 * `LocalStudioHost` 裡共用，不因平台而分岔。
 */

export type RawProcess = {
  readonly pid: number;
  readonly parentPid: number;
  /** ISO 8601；取不到時 undefined。 */
  readonly startedAt: string | undefined;
  readonly name: string;
  readonly executablePath: string | undefined;
  /**
   * 主視窗標題。
   *
   * ⚠️ macOS 一律 undefined —— 沒有 Accessibility 授權就讀不到別的 App 的視窗標題，
   * 而為了診斷去要那個權限不成比例。呼叫端只把它當線索，不能拿來做判斷。
   */
  readonly windowTitle: string | undefined;
};

export interface ProcessInspector {
  readonly platform: NodeJS.Platform;

  /**
   * 一次列出全部行程。
   *
   * 🔴 **刻意不提供 `listByName` / `get(pid)` 這種細粒度查詢。** 第一版是那樣寫的，
   * 結果 `snapshot()` 要對每個 stub 走最多四層父行程 —— 16 隻 stub × 5 次查詢 ＝
   * 約 80 次 PowerShell 啟動，直接撞穿 MCP 的 60 秒逾時。
   * 兩個平台的底層命令（`Get-CimInstance Win32_Process` / `ps -axo`）本來就是列全部，
   * 所以正確的形狀是**一次取回、在記憶體裡過濾與走父鏈**。
   */
  listAll(): Promise<readonly RawProcess[]>;

  /** 哪個行程在這個 loopback port 上 Listen（＝broker）。 */
  listeningPid(port: number): Promise<number | undefined>;

  /** 有連到這個 port 的行程 pid。 */
  connectedPids(port: number): Promise<readonly number[]>;

  isAlive(pid: number): Promise<boolean>;

  /** 終止行程；回傳失敗清單。 */
  kill(pids: readonly number[]): Promise<readonly { readonly pid: number; readonly reason: string }[]>;
}

export class ProcessInspectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcessInspectorError';
  }
}
