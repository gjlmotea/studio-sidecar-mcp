import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { RobloxService } from '../application/roblox-service.js';
import { registerTools } from './register-tools.js';

export const SERVER_NAME = 'roblox-mcp';

export function createMcpServer(options: {
  readonly service: RobloxService;
  readonly version: string;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      instructions: [
        '本 server 是 Roblox Studio **內建** MCP 的補完層，不是替代品。',
        '腳本讀寫、場景查詢、generate_mesh、screen_capture、playtest 一律繼續用內建版的工具 —— 這裡沒有、也不會重做。',
        '這裡只提供內建版結構上做不到或完全沒有的三類能力：開啟還沒開的 place、StudioMCP 行程治理、Open Cloud 資產上傳與就地更新。',
        '要對還沒開的 place 動工時：先 roblox_open_place，等 connected=true，再用內建 MCP 的 list_roblox_studios 取 studio_id。',
        '🔴 任何寫入之前先驗 placeId。傳錯 studio_id 會覆蓋另一個遊戲的原始碼且沒有復原鍵；而且 game.Name 不可信（實測有已發佈的 place 開起來 game.Name 回的是 Place1），只有 game.PlaceId 可信。',
        '🔴 上傳的 Model 在平台上無法刪除也無法封存，只能從自己的物品欄移除。所以迭代一律用 roblox_update_asset 更新既有 assetId，不要每次 roblox_upload_asset。',
        '🔴 roblox_update_asset 的成功判準是 verdict 欄位，不是 HTTP 狀態：內容位元組相同時 Open Cloud 會靜默去重，回應一切正常但 revisionId 不動（verdict=deduplicated）。',
        'roblox_cleanup_stubs 預設只報告；要真的終止行程必須明確帶 apply=true，而且它永遠不會碰 broker。',
        '本 server 不執行 Luau、不讀寫 DataModel、也不碰視窗焦點（搶焦點會讓游離按鍵關掉剛載好的 place）。',
      ].join('\n'),
    },
  );

  registerTools(server, { service: options.service });
  return server;
}
