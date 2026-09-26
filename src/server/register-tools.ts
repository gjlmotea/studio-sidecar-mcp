import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { RobloxService } from '../application/roblox-service.js';
import { ASSET_TYPE_RULES, type AssetType } from '../domain/asset-types.js';
import {
  archiveAssetInputSchema,
  archiveAssetOutputSchema,
  cleanupStubsInputSchema,
  cleanupStubsOutputSchema,
  extractPlaceInputSchema,
  extractPlaceOutputSchema,
  getAssetInputSchema,
  getAssetOutputSchema,
  getStatusInputSchema,
  listStudiosInputSchema,
  listStudiosOutputSchema,
  luauSafeInputSchema,
  luauSafeOutputSchema,
  placeGuardInputSchema,
  placeGuardOutputSchema,
  openPlaceInputSchema,
  openPlaceOutputSchema,
  statusOutputSchema,
  updateAssetInputSchema,
  updateAssetOutputSchema,
  uploadAssetInputSchema,
  uploadAssetOutputSchema,
} from './schemas.js';

type ToolDependencies = { readonly service: RobloxService };

function ok(payload: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: payload,
    isError: false,
  };
}

function fail(summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    isError: true,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 拿掉值為 undefined 的欄位。
 *
 * 本專案開了 `exactOptionalPropertyTypes`，「不存在」與「存在但為 undefined」是兩件事；
 * 直接把 zod 的 `.optional()` 結果轉交會被型別系統擋下來。
 */
function compact<T extends Record<string, unknown>>(value: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result as { [K in keyof T]?: NonNullable<T[K]> };
}

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export function registerTools(server: McpServer, { service }: ToolDependencies): void {
  // ── 狀態 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'roblox_get_status',
    {
      title: '讀取 Roblox companion 狀態',
      description:
        '回報 Studio 執行檔解析結果、Open Cloud 金鑰是否就緒、允許的上傳目錄。動手之前先看這個。',
      inputSchema: getStatusInputSchema,
      outputSchema: statusOutputSchema,
      annotations: READ_ONLY,
    },
    () => {
      const status = service.status();
      return ok(
        { ...compact(status), allowedUploadRoots: status.allowedUploadRoots },
        [
          `Studio 執行檔：${status.studioExecutable ?? '（解析不到）'}`,
          `Open Cloud：${status.openCloudConfigured ? '已設定金鑰' : '未設定 ROBLOX_API_KEY'}`,
          `允許上傳的目錄：${status.allowedUploadRoots.length === 0 ? '（未設定，上傳一律拒絕）' : status.allowedUploadRoots.join(', ')}`,
        ].join('\n'),
      );
    },
  );

  // ── Studio 行程 ──────────────────────────────────────────────────────
  server.registerTool(
    'roblox_list_studios',
    {
      title: '列出 Studio 與 StudioMCP 行程',
      description:
        '列出本機的 Roblox Studio 行程，以及 StudioMCP 的 broker 與 stub。'
        + '這是內建 MCP 看不到的視角 —— 它活在某一個 Studio 行程裡面。',
      inputSchema: listStudiosInputSchema,
      outputSchema: listStudiosOutputSchema,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const snapshot = await service.listStudios();
        const stubs = snapshot.mcpProcesses.filter((row) => row.role === 'stub').length;
        return ok(
          {
            brokerPort: snapshot.brokerPort,
            ...compact({ brokerPid: snapshot.brokerPid }),
            studios: snapshot.studios.map((row) => compact({ ...row })),
            mcpProcesses: snapshot.mcpProcesses.map((row) => ({ ...compact(row), role: row.role })),
          },
          `Studio ${snapshot.studios.length} 個；StudioMCP broker ${snapshot.brokerPid ?? '（找不到）'}、stub ${stubs} 隻。`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_open_place',
    {
      title: '開啟指定的 place',
      description:
        '生一個新的 Studio 行程開啟指定 place，並等它註冊到 MCP broker。'
        + '內建 MCP 結構上做不到這件事 —— 它活在某一個 Studio 行程裡面，沒辦法生兄弟行程。'
        + '回報 connected=true 之後，用內建 MCP 的 list_roblox_studios 取得該實例的 studio_id。'
        + '⚠ 本工具全程不碰視窗焦點：搶焦點會讓游離按鍵關掉剛載好的 place。',
      inputSchema: openPlaceInputSchema,
      outputSchema: openPlaceOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.openPlace(
          compact({
            placeId: input.placeId,
            universeId: input.universeId,
            waitMs: input.waitMs,
          }) as { placeId: string; universeId: string; waitMs?: number },
        );
        const summary = result.connected
          ? `已開啟並註冊（pid ${result.pid}，等待 ${Math.round(result.waitedMs / 1000)} 秒）。`
            + '現在用內建 MCP 的 list_roblox_studios 取 studio_id。'
          : `Studio 已啟動（pid ${result.pid}）但 ${Math.round(result.waitedMs / 1000)} 秒內沒有註冊到 broker。`
            + `視窗標題「${result.windowTitle ?? '（讀不到）'}」—— 若標題沒有帶 place 名，`
            + '代表啟動意圖沒被吃下去。';
        return ok({ ...compact(result), commandLine: result.commandLine }, summary);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_cleanup_stubs',
    {
      title: '清理殘留的 StudioMCP stub',
      description:
        'MCP 客戶端結束時不一定會回收自己的 StudioMCP stub，會日積月累。'
        + '本工具永遠排除 broker（殺掉它會斷掉所有連線，包含 Studio 自己），'
        + '且辨識不出 broker 時整個放棄。預設只報告，要真的清除必須明確帶 apply=true。',
      inputSchema: cleanupStubsInputSchema,
      outputSchema: cleanupStubsOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.cleanupStubs(
          compact({ olderThanHours: input.olderThanHours, apply: input.apply }),
        );
        const summary = result.dryRun
          ? `可清除 ${result.planned.length} 隻（未動手；broker ${result.brokerPid} 已排除）。要執行請帶 apply=true。`
          : `已終止 ${result.terminated.length} 隻，失敗 ${result.failures.length} 隻（broker ${result.brokerPid} 已排除）。`;
        return ok(
          {
            dryRun: result.dryRun,
            ...compact({ brokerPid: result.brokerPid }),
            planned: result.planned.map((row) => compact({ ...row })),
            terminated: [...result.terminated],
            failures: result.failures.map((row) => ({ ...row })),
          },
          summary,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  // ── Studio 端執行 ────────────────────────────────────────────────────
  server.registerTool(
    'roblox_place_guard',
    {
      title: '寫入前確認目標 place',
      description:
        '逐一詢問連線中的 Studio，回報哪一個的 `game.PlaceId` 等於你要的值，並給出它的 studio_id。'
        + '🔴 **任何寫入之前都該先跑這個。** 內建版的 multi_edit 是用路徑寫入的，'
        + '傳錯 studio_id 會直接覆蓋另一個遊戲的原始碼、沒有復原鍵、而且沒有任何警告。'
        + '⚠️ `game.Name` 不可信 —— 實測有已發佈的 place 開起來時它回的是 `Place1`，只有 placeId 分得出來。',
      inputSchema: placeGuardInputSchema,
      outputSchema: placeGuardOutputSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const result = await service.guardPlace(input.placeId);
        return ok(
          { ...result },
          `✅ ${result.studioName} 就是 placeId ${result.placeId}（gameId ${result.gameId}）。`
          + `\n後續呼叫用 studio_id: ${result.studioId}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_luau_safe',
    {
      title: '在指定 place 執行 Luau，不截斷、不整段中止',
      description:
        '在 placeId 相符的 Studio 執行 Luau。相對於內建版的 execute_luau 多三道護欄：'
        + '① **強制 placeId 守衛**，對不上就中止、不執行任何程式碼；'
        + '② **整段包 pcall** —— execute_luau 沒有 RobloxScript capability，碰到受保護屬性'
        + '（如 Lighting.Technology）會讓整段中止，包起來之後錯誤變成可讀的回傳值；'
        + '③ **結果走 buffer 分塊取回**，不受 100000 字元上限限制，不會被靜默截斷。'
        + '這不是新的執行入口 —— execute_luau 本來就在你手上，這裡加的只是護欄。',
      inputSchema: luauSafeInputSchema,
      outputSchema: luauSafeOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.runLuau(
          compact({
            placeId: input.placeId,
            code: input.code,
            chunkBytes: input.chunkBytes,
          }) as { placeId: string; code: string; chunkBytes?: number },
        );
        const head = result.ok
          ? `在「${result.studioName}」執行成功（${result.bytes} 位元組，${result.chunks} 塊）。`
          : `在「${result.studioName}」執行時拋錯：`;
        return ok({ ...result }, `${head}\n${result.result}`);
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  // ── 抽取 ─────────────────────────────────────────────────────────────
  server.registerTool(
    'roblox_extract_place',
    {
      title: '把 place 抽成可 diff 的文字快照',
      description:
        '把 place 的所有腳本與 place 設定抽成純文字寫進輸出目錄（src/**、scene/place.json、scene/scripts.json）。'
        + '**全程唯讀**，不對 DataModel 做任何寫入。'
        + '本工具把「execute_luau 單次回傳上限 100000 字元、超過靜默截斷」的整套分塊／哨兵／'
        + '逐檔位元組校驗機械包起來 —— 任一塊少了哨兵就整批中止，'
        + '因為局部正確的快照比抽取失敗更危險（它看起來成功了）。'
        + '會先逐一詢問連線中的 Studio 驗 placeId，對不上就中止。',
      inputSchema: extractPlaceInputSchema,
      outputSchema: extractPlaceOutputSchema,
      annotations: {
        readOnlyHint: false, // 對 Studio 唯讀，但會寫本機檔案
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      try {
        const result = await service.extractPlace(
          compact({
            placeId: input.placeId,
            outDir: input.outDir,
            chunkBytes: input.chunkBytes,
          }) as { placeId: string; outDir: string; chunkBytes?: number },
        );
        return ok(
          { ...result, written: [...result.written] },
          `已從「${result.studioName}」抽出 ${result.scriptCount} 份腳本`
          + `（${result.totalBytes} 位元組，分 ${result.chunks} 塊取回，逐檔位元組數校驗通過）。`
          + `\n寫出 ${result.written.length} 個檔案到 ${input.outDir}。`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  // ── Open Cloud 資產 ──────────────────────────────────────────────────
  server.registerTool(
    'roblox_get_asset',
    {
      title: '查資產狀態與真正的作者',
      description:
        '回傳 revisionId、moderationState、state 與 creatorUserId。'
        + 'creatorUserId 是**作者**；內建 MCP 的 search_asset 回的 creatorId 是**持有者**，兩者不同 —— '
        + '這是唯一能分辨「你上傳的」與「你從工具箱拿的」的方法。',
      inputSchema: getAssetInputSchema,
      outputSchema: getAssetOutputSchema,
      annotations: READ_ONLY,
    },
    async (input) => {
      try {
        const asset = await service.getAsset(input.assetId);
        return ok(
          { asset: compact({ ...asset }) },
          `${asset.displayName ?? asset.assetId}｜${asset.assetType ?? '?'}｜revision ${asset.revisionId ?? '?'}`
          + `｜${asset.moderationState ?? '?'}｜${asset.state ?? '?'}｜作者 ${asset.creatorUserId ?? '?'}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_upload_asset',
    {
      title: '上傳本機檔案為新資產',
      description:
        '走 Open Cloud assets/v1 建立新資產（Model 只吃 .fbx，Decal 吃常見影像格式，Audio 吃 mp3/ogg）。'
        + '🔴 上傳的 Model 在平台上無法刪除也無法封存，只能從自己的物品欄移除 —— '
        + '所以迭代時請改用 roblox_update_asset 更新既有 assetId，不要每次都建立新的。'
        + '來源檔必須位於 ROBLOX_UPLOAD_ROOT 允許的目錄內。',
      inputSchema: uploadAssetInputSchema,
      outputSchema: uploadAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const asset = await service.uploadAsset(
          compact({
            filePath: input.filePath,
            displayName: input.displayName,
            description: input.description,
            assetType: input.assetType as AssetType | undefined,
            creatorUserId: input.creatorUserId,
          }) as { filePath: string; displayName: string },
        );
        const caveat = asset.assetType === undefined
          ? undefined
          : ASSET_TYPE_RULES[asset.assetType as AssetType]?.caveat;
        return ok(
          { asset: compact({ ...asset }), ...compact({ warning: caveat }) },
          `已建立 assetId ${asset.assetId}（${asset.moderationState ?? '?'}）。`
          + `${caveat === undefined ? '' : `\n⚠ ${caveat}`}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_update_asset',
    {
      title: '就地更新既有資產的內容',
      description:
        '對同一個 assetId 推新內容（這是「Package 而非 Model」策略的實作路徑）。'
        + '🔴 內容位元組相同時 Open Cloud 會**靜默去重**：HTTP 200、作業完成、無錯誤，但 revisionId 不動。'
        + '本工具會自動比對更新前後的 revisionId 並回報 verdict —— 不要拿 HTTP 狀態當成功判準。',
      inputSchema: updateAssetInputSchema,
      outputSchema: updateAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const { asset, outcome } = await service.updateAsset(
          compact({
            assetId: input.assetId,
            filePath: input.filePath,
            assetType: input.assetType as AssetType | undefined,
          }) as { assetId: string; filePath: string },
        );
        return ok(
          {
            asset: compact({ ...asset }),
            verdict: outcome.verdict,
            ...compact({
              revisionBefore: outcome.revisionBefore,
              revisionAfter: outcome.revisionAfter,
            }),
            message: outcome.message,
          },
          outcome.message,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );

  server.registerTool(
    'roblox_archive_asset',
    {
      title: '封存或還原資產',
      description:
        '對**支援封存的型別**有效。Model 與 Decal 從未支援封存，本工具會先擋下來並說明原因，'
        + '不會讓你對著必定失敗的請求重試。',
      inputSchema: archiveAssetInputSchema,
      outputSchema: archiveAssetOutputSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input) => {
      try {
        const asset = await service.archiveAsset(input.assetId, input.restore === true);
        return ok(
          { asset: compact({ ...asset }) },
          `${input.restore === true ? '已還原' : '已封存'} ${asset.assetId}：state=${asset.state ?? '?'}`,
        );
      } catch (error) {
        return fail(message(error));
      }
    },
  );
}
