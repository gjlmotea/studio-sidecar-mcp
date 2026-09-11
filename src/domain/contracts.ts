import type { AssetType } from './asset-types.js';

/** Open Cloud 回的資產狀態。 */
export type AssetRecord = {
  readonly assetId: string;
  readonly displayName: string | undefined;
  readonly description: string | undefined;
  readonly assetType: string | undefined;
  /** 遞增的內容版本。判斷更新有沒有生效只能看這個。 */
  readonly revisionId: string | undefined;
  readonly revisionCreateTime: string | undefined;
  /**
   * 真正的**作者**。
   *
   * Studio MCP 的 `search_asset` 回的 `creatorId` 是**持有者**，兩者不同 ——
   * 這是唯一能分辨「你上傳的」與「你從工具箱拿的」的方法。
   */
  readonly creatorUserId: string | undefined;
  readonly moderationState: string | undefined;
  /** `Active` / `Archived`。 */
  readonly state: string | undefined;
};

export type UploadRequest = {
  readonly assetType: AssetType;
  readonly filePath: string;
  readonly displayName: string;
  readonly description: string;
  readonly creatorUserId: string;
};

export type UpdateRequest = {
  readonly assetId: string;
  readonly filePath: string;
  readonly assetType: AssetType;
};

export type RenameRequest = {
  readonly assetId: string;
  readonly displayName?: string;
  readonly description?: string;
};

/** Studio 行程的一筆快照。 */
export type StudioProcess = {
  readonly pid: number;
  readonly startedAt: string | undefined;
  readonly windowTitle: string | undefined;
  readonly executablePath: string | undefined;
};

/** StudioMCP.exe 的一筆快照，含它在 broker 架構裡的角色。 */
export type StudioMcpProcess = {
  readonly pid: number;
  readonly startedAt: string | undefined;
  readonly executablePath: string | undefined;
  /**
   * broker 在 127.0.0.1:13469 上 Listen，Studio 本身與所有 stub 都連進它。
   * 🔴 殺掉 broker 會斷掉所有連線，包含 Studio 自己。
   */
  readonly role: 'broker' | 'stub';
  /** 真正的 MCP 客戶端（往上跳過 cmd.exe 外殼）。 */
  readonly client: string | undefined;
};

export type StudioSnapshot = {
  readonly studios: readonly StudioProcess[];
  readonly mcpProcesses: readonly StudioMcpProcess[];
  readonly brokerPid: number | undefined;
  readonly brokerPort: number;
};

export type OpenPlaceOutcome = {
  readonly pid: number;
  readonly connected: boolean;
  readonly waitedMs: number;
  readonly windowTitle: string | undefined;
  readonly commandLine: string;
};

export type CleanupPlan = {
  readonly pid: number;
  readonly startedAt: string | undefined;
  readonly client: string | undefined;
};

export type CleanupOutcome = {
  readonly dryRun: boolean;
  readonly brokerPid: number | undefined;
  readonly planned: readonly CleanupPlan[];
  readonly terminated: readonly number[];
  readonly failures: readonly { readonly pid: number; readonly reason: string }[];
};
