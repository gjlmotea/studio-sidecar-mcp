import type { CleanupOutcome, StudioSnapshot } from '../domain/contracts.js';

/**
 * 本機的 Roblox Studio 行程。
 *
 * 這一層是內建 Studio MCP **結構上做不到**的部分：它活在某一個 Studio 行程裡面，
 * 沒辦法生兄弟行程，也看不到其他行程的存在。
 */
export interface StudioHost {
  /** Studio 執行檔路徑；解析不到時為 undefined。 */
  readonly executablePath: string | undefined;

  /** 目前的行程快照，含 broker 判定。 */
  snapshot(): Promise<StudioSnapshot>;

  /** 用啟動意圖生一個新的 Studio 行程，回傳 pid。 */
  launch(args: readonly string[]): Promise<number>;

  /** 這個 pid 有沒有連上 broker（＝已註冊，可被 `list_roblox_studios` 定址）。 */
  isConnectedToBroker(pid: number): Promise<boolean>;

  /** 讀行程的主視窗標題。**不要為此把視窗叫到前景** —— 見 openPlace 的註解。 */
  windowTitle(pid: number): Promise<string | undefined>;

  /** 行程還在不在。 */
  isAlive(pid: number): Promise<boolean>;

  /** 終止指定行程，並收掉它那層 cmd.exe 外殼（若已無子行程）。 */
  terminate(pids: readonly number[]): Promise<CleanupOutcome['failures']>;
}

export class StudioHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioHostError';
  }
}
