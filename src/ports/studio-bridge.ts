/**
 * 連到 Studio 內建 MCP 的橋。
 *
 * 本 server 在這裡**同時扮演 MCP server 與 MCP client** —— 對 Claude Code 是 server，
 * 對 `StudioMCP.exe` 是 client。協定沒有禁止這件事，2026-08-30 實測通過
 * （`scripts/probe-chaining.mjs`）。
 *
 * 這是取得 `execute_luau` 的唯一正當途徑：不必逆向 broker 在 13469 的未公開協定。
 */

export type ConnectedStudio = {
  readonly id: string;
  readonly name: string;
};

export interface StudioBridge {
  listStudios(): Promise<readonly ConnectedStudio[]>;

  /** 執行 Luau 並回傳原始文字。截斷偵測由呼叫端負責（見 domain/extraction）。 */
  executeLuau(studioId: string, code: string, datamodel?: 'Edit' | 'Client' | 'Server'): Promise<string>;

  /**
   * 收線。
   *
   * 🔴 **一定要呼叫。** 正常 close 會連帶收掉 `StudioMCP.exe` 子行程；不收就是在
   * 製造 stub 洩漏（成因見 vibe/roblox/README.md 的〈stub 為什麼會增生〉）。
   */
  close(): Promise<void>;
}

export class StudioBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StudioBridgeError';
  }
}
