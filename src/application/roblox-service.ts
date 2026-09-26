import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { assertArchivable, inferAssetType, type AssetType } from '../domain/asset-types.js';
import {
  DEFAULT_CHUNK_BYTES,
  ExtractionError,
  fileNameFor,
  parseScriptStream,
  unwrapChunk,
  type ExtractedFile,
} from '../domain/extraction.js';
import {
  buildScriptStreamLuau,
  LUAU_ERROR_PREFIX,
  parseSliceHeader,
  placeGuardLuau,
  placeMetaLuau,
  releaseBufferLuau,
  runUserLuau,
  sliceBufferLuau,
} from '../domain/luau-payloads.js';
import type { StudioBridge } from '../ports/studio-bridge.js';
import type {
  AssetRecord,
  CleanupOutcome,
  CleanupPlan,
  OpenPlaceOutcome,
  StudioSnapshot,
} from '../domain/contracts.js';
import { buildStudioArgs, describeWindowsCommandLine } from '../domain/launch-intent.js';
import { classifyUpdate, type UpdateOutcome } from '../domain/revision.js';
import type { OpenCloud } from '../ports/open-cloud.js';
import type { StudioHost } from '../ports/studio-host.js';

export class RobloxServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RobloxServiceError';
  }
}

export type RobloxServiceOptions = {
  readonly studio: StudioHost;
  readonly openCloud: OpenCloud;
  readonly version: string;
  /** 允許上傳的來源根目錄。空陣列＝一律拒絕。 */
  readonly allowedUploadRoots: readonly string[];
  readonly defaultCreatorUserId?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** 連到內建 Studio MCP 的橋；抽取功能需要它。 */
  readonly bridge?: StudioBridge;
  /** 寫檔；路徑相對於抽取的輸出目錄。 */
  readonly writeFile?: (outDir: string, relativePath: string, content: string) => Promise<string>;
};

export type ExtractOptions = {
  readonly placeId: string;
  readonly outDir: string;
  readonly chunkBytes?: number;
};

export type ExtractOutcome = {
  readonly placeId: string;
  readonly gameId: string;
  readonly studioName: string;
  readonly scriptCount: number;
  readonly totalBytes: number;
  readonly chunks: number;
  readonly written: readonly string[];
};

export type OpenPlaceOptions = {
  readonly placeId: string;
  readonly universeId: string;
  readonly waitMs?: number;
};

export type CleanupOptions = {
  readonly olderThanHours?: number;
  readonly apply?: boolean;
};

export type UploadOptions = {
  readonly filePath: string;
  readonly displayName: string;
  readonly description?: string;
  readonly assetType?: AssetType;
  readonly creatorUserId?: string;
};

export type UpdateOptions = {
  readonly assetId: string;
  readonly filePath: string;
  readonly assetType?: AssetType;
};

export class RobloxService {
  readonly #studio: StudioHost;
  readonly #openCloud: OpenCloud;
  readonly #version: string;
  readonly #roots: readonly string[];
  readonly #defaultCreator: string | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #bridge: StudioBridge | undefined;
  readonly #writeFile: RobloxServiceOptions['writeFile'];

  constructor(options: RobloxServiceOptions) {
    this.#studio = options.studio;
    this.#openCloud = options.openCloud;
    this.#version = options.version;
    this.#roots = options.allowedUploadRoots.map((root) => resolve(root));
    this.#defaultCreator = options.defaultCreatorUserId;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = options.now ?? Date.now;
    this.#bridge = options.bridge;
    this.#writeFile = options.writeFile;
  }

