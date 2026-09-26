# roblox — Roblox Studio companion MCP

**這是 Roblox Studio 內建 MCP 的補完層，不是替代品。**

Studio 從 2026 年起自帶 MCP server（`StudioMCP.exe`，隨 Studio 版本目錄安裝，走 stdio）。
官方的獨立 repo [`Roblox/studio-rust-mcp-server`](https://github.com/Roblox/studio-rust-mcp-server)
已於 2026-04-03 封存，公告說工程投資轉向內建版。

內建版有一整組**第三方在物理上做不到**的工具：`generate_mesh` / `generate_material` /
`generate_procedural_model` 走 Roblox 雲端 AI 服務並過內容審核；`search_asset` /
`insert_asset` / `upload_image` 帶著你已登入的 Inventory 權限；`user_keyboard_input` /
`user_mouse_input` 走 `CreateVirtualInput`。所以**做取代版等於自斷產線**。

本 server 只補三類「內建版結構上做不到、或完全沒有」的能力，其餘一律繼續用內建版。

## 工具面

| 工具 | 為什麼內建版做不到 |
|---|---|
| `roblox_get_status` | — |
| `roblox_list_studios` | 內建版活在**某一個** Studio 行程裡，看不到其他行程，也看不到 StudioMCP 的 broker/stub 結構 |
| `roblox_open_place` | **開啟還沒開的 place 是作業系統層級的事** —— 得生一個兄弟行程 |
| `roblox_cleanup_stubs` | 同上 |
| `roblox_place_guard` | 內建版**沒有任何防呆**：`multi_edit` 用路徑寫入，傳錯 `studio_id` 直接覆蓋另一個遊戲、沒有復原鍵、沒有警告 |
| `roblox_luau_safe` | 內建版的 `execute_luau` 會因受保護屬性**整段中止**，且超過 100k **靜默截斷** |
| `roblox_extract_place` | 內建版有 `execute_luau`，但**沒有把 100k 截斷邊界包起來的東西** —— 分塊、哨兵、逐檔位元組校驗全要呼叫端自己做，而做錯不會報錯 |
| `roblox_get_asset` | 內建版 `search_asset` 回的 `creatorId` 是**持有者**不是**作者** |
| `roblox_upload_asset` | Studio 內的 `AssetService:CreateAssetAsync` 目前一律拋 `not available yet` |
| `roblox_update_asset` | `CreateAssetVersionAsync` 同樣不可用 |
| `roblox_archive_asset` | 內建版沒有 Open Cloud 面 |

**刻意不做**：腳本讀寫、場景查詢、`execute_luau`、`screen_capture`、playtest。
那些內建版都有，重做只會製造兩套會漂移的實作。

### 怎麼在 Studio 端跑 Luau

> ⚠️ 本節 2026-08-30 更正過。原本寫「這需要在 Studio 端跑 Luau，而 MCP server 之間
> 不能互相呼叫，所以架構上做不到」—— **那是錯的**，而且會讓後人放棄一整條可行的路。
> `roblox_place_guard` / `roblox_luau_safe` / `roblox_extract_place` 都是沿這條路做出來的。

MCP 沒有任何規定禁止一個行程同時是 server 與 client。本 server 可以**把
`StudioMCP.exe` 當成自己的子行程並以 MCP client 身分連上去**，藉此取得
`execute_luau` 等內建工具，再把整套分塊／哨兵／位元組校驗的機械包成單一工具。

`scripts/probe-chaining.mjs` 是這條路的可行性證明（2026-08-30 實測）：

```
✅ 握手成功（438 ms）
✅ 取得工具面：27 個
✅ execute_luau（唯讀）→ placeId=0 name=Place1 workspaceChildren=4
✅ 子行程已回收（探測前後 StudioMCP 行程數不變）
```

**最後一行是這條路能不能用的關鍵**：只要 client 正常 `close()`，子行程會跟著收掉，
不會製造新的 stub 洩漏（stub 為什麼還是會累積、以及怎麼清，見下方
〈broker 不能殺，而且它的身分會遷移〉）。

## 設定

需要 Node.js 22 與 pnpm。先在本 repo 根目錄安裝並建置：

```bash
pnpm install
pnpm run build
```

再用 `claude mcp add -s local` 註冊（同樣在本 repo 根目錄執行）：

```bash
claude mcp add -s local roblox-companion \
  -e ROBLOX_API_KEY="<你的 Open Cloud 金鑰>" \
  -e ROBLOX_CREATOR_USER_ID="<你的 Roblox user ID>" \
  -e ROBLOX_UPLOAD_ROOT="<允許上傳的資料夾>" \
  -- "$(which node)" "$PWD/scripts/mcp-launch.mjs"
```

三個環境變數都可以省略：沒有金鑰時四個 Open Cloud 工具會拒絕，沒有 `ROBLOX_UPLOAD_ROOT`
時所有上傳一律拒絕，其餘工具照常可用。

Studio 內建的 MCP 要另外註冊 —— 腳本讀寫、截圖、playtest 都在那邊（本 server 的 Luau
相關工具也是在背後借用同一支 `StudioMCP`）。先在 Studio 的 **Assistant Settings** 打開
MCP server，再把執行檔註冊進來：

```bash
# macOS
claude mcp add -s local roblox-studio -- /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
```

Windows 的 `StudioMCP.exe` 住在 `%LOCALAPPDATA%\Roblox\Versions\version-<hash>\`，
**Studio 每次更新都會換目錄**，寫死路徑下次更新就會壞 —— 請用一個在啟動當下才解析路徑的小啟動器。

入口是 `scripts/mcp-launch.mjs` 而不是 `dist/index.js`：它在載入 server 前把金鑰讀進
`process.env`（外部已設好時以外部為準；讀不到就照常啟動，只有四個 Open Cloud 工具會拒絕）。
**金鑰不要寫進任何會被版本控制追蹤的設定檔。**

註冊後要**重開 session** 才會生效。接上之後先呼叫 `roblox_get_status` 確認
`openCloudConfigured` 與 `allowedUploadRoots` 是預期的值。

### 🔴 為什麼用 `claude mcp add -s local` 而不是 `.mcp.json`

兩個獨立的原因疊在一起：

1. **手寫的變數與裸指令容易是壞的。** `${CLAUDE_PROJECT_DIR}` 目前的 Claude Code 不會展開，
   `claude mcp list` 會報 `Missing environment variables: CLAUDE_PROJECT_DIR`；裸 `node`
   在有 nvm／conda shell 函式的環境可能靜默解析到錯的版本，所以上面用 `$(which node)`
   落成絕對路徑。
2. **project scope 要互動核准。** `.mcp.json` 會跟著 git 走、可能是別人塞的，所以 Claude
   Code 一定要使用者按過同意才載入，而那個提示**在非互動 session 永遠不會跳出來**。

修好第一點不會解決第二點。上面那幾行指令本身可攜，落地的設定則是這台機器上正確的絕對路徑。

驗連線一律用 `claude mcp list`，它會直接跑健康檢查，並且會報出同名 server 跨 scope 定義
不一致的衝突。

| 環境變數 | 用途 |
|---|---|
| `ROBLOX_API_KEY` | Open Cloud 金鑰，需要 Asset **read + write**（Creator Dashboard → Open Cloud API Keys） |
| `ROBLOX_CREATOR_USER_ID` | 上傳時填進 `creationContext` 的建立者 |
| `ROBLOX_UPLOAD_ROOT` | **允許上傳的來源目錄**（可多個，PATH 分隔符分隔）。**未設定時所有上傳一律拒絕** |
| `ROBLOX_STUDIO_PATH` | Studio 執行檔。省略時自動解析目前安裝版 |

`ROBLOX_UPLOAD_ROOT` 是刻意的護欄：上傳是把本機檔案送到外部服務，而且對 Model 來說
**不可逆**。不讓 MCP Client 指定任意檔案路徑。

## 這批工具編碼的實測知識

每一條都是 2026-08-30 在真機上踩出來的，並且有對應的回歸測試。

### 🔴 啟動意圖的引號，錯了完全無聲

Studio 吃的是這個形狀（取自官方啟動器的真實命令列）：

```
RobloxStudioBeta.exe -launchIntentString "{\"task\":\"EditPlace\",\"universeid\":\"…\",\"placeid\":\"…\"}"
```

裸 JSON 的 `"` 會被 Windows 命令列解析吃掉，Studio 收到壞掉的 JSON 之後**靜默忽略整個
intent**、開一個空白 session。沒有錯誤訊息，唯一線索是視窗標題停在 `Roblox Studio`
而不是 `<place 名> - Roblox Studio`。

本 server 把參數以**陣列**交給 `spawn`，由它處理平台引號規則；
`quoteWindowsArgument` 則把 `CommandLineToArgvW` 的規則變成可測的，並產生診斷用的
預期命令列。`universeid` 就是 `scene/place.json` 裡的 `gameId`。

### 🔴 不要搶視窗焦點

實測 `SetForegroundWindow` 之後兩秒，一個游離按鍵落進 Studio 就把剛載好的 place 關掉了
（Studio 日誌：`[StudioKeyEvents] close IDE doc` → `[PlaceManager] requestDocClose`）。
`roblox_open_place` 全程只輪詢 broker 連線與行程標題，不碰焦點。

### 🔴 broker 不能殺，而且它的身分會遷移

StudioMCP 是「一個 broker + 每個客戶端一隻 stub」：最先啟動的那隻在
`127.0.0.1:13469` 上 Listen，**Studio 本身與所有 stub 都連進它**。殺掉 broker 會斷掉
所有連線，包含 Studio 自己。

而且 broker 的身分**會換人**（實測從 pid 14936 換到 28804）。所以判定一律用
「誰在 13469 上 Listen」動態查，絕不記住 pid。`roblox_cleanup_stubs` 辨識不出 broker
時整個放棄，寧可不動手也不亂殺。

stub 會累積是因為客戶端結束時不一定回收：ChatGPT 桌面版的 `codex.exe` 尤其嚴重
（[openai/codex#25893](https://github.com/openai/codex/issues/25893)），實測累積到 20 隻、
其中 18 隻出自同一個 `codex.exe`。時數門檻是為了不去碰可能還活著的 session ——
光看行程樹分不出來，那些父行程一直活著，stub 在 PPID 意義上並不是孤兒。

### 🔴 更新的成功判準是 revisionId，不是 HTTP 狀態

用**位元組完全相同**的檔案 PATCH 同一個 assetId，Open Cloud 回 `HTTP 200`、
operation `done: true`、**沒有任何錯誤欄位**，但 `revisionId` 不動 —— 內容其實沒換。
這是正確的去重行為，但只看回應會誤判成功。

`roblox_update_asset` 自動比對更新前後的 `revisionId`，回報
`updated` / `deduplicated` / `indeterminate`。

⚠️ 反過來也要小心：**`revisionId` 遞增也不保證 Studio 端拿得到新內容**。
同日另一次實測，對一個源自 Tinkercad GLTF 匯入的舊資產 PATCH，`revisionId` 有進到 2 但
`insert_asset` 仍是舊網格。差異疑似在資產來源格式，尚未分出勝負。
本 server 只能保證「Open Cloud 那一端接受了新版本」，**保證不到 Studio 端的快取行為**。

另外：換內容**不要**帶 `updateMask`（`updateMask=fileContent` 會回
`INVALID_ARGUMENT — Unknown field file_content`）；只改中繼資料時才需要。

### 🔴 `execute_luau` 的 100k 截斷是 StudioMCP 的，換客戶端繞不過

`scripts/probe-payload-limit.mjs` 實測（直連 StudioMCP，不經任何 harness）：

| 要求長度 | 實收字元 | 收到哨兵 |
|---:|---:|:---:|
| 100,000 | 100,000 | ✅ |
| 120,000 | 100,015 | ❌ 尾端 `... (truncated)` |

先前的紀錄說這是「MCP 回傳上限」，但那是透過 Claude Code 觀察到的，來源不明。
現在確定**是 StudioMCP 自己的限制** —— 所以任何要搬大量內容出來的工具都必須自己分塊，
沒有換個客戶端就變大的可能。

`roblox_extract_place` 把整套機械包起來，三層缺一不可：

1. **哨兵**：每塊尾端放固定字串，沒有它就視為不完整。
   **不能只看長度** —— 剛好等於上限的回應可能完整、也可能被切，長度分不出來。
2. **切點的 UTF-8 安全由 Lua 決定並回報**（`<<<AT|實際結束位置>>>`），呼叫端拿它當下一段
   起點。若兩邊各自算邊界，只要邏輯有一點不同步就會漏或重複位元組。
3. **逐檔以位元組數校驗**（Lua 的 `#s` 數位元組、JS 的 `String.length` 數字元，
   一律用 `Buffer.byteLength` 比）。對不上就**整批中止** ——
   局部正確的快照比抽取失敗更危險，因為它看起來成功了。

另外：整份資料流一次算完後放進 `shared.RBXEXTRACT`（Lua VM 的執行期記憶體，
**不碰 DataModel、不進 .rbxl**），後續切片呼叫就只剩兩行，用完設回 `nil`。

⚠️ 抽出來的檔名來自 DataModel 路徑，而 **Roblox 的實例名稱幾乎沒有限制** ——
可以叫 `..`、可以含路徑分隔符。`sanitizeSegment` 會擋掉，並在寫入前再確認一次
最終路徑真的落在輸出目錄內。

### 🔴 Studio 橋不能每次呼叫就關

橋（本 server 對 `StudioMCP.exe` 的 MCP client）**必須活在整個 server 的生命週期**，
不能在每個工具呼叫的 `finally` 裡 `close()`。

第一版就是那樣寫的，症狀非常有誤導性：**第一次呼叫成功、後續全部失敗**，
錯誤訊息是 StudioMCP 回的

```
Unable to reach Roblox Studio right now.
Ask the user to confirm that Studio is running with the MCP server enabled…
```

—— 聽起來像 Studio 沒開或設定沒打開，其實兩者都正常。真正的原因是 `close()` 會殺掉
那隻 StudioMCP stub，而下一次呼叫立刻又生一隻去問 broker，broker 還在收拾上一隻，
就回報 reach 不到。

**這個 bug 在單元測試裡看不到、在單獨跑一次的腳本裡也看不到** ——
只有連續呼叫多個工具才會現形，所以 `scripts/verify-extract-live.mjs` 才刻意
一次串起 `place_guard` → `luau_safe` ×3 → `extract_place`。

橋改由 `closeBridge()` 在關機時收（`SIGINT` / `SIGTERM`），順帶少生一大堆 stub。

**同一句錯誤還有第二個成因：冷啟動競爭。** 剛生出來的 stub 與本行程的 MCP 握手會先完成，
但它連上 broker 要再花一點時間；那段空窗期問下去就拿到同一句話。所以橋對
**這一句、且只有這一句**做有界重試（預設上限 20 秒，指數退避），其餘錯誤立刻往上拋。

> 兩個成因共用同一句錯誤訊息，而那句話把人指向「Studio 沒開／設定沒打開」——
> 兩者都不是。這是這個專案裡最會誤導人的一條訊息。

### Open Cloud 的格式限制比想像窄

Model 只吃 `.fbx`；Decal 吃 bmp/jpeg/png/tga；Audio 吃 mp3/ogg（且**只能新建不能更新**，
另有每月配額）。錯誤格式要等輪詢 operation 才會知道，所以在本機先擋掉。

Model 與 Decal **從未支援封存**，`roblox_archive_asset` 會先擋下來而不是讓你對著必定
失敗的請求重試。

## 驗證

```bash
pnpm install
pnpm run verify          # typecheck + 123 tests + build + stdio smoke
pnpm run verify:live     # 對真機與真帳號跑唯讀驗證
pnpm run verify:extract  # 真機端到端：open_place → place_guard → luau_safe → extract_place
```

`verify:live` 刻意**只做唯讀操作**，不上傳、不更新、不開 place、不終止行程。
Open Cloud 那段需要 `ROBLOX_API_KEY` 和一個 assetId（`node scripts/verify-live.mjs <assetId>`），
缺一就跳過。

`verify:extract` 需要三個環境變數：`ROBLOX_VERIFY_PLACE_ID`、`ROBLOX_VERIFY_UNIVERSE_ID`
（目標 place，必須是你自己的）與 `ROBLOX_VERIFY_BASELINE`（一份人工抽出的腳本快照）。
它會開一個 Studio 實例，並把抽出來的腳本**逐位元組**比對那份快照 —— 快照要先手工分塊、
逐檔校驗做出來，拿它當基準才驗得出這套自動化有沒有漏東西。

### 端到端驗證（2026-08-30，真機）

會產生副作用的路徑各跑過一次，記錄在此，重跑要人為判斷代價：

| 路徑 | 結果 |
|---|---|
| `open_place`（作者的一個已發佈 place） | 開起來、約 5 秒註冊到 broker，內建 MCP 的 `list_roblox_studios` 出現 `<名稱> (placeId: <placeId>)`；用該 `studio_id` 跑 `execute_luau` 驗到 `placeId` 相符、2075 個 workspace 後代 |
| `upload_asset` | 自製 1754-byte 立方體 fbx → 新的 assetId、`moderationState: Approved`、`revisionId 1`；`insert_asset` 進 Studio 量到 100×100×100 studs（FBX 用公分，1 cm = 1 stud） |
| **上傳的 Model 天生是 Package** | 插進 Studio 後底下有 `PackageLink`、`PackageId = rbxassetid://<assetId>` |
| `update_asset`（內容不同） | 換成 3 倍大的幾何 → `revisionId 1 → 2`，重新 insert 量到 300×300×300，更新確實傳到 Studio（同一 session、立刻重插、未重啟未清快取） |
| `update_asset`（內容相同） | `HTTP 200`、`done: true`、無錯誤，但 `revisionId` 不動 → `verdict: deduplicated` |
| `cleanup_stubs` | 20 → 6 隻，broker 保留，Studio 與既有連線未受影響 |
| **`extract_place`**（同一個 place） | 11 份腳本、295,230 位元組、分 5 塊、**1 秒**；與事先人工抽取的快照**逐位元組一致（11/11）**。295 KB 遠超 100 K 上限，分塊機制確實被走過 |
| `place_guard` | 認出目標 place 並回傳 `studio_id`；假的 placeId 確實失敗 |
| `luau_safe`（唯讀查詢） | `parts=2075` |
| `luau_safe`（受保護屬性） | 不再讓整段中止，變成可讀的 `ok=false`＋`The current thread cannot read 'Technology' (lacking capability RobloxScript)` |
| `luau_safe`（150,000 字元） | 完整取回、分 3 塊 —— 同一段內容直接走內建版 `execute_luau` 會停在 100,000 |

上表由 `pnpm run verify:extract` 一次跑完（**刻意串成一條**，因為橋的生命週期 bug
只有連續呼叫多個工具才會現形）。

## 平台支援

| | Windows | macOS |
|---|:---:|:---:|
| 開啟指定 place | ✅ 實測 | ✅ 已實作，**未真機驗證** |
| 行程／broker 查詢 | ✅ 實測（PowerShell） | ✅ 2026-09-26 實測（`ps` + `lsof`） |
| stub 清理 | ✅ 實測 | ✅ 已實作，**未真機驗證** |
| 視窗標題 | ✅ | ❌ 一律 undefined，見下 |
| Open Cloud 全部工具 | ✅ | ✅（純 HTTP，與平台無關） |

平台差異隔離在 `ports/process-inspector.ts` 後面，broker 判定、stub 分類、清理策略
全部共用，不因平台分岔。解析層（`ps` / `lsof` 輸出）有單元測試涵蓋。

⚠️ **macOS 讀不到視窗標題** —— 需要 Accessibility 授權，為了診斷去要那個權限不成比例。
該平台一律回 `undefined`。這只影響 `roblox_open_place` 失敗時的線索豐富度，
判斷邏輯本身靠的是 broker 連線而不是標題。

⚠️ **原開發機是 Windows。** macOS 目前只有行程／broker 查詢在真機上跑過，上表標示未驗證的項目不要當成已驗證。

Linux 一律明確拒絕而不是回空快照 —— Roblox Studio 根本不存在於該平台，
回空會讓呼叫端誤以為「沒有 Studio 在跑」。

## 邊界

- **不碰視窗焦點。** 搶焦點會讓游離按鍵關掉剛載好的 place（實測）。
- **`roblox_luau_safe` 不是新的任意執行入口。**「拒絕任意執行入口」這條原則仍然成立 ——
  `execute_luau` 本來就在客戶端手上，本工具沒有擴大任何權限，只是在同一個入口前面
  加了三道護欄（強制 placeId 守衛、整段 pcall、結果分塊）。
  **它不是沙箱**：能做的事跟直接用內建版一樣多，差別只在不會靜默出錯。
- **不逆向 broker 在 13469 的未公開協定。** 這條仍然成立，而且現在有更好的理由：
  既然可以正大光明當 `StudioMCP.exe` 的 MCP client，就沒有必要去逆向它的內部通訊。
- 不提供「從物品欄刪除」：那走 `inventory.roblox.com` 且需要登入 session cookie 與
  CSRF token，不是 Open Cloud API Key 能做的事。

## 授權

[MIT](LICENSE)