  #requireBridge(): StudioBridge {
    const bridge = this.#bridge;
    if (bridge === undefined) throw new RobloxServiceError('未組裝 Studio 橋，無法與 Studio 溝通。');
    return bridge;
  }

  /**
   * 逐一詢問連線中的 Studio，找出 placeId 相符的那一個。
   *
   * 🔴 這是所有寫入與抽取的前置。`multi_edit` 之類的工具是用路徑寫入的，
   * 傳錯 `studio_id` 會**直接覆蓋另一個遊戲的原始碼且沒有復原鍵**，而且不會有任何警告。
   * 另外 `game.Name` 不可信（實測有已發佈的 place 開起來回的是 `Place1`），只有 placeId 分得出來。
   */
  async #findStudioByPlaceId(
    bridge: StudioBridge,
    placeId: string,
  ): Promise<{ readonly id: string; readonly name: string; readonly gameId: string }> {
    const studios = await bridge.listStudios();
    if (studios.length === 0) {
      throw new RobloxServiceError(
        '沒有連線中的 Studio。請先開啟目標 place（可用 roblox_open_place）。',
      );
    }
    for (const studio of studios) {
      const raw = await bridge.executeLuau(studio.id, placeGuardLuau(placeId));
      const body = unwrapChunk(raw, `placeId 守衛（${studio.name}）`);
      if (/match=true/.test(body)) {
        return { ...studio, gameId: /gameId=(\d+)/.exec(body)?.[1] ?? '0' };
      }
    }
    throw new RobloxServiceError(
      `連線中的 Studio 沒有一個是 placeId ${placeId}：${studios.map((s) => s.name).join('、')}。`
      + '對不上就中止 —— 認錯 place 的後果是覆蓋別的遊戲，沒有復原鍵。',
    );
  }

  /**
   * 把 Lua VM buffer 裡的內容分塊取回並組裝。
   *
   * 切點的 UTF-8 安全由 Lua 決定並回報，這裡拿它的答案當下一段起點 ——
   * 兩邊各自算邊界遲早會不同步。
   */
  async #drainBuffer(
    bridge: StudioBridge,
    studioId: string,
    totalBytes: number,
    chunkBytes: number,
  ): Promise<{ readonly text: string; readonly chunks: number }> {
    const parts: string[] = [];
    let cursor = 1;
    let chunks = 0;
    while (cursor <= totalBytes) {
      const raw = await bridge.executeLuau(studioId, sliceBufferLuau(cursor, chunkBytes));
      const body = unwrapChunk(raw, `切片 @${cursor}`);
      const { endOffset, body: payload } = parseSliceHeader(body);
      if (endOffset < cursor) {
        throw new ExtractionError(
          `切片沒有前進（cursor=${cursor} endOffset=${endOffset}）——`
          + 'Lua 端的 buffer 可能已經不見了，中止以免無窮迴圈。',
        );
      }
      parts.push(payload);
      cursor = endOffset + 1;
      chunks += 1;
    }
    const text = parts.join('');
    const actual = Buffer.byteLength(text, 'utf8');
    if (actual !== totalBytes) {
      throw new ExtractionError(`資料流總長度不符 —— Lua 宣告 ${totalBytes} 位元組，組裝後 ${actual}。`);
    }
    return { text, chunks };
  }

  /**
   * 釋放 Lua VM 的 buffer。
   *
   * 🔴 **這裡刻意不關橋。** 第一版每個工具呼叫結束就 `close()`，而 close 會殺掉那隻
   * StudioMCP stub；緊接著下一次呼叫又生一隻去問 broker，broker 還在收拾上一隻，
   * 就回 `Unable to reach Roblox Studio right now`。症狀是「第一次成功、後續全失敗」。
   *
   * 橋的生命週期屬於整個 server（`closeBridge()` 在關機時呼叫），
   * 這樣既避開那個競爭，也少生一大堆 stub。
   */
  async #releaseBuffer(bridge: StudioBridge, studioId?: string): Promise<void> {
    try {
      if (studioId !== undefined) await bridge.executeLuau(studioId, releaseBufferLuau());
    } catch {
      // 釋放失敗不該蓋掉真正的錯誤。
    }
  }

  /** server 關機時收線。不收就會留下一隻 StudioMCP stub。 */
  async closeBridge(): Promise<void> {
    if (this.#bridge !== undefined) await this.#bridge.close();
  }

  /**
   * 寫入前的 placeId 守衛。
   *
   * 回報哪一個連線中的 Studio 是目標 place，讓後續呼叫拿著那個 `studio_id` 去用
   * 內建版的工具。對不上就直接失敗。
   */
  async guardPlace(placeId: string): Promise<{
    readonly studioId: string;
    readonly studioName: string;
    readonly placeId: string;
    readonly gameId: string;
  }> {
    // 不關橋：它的生命週期屬於整個 server，見 #releaseBuffer 的註解。
    const target = await this.#findStudioByPlaceId(this.#requireBridge(), placeId);
    return {
      studioId: target.id,
      studioName: target.name,
      placeId,
      gameId: target.gameId,
    };
  }

  /**
   * 在指定 place 執行 Luau，且不會被截斷、不會因為受保護屬性整段中止。
   *
   * ⚠️ 這不是新的任意執行入口 —— 內建版的 `execute_luau` 本來就在客戶端手上。
   * 這裡加的是三道內建版沒有的護欄：強制 placeId 守衛、整段 pcall、結果走 buffer 分塊。
   */
  async runLuau(options: {
    readonly placeId: string;
    readonly code: string;
    readonly chunkBytes?: number;
  }): Promise<{
    readonly studioName: string;
    readonly ok: boolean;
    readonly bytes: number;
    readonly chunks: number;
    readonly result: string;
  }> {
    const bridge = this.#requireBridge();
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    let studioId: string | undefined;
    try {
      const target = await this.#findStudioByPlaceId(bridge, options.placeId);
      studioId = target.id;

      const summaryRaw = await bridge.executeLuau(target.id, runUserLuau(options.code));
      const summary = unwrapChunk(summaryRaw, '執行 Luau');
      const bytes = Number.parseInt(/bytes=(\d+)/.exec(summary)?.[1] ?? '', 10);
      const ok = /ok=true/.test(summary);
      if (!Number.isFinite(bytes)) {
        throw new ExtractionError(`看不懂執行摘要：${JSON.stringify(summary.slice(0, 120))}`);
      }

      const { text, chunks } = await this.#drainBuffer(bridge, target.id, bytes, chunkBytes);
      const result = ok ? text : text.slice(LUAU_ERROR_PREFIX.length);
      return { studioName: target.name, ok, bytes, chunks, result };
    } finally {
      await this.#releaseBuffer(bridge, studioId);
    }
  }

  /**
   * 把一個 place 的腳本與 place 設定抽成可 diff 的文字快照。
   *
   * **全程唯讀**，不對 DataModel 做任何寫入。流程：
   * 驗 placeId → 一次算完整份資料流放進 Lua VM 的 `shared` → 分塊取回 → 逐檔以位元組數
   * 校驗 → 落檔 → 釋放 buffer。
   *
   * 🔴 任一塊少了哨兵就整批中止。局部正確的抽取比抽取失敗更危險 ——
   * 它看起來成功了，而缺的那一段要等到很久以後才會被發現。
   */
  async extractPlace(options: ExtractOptions): Promise<ExtractOutcome> {
    const bridge = this.#bridge;
    const writeFile = this.#writeFile;
    if (bridge === undefined || writeFile === undefined) {
      throw new RobloxServiceError('抽取功能未組裝（缺少 Studio 橋或寫檔器）。');
    }
    const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;

    let studioId: string | undefined;
    try {
      // ── 1. 定址並驗 placeId ────────────────────────────────────────
      const target = await this.#findStudioByPlaceId(bridge, options.placeId);
      studioId = target.id;
      const gameId = target.gameId;

      // ── 2. 一次算完，結果留在 Lua VM 記憶體 ──────────────────────────
      const summaryRaw = await bridge.executeLuau(target.id, buildScriptStreamLuau());
      const summary = unwrapChunk(summaryRaw, '建立腳本資料流');
      const totalBytes = Number.parseInt(/bytes=(\d+)/.exec(summary)?.[1] ?? '', 10);
      const scriptCount = Number.parseInt(/count=(\d+)/.exec(summary)?.[1] ?? '', 10);
      if (!Number.isFinite(totalBytes) || !Number.isFinite(scriptCount)) {
        throw new ExtractionError(`看不懂資料流摘要：${JSON.stringify(summary.slice(0, 120))}`);
      }

      // ── 3. 分塊取回 ────────────────────────────────────────────────
      const { text: stream, chunks } = await this.#drainBuffer(
        bridge,
        target.id,
        totalBytes,
        chunkBytes,
      );

      // ── 4. 逐檔校驗（parseScriptStream 內含位元組數比對）─────────────
      const files: readonly ExtractedFile[] = parseScriptStream(stream);

      // ── 5. 落檔 ────────────────────────────────────────────────────
      const written: string[] = [];
      const index: { path: string; className: string; file: string; bytes: number }[] = [];
      for (const file of files) {
        const dir = file.path.slice(0, file.path.lastIndexOf('/'));
        const relative = `src/${dir}/${fileNameFor(file.path, file.className)}`;
        written.push(await writeFile(options.outDir, relative, file.source));
        index.push({
          path: file.path,
          className: file.className,
          file: relative,
          bytes: file.declaredBytes,
        });
      }

      const metaRaw = await bridge.executeLuau(target.id, placeMetaLuau());
      const meta = unwrapChunk(metaRaw, 'place 設定');
      written.push(await writeFile(options.outDir, 'scene/place.json', `${meta}\n`));
      written.push(
        await writeFile(
          options.outDir,
          'scene/scripts.json',
          `${JSON.stringify({ extractedBy: 'roblox-mcp extract_place（唯讀）', scriptCount, totalBytes, scripts: index }, null, 2)}\n`,
        ),
      );

      return {
        placeId: options.placeId,
        gameId,
        studioName: target.name,
        scriptCount,
        totalBytes,
        chunks,
        written,
      };
    } finally {
      // buffer 是 Lua VM 的執行期記憶體，不清會一直佔著。
      await this.#releaseBuffer(bridge, studioId);
    }
  }

  status(): {
    readonly version: string;
    readonly studioExecutable: string | undefined;
    readonly openCloudConfigured: boolean;
    readonly allowedUploadRoots: readonly string[];
    readonly defaultCreatorConfigured: boolean;
  } {
    return {
      version: this.#version,
      studioExecutable: this.#studio.executablePath,
      openCloudConfigured: this.#openCloud.configured,
      allowedUploadRoots: this.#roots,
      defaultCreatorConfigured: this.#defaultCreator !== undefined,
    };
  }

  async listStudios(): Promise<StudioSnapshot> {
    return await this.#studio.snapshot();
  }

  /**
   * 開啟一個還沒開的 place，並等它註冊到 broker。
   *
   * ⚠ 全程不碰視窗焦點。實測 `SetForegroundWindow` 之後兩秒，一個游離按鍵落進 Studio
   * 就把剛載好的 place 關掉了（Studio 日誌：`[StudioKeyEvents] close IDE doc`）。
   * 狀態一律靠輪詢 broker 連線與行程標題判斷。
   */
  async openPlace(options: OpenPlaceOptions): Promise<OpenPlaceOutcome> {
    const request = { placeId: options.placeId, universeId: options.universeId };
    const args = buildStudioArgs(request);
    const executable = this.#studio.executablePath;
    const commandLine = describeWindowsCommandLine(executable ?? '<studio>', request);

    const pid = await this.#studio.launch(args);
    const waitMs = options.waitMs ?? 180_000;
    const started = this.#now();

    // 實測連上 broker 最快約 5 秒，但冷啟動＋下載大型 place 會久很多，
    // 而且觀察過一次整整 300 秒都沒註冊的情況（原因未明）。所以輪詢而不是固定等待。
    for (;;) {
      if (!(await this.#studio.isAlive(pid))) {
        return {
          pid,
          connected: false,
          waitedMs: this.#now() - started,
          windowTitle: undefined,
          commandLine,
        };
      }
      if (await this.#studio.isConnectedToBroker(pid)) {
        return {
          pid,
          connected: true,
          waitedMs: this.#now() - started,
          windowTitle: await this.#studio.windowTitle(pid),
          commandLine,
        };
      }
      if (this.#now() - started >= waitMs) {
        return {
          pid,
          connected: false,
          waitedMs: this.#now() - started,
          windowTitle: await this.#studio.windowTitle(pid),
          commandLine,
        };
      }
      await this.#sleep(5_000);
    }
  }

  /**
   * 清掉殘留的 StudioMCP stub。
   *
   * 🔴 broker 一律排除 —— 殺掉它會斷掉所有連線，包含 Studio 自己。
   * 辨識不出 broker 時整個放棄，寧可不動手也不要亂殺。
   *
   * 時數門檻的用意是不去碰可能還活著的 session：光看行程樹分不出來，
   * 因為 `codex.exe` / `claude.exe` 這些父行程一直活著，stub 在 PPID 意義上並不是孤兒。
   */
  async cleanupStubs(options: CleanupOptions = {}): Promise<CleanupOutcome> {
    const snapshot = await this.#studio.snapshot();
    const dryRun = options.apply !== true;

    if (snapshot.brokerPid === undefined) {
      throw new RobloxServiceError(
        `在 port ${snapshot.brokerPort} 上找不到 broker；為避免誤殺，不做任何清除。`,
      );
    }

    const cutoff = this.#now() - (options.olderThanHours ?? 12) * 3_600_000;
    const planned: readonly CleanupPlan[] = snapshot.mcpProcesses
      .filter((row) => row.role === 'stub')
      .filter((row) => {
        if (row.startedAt === undefined) return false;
        const started = Date.parse(row.startedAt);
        return Number.isFinite(started) && started < cutoff;
      })
      .map((row) => ({ pid: row.pid, startedAt: row.startedAt, client: row.client }));

    if (dryRun || planned.length === 0) {
      return {
        dryRun,
        brokerPid: snapshot.brokerPid,
        planned,
        terminated: [],
        failures: [],
      };
    }

    const pids = planned.map((row) => row.pid);
    const failures = await this.#studio.terminate(pids);
    const failed = new Set(failures.map((row) => row.pid));
    return {
      dryRun: false,
      brokerPid: snapshot.brokerPid,
      planned,
      terminated: pids.filter((pid) => !failed.has(pid)),
      failures,
    };
  }

  async getAsset(assetId: string): Promise<AssetRecord> {
    return await this.#openCloud.get(assetId);
  }

  /**
   * 上傳成為新資產。
   *
   * 🔴 上傳的 Model 在平台上無法刪除也無法封存（只能從自己的物品欄移除），
   * 所以請優先用 `roblox_update_asset` 更新既有 assetId，而不是每次都建立新的。
   */
  async uploadAsset(options: UploadOptions): Promise<AssetRecord> {
    const filePath = this.#resolveUploadPath(options.filePath);
    const assetType = options.assetType ?? inferAssetType(filePath);
    if (assetType === undefined) {
      throw new RobloxServiceError(
        `無法從副檔名推斷資產型別：${options.filePath}。請明確指定 assetType。`,
      );
    }
    const creatorUserId = options.creatorUserId ?? this.#defaultCreator;
    if (creatorUserId === undefined) {
      throw new RobloxServiceError(
        '缺少 creatorUserId，且未設定 ROBLOX_CREATOR_USER_ID。',
      );
    }
    return await this.#openCloud.create({
      assetType,
      filePath,
      displayName: options.displayName,
      description: options.description ?? '',
      creatorUserId,
    });
  }

  /**
   * 就地更新既有資產的內容，並判定更新是否**真的**生效。
   *
   * 這裡是本 server 最重要的一個防呆：內容位元組相同時 Open Cloud 會靜默去重 ——
   * HTTP 200、operation done、無錯誤，但 revisionId 不動。只看回應會誤判成功。
   */
  async updateAsset(options: UpdateOptions): Promise<{
    readonly asset: AssetRecord;
    readonly outcome: UpdateOutcome;
  }> {
    const filePath = this.#resolveUploadPath(options.filePath);
    const assetType = options.assetType ?? inferAssetType(filePath);
    if (assetType === undefined) {
      throw new RobloxServiceError(
        `無法從副檔名推斷資產型別：${options.filePath}。請明確指定 assetType。`,
      );
    }
    const before = await this.#openCloud.get(options.assetId);
    const asset = await this.#openCloud.updateContent({
      assetId: options.assetId,
      filePath,
      assetType,
    });
    return { asset, outcome: classifyUpdate(before.revisionId, asset.revisionId) };
  }

  async archiveAsset(assetId: string, restore = false): Promise<AssetRecord> {
    if (!restore) {
      const current = await this.#openCloud.get(assetId);
      // 先擋掉必定失敗的型別，錯誤訊息才說得清楚為什麼沒救。
      const type = current.assetType;
      if (type === 'Model' || type === 'Decal') assertArchivable(type);
    }
    return restore ? await this.#openCloud.restore(assetId) : await this.#openCloud.archive(assetId);
  }

  /**
   * 把來源路徑限制在允許的根目錄內。
   *
   * MCP Client 不該能指定任意檔案路徑 —— 上傳是把本機檔案送到外部服務，
   * 而且對 Model 來說是**不可逆**的。
   */
  #resolveUploadPath(filePath: string): string {
    const target = resolve(filePath);
    if (this.#roots.length === 0) {
      throw new RobloxServiceError(
        '未設定 ROBLOX_UPLOAD_ROOT，所有上傳一律拒絕。請先指定允許的來源目錄。',
      );
    }
    const allowed = this.#roots.some((root) => {
      const rel = relative(root, target);
      return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('..'));
    });
    if (!allowed) {
      throw new RobloxServiceError(
        `來源檔不在允許的目錄內：${target}\n允許的根目錄：${this.#roots.join(', ')}`,
      );
    }
    if (!existsSync(target)) {
      throw new RobloxServiceError(`來源檔不存在：${target}`);
    }
    return target;
  }
}
