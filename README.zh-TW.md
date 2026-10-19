# Studio Sidecar — Roblox Studio 的補完型 MCP server

[English](https://github.com/gjlmotea/studio-sidecar-mcp/blob/main/README.md) | **繁體中文**

![Studio Sidecar：Roblox Studio 的補完型 MCP server](https://github.com/gjlmotea/studio-sidecar-mcp/raw/main/assets/social-preview.png)

**Studio Sidecar 補上 Roblox Studio 內建 MCP server 做不到的部分，不是要取代它。**

Roblox Studio 從 2026 年起內建自己的 MCP server（`StudioMCP`，隨 Studio 安裝，走 stdio），獨立的 [`Roblox/studio-rust-mcp-server`](https://github.com/Roblox/studio-rust-mcp-server) repository 也已封存。內建 server 有一些第三方無法重做的工具：`generate_mesh`、`generate_material` 與 `generate_procedural_model` 使用 Roblox 的雲端 AI，並經過內容審核；`search_asset`、`insert_asset` 與 `upload_image` 帶著你登入後的物品欄權限；`user_keyboard_input` 與 `user_mouse_input` 走 `CreateVirtualInput`。取代它就等於把這些全部丟掉。

所以 Studio Sidecar 只補內建 server 結構上做不到的事，其餘一律交給它：

- **開啟還沒開的 place**，並看到這台機器上所有 Studio 行程與 StudioMCP 的 broker／stub。
- **依 PlaceId 守住寫入**、執行 Luau 時把執行期錯誤變成可讀的回傳值且輸出不被截斷，以及**突破 100k 輸出上限抽取腳本**，並逐位元組校驗。
- **透過 Roblox Open Cloud 上傳、更新與封存資產**；更新被靜默去重時會明確回報判定結果。

不需要 Studio 外掛。共 11 個工具；Windows 已完整驗證，macOS 部分驗證（見[平台支援](#平台支援)）。

## 目錄

- [工具](#工具)
- [快速開始](#快速開始)
- [設定](#設定)
- [內建 server 沒告訴你的事](#內建-server-沒告訴你的事)
- [平台支援](#平台支援)
- [邊界](#邊界)
- [開發](#開發)
- [授權與商標](#授權與商標)

## 工具

| 工具 | 內建 server 為什麼做不到 |
|---|---|
| `roblox_get_status` | 顯示 Open Cloud 是否已設定，以及上傳可以讀取哪些資料夾 |
| `roblox_list_studios` | 內建 server 活在某一個 Studio 行程裡，看不到其他 Studio 行程，也看不到 StudioMCP 的 broker／stub 結構 |
| `roblox_open_place` | 開啟還沒開的 place 是作業系統層級的事：需要另起一個同層級的行程 |
| `roblox_cleanup_stubs` | 理由同上；預設只回報，只有 `apply=true` 才終止 stub，而且絕不動 broker |
| `roblox_place_guard` | 內建的 `multi_edit` 依路徑寫入，`studio_id` 傳錯就會靜默覆蓋另一個遊戲，沒有復原也沒有警告 |
| `roblox_luau_safe` | 內建的 `execute_luau` 沒有 PlaceId 檢查，超過 100k 字元的輸出會被靜默截斷 |
| `roblox_extract_place` | 沒有工具處理 100k 截斷邊界：分塊、哨兵與逐檔位元組校驗都留給呼叫端，而做錯也不會報錯 |
| `roblox_get_asset` | 內建的 `search_asset` 回報的 `creatorId` 是持有者，不是作者 |
| `roblox_upload_asset` | Studio 裡的 `AssetService:CreateAssetAsync` 目前一律拋出 `not available yet` |
| `roblox_update_asset` | `CreateAssetVersionAsync` 同樣無法使用 |
| `roblox_archive_asset` | 內建 server 沒有任何 Open Cloud 功能 |

**刻意不包含**：腳本讀寫、場景查詢、`execute_luau`、`screen_capture`、playtest。內建 server 已經有這些，再做一份只會讓兩套實作漸漸不一致。

### Luau 怎麼在 Studio 端執行

一個 MCP 行程可以同時是 server 和 client。Studio Sidecar 把 `StudioMCP` 當成自己的子行程啟動，再以 MCP client 身分連上它，藉此取得內建的 `execute_luau`。分塊、哨兵與位元組校驗的機制則包成單一工具。client 正常關閉時，子行程也會跟著結束，所以這條路不會留下 stub。

啟動 `StudioMCP` 時，Studio Sidecar 用的是 Roblox 設定說明裡的同一支啟動器。Windows 是 `%LOCALAPPDATA%\Roblox\mcp.bat`，經 `cmd.exe /c` 執行；找不到 `mcp.bat` 時，退回 `%LOCALAPPDATA%\Roblox\Versions\` 底下修改時間最新的 `StudioMCP.exe`。macOS 則用 `/Applications` 或 `~/Applications` 裡 `RobloxStudio.app` 內的 `StudioMCP`。

## 快速開始

需求：Roblox Studio 已開啟 **Enable Studio as MCP server**（Studio 裡：Assistant → … → **Manage MCP Servers**），以及 Node.js 22 以上。

在 AI client 註冊 Studio Sidecar。Claude Code：

```bash
claude mcp add studio-sidecar --scope user \
  -e ROBLOX_API_KEY="<你的 Open Cloud API 金鑰>" \
  -e ROBLOX_CREATOR_USER_ID="<你的 Roblox user ID>" \
  -e ROBLOX_UPLOAD_ROOT="<允許上傳讀取的資料夾>" \
  -- npx -y @gjlmotea/studio-sidecar-mcp
```

讀 `mcpServers` JSON 設定的 client（Claude Desktop、Cursor、Gemini CLI）：

```json
{
  "mcpServers": {
    "studio-sidecar": {
      "command": "npx",
      "args": ["-y", "@gjlmotea/studio-sidecar-mcp"],
      "env": {
        "ROBLOX_API_KEY": "<你的 Open Cloud API 金鑰>",
        "ROBLOX_CREATOR_USER_ID": "<你的 Roblox user ID>",
        "ROBLOX_UPLOAD_ROOT": "<允許上傳讀取的資料夾>"
      }
    }
  }
}
```

VS Code 改用最上層的 `servers` 鍵，每個 server 都要寫 `type`。用 input 變數就不必把金鑰寫進檔案：VS Code 會在 server 第一次啟動時詢問，並安全地保存起來。

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "roblox-api-key",
      "description": "Roblox Open Cloud API key",
      "password": true
    }
  ],
  "servers": {
    "studio-sidecar": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gjlmotea/studio-sidecar-mcp"],
      "env": {
        "ROBLOX_API_KEY": "${input:roblox-api-key}",
        "ROBLOX_CREATOR_USER_ID": "<你的 Roblox user ID>",
        "ROBLOX_UPLOAD_ROOT": "<允許上傳讀取的資料夾>"
      }
    }
  }
}
```

各 client 的設定檔位置：

| Client | 設定檔 |
|---|---|
| Claude Desktop | macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`。**Settings → Developer → Edit Config** 會開啟它 |
| Cursor | 所有專案共用 `~/.cursor/mcp.json`，單一專案用專案內的 `.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json`（user）、`.gemini/settings.json`（project） |
| VS Code | 工作區的 `.vscode/mcp.json`，或用 **MCP: Open User Configuration** 指令開啟的使用者 `mcp.json` |

出處：[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Cursor](https://cursor.com/docs/context/mcp)、[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)、[VS Code](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)。

三個變數都可以省略：沒有金鑰時四個 Open Cloud 工具會拒絕，沒有 `ROBLOX_UPLOAD_ROOT` 時所有上傳一律拒絕，其他工具照常運作。**金鑰不要寫進任何受版本控制追蹤的設定檔。**

Studio 內建的 MCP server 也要註冊；腳本編輯、截圖與 playtest 都在那邊。各平台的啟動指令（macOS 是 `StudioMCP`，Windows 是 `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`）取自 Roblox 的[設定說明](https://create.roblox.com/docs/studio/mcp)。

macOS：

```bash
claude mcp add roblox-studio --scope user -- /Applications/RobloxStudio.app/Contents/MacOS/StudioMCP
```

Windows：

```bat
claude mcp add roblox-studio --scope user -- cmd.exe /c "%LOCALAPPDATA%\Roblox\mcp.bat"
```

JSON 設定裡，macOS 寫 `"command": "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP"`；Windows 寫 `"command": "cmd.exe"` 加上 `"args": ["/c", "%LOCALAPPDATA%\\Roblox\\mcp.bat"]`。Windows 上要註冊 `mcp.bat` 而不是 `StudioMCP.exe`：`mcp.bat` 的路徑固定，`StudioMCP.exe` 則放在 `%LOCALAPPDATA%\Roblox\Versions\version-<hash>\`，這個資料夾會隨 Studio 更新而換。

註冊後重開 session，再呼叫 `roblox_get_status`，確認 `openCloudConfigured` 與 `allowedUploadRoots`。

從 Finder 或開始選單啟動的桌面 app 常讀不到 shell 的 `PATH`；server 起不來時，改用 `npx` 的絕對路徑（從原始碼執行時則是 `node` 的絕對路徑）。

### 從原始碼執行

```bash
git clone https://github.com/gjlmotea/studio-sidecar-mcp.git
cd studio-sidecar-mcp
corepack pnpm install --frozen-lockfile
corepack pnpm run build
claude mcp add studio-sidecar --scope user -- "$(which node)" "$PWD/dist/index.js"
```

請像上面這樣用絕對路徑註冊，不要手寫一份指向專案資料夾的 `.mcp.json`。Claude Code 把 `CLAUDE_PROJECT_DIR` 設在 server 的環境裡，而不是它自己的環境，所以在 `.mcp.json` 項目、或 `~/.claude.json` 裡 local／user scope 項目的 `command` 或 `args` 引用 `${CLAUDE_PROJECT_DIR}` 時，必須帶預設值，例如 `${CLAUDE_PROJECT_DIR:-.}`。沒有預設值時，該項目照樣載入，`claude mcp list` 會顯示缺少變數的警告，並原樣使用未展開的 `${CLAUDE_PROJECT_DIR}` 字串。`.mcp.json` 的 project scope server 還需要核准：互動 session 會先詢問，`claude -p`、Agent SDK session 與雲端 session 則不詢問直接載入。見 [Claude Code 的 MCP 文件](https://code.claude.com/docs/en/mcp)。

## 設定

| 變數 | 用途 |
|---|---|
| `ROBLOX_API_KEY` | Open Cloud API 金鑰，需要 Asset 的**讀取與寫入**權限（Creator Dashboard → Open Cloud API Keys） |
| `ROBLOX_CREATOR_USER_ID` | 上傳時記錄在 `creationContext` 的建立者 |
| `ROBLOX_UPLOAD_ROOT` | **上傳可以讀取的資料夾**。可以有多個，以平台的路徑分隔符連接：Windows 用 `;`（`C:\assets\models;D:\decals`），macOS 用 `:`（`/Users/you/models:/Volumes/art/decals`）。**未設定時所有上傳一律拒絕** |
| `ROBLOX_STUDIO_PATH` | Studio 執行檔；未設定時自動從目前的安裝解析 |

`ROBLOX_UPLOAD_ROOT` 是刻意設下的護欄：上傳會把本機檔案送到外部服務，對 Model 來說還無法撤回，所以不讓 MCP client 任意指定檔案路徑。檔案與允許的資料夾都先用 `realpath` 解析再比對，所以允許資料夾裡的 symlink 不能把上傳導到別處。檔案只打開一次，透過這個打開的 handle 再確認一次（仍在允許的資料夾內、仍是同一個檔案），送出去的位元組也從這個 handle 讀，所以檢查之後才把路徑換掉不會有任何作用。硬連結超過一個的檔案一律拒絕：允許資料夾裡的硬連結可以就是同一個磁碟上任何地方的檔案；請改傳一份複本。

## 內建 server 沒告訴你的事

以下每一條都是在真機上發現的，而且都有回歸測試。

**啟動意圖的引號錯了不會有任何錯誤。** Studio 要的是 `-launchIntentString "{\"task\":\"EditPlace\",\"universeid\":\"…\",\"placeid\":\"…\"}"`。沒有跳脫的引號會被 Windows 命令列解析吃掉，Studio 收到壞掉的 JSON，就忽略整個 intent、開一個空白 session，而且不報錯。唯一的線索是視窗標題停在 `Roblox Studio`，而不是 `<place 名稱> - Roblox Studio`。Studio Sidecar 把引數以陣列交給 `spawn`，並讓 `CommandLineToArgvW` 的規則可以測試。`universeid` 就是 `scene/place.json` 裡的 `gameId`。

**絕不搶視窗焦點。** `SetForegroundWindow` 之後兩秒，一個落進 Studio 的游離按鍵就把剛載好的 place 關掉了。`roblox_open_place` 只輪詢 broker 連線與行程標題。

**broker 不能殺，而且它的身分會換。** StudioMCP 是一個 broker 加上每個 client 一隻 stub；最先啟動的那個監聽 `127.0.0.1:13469`，Studio 本身與每隻 stub 都連到它。殺掉 broker 會斷掉所有連線，包括 Studio 自己的。broker 的角色也會隨時間換到別的行程，所以一律用「誰在監聽 13469」來認 broker，從不靠記下來的 PID。`roblox_cleanup_stubs` 認不出 broker 時就放棄。stub 會累積，是因為有些 client 結束時不回收它們（見 [openai/codex#25893](https://github.com/openai/codex/issues/25893)）；存活時間門檻讓清理不去碰可能還活著的 session。

**更新成功與否看 `revisionId`，不看 HTTP 狀態。** 用位元組完全相同的內容 PATCH 資產，會回 `HTTP 200`、`done: true` 且沒有錯誤，但 `revisionId` 不動：內容被去重了。`roblox_update_asset` 比對更新前後的 `revisionId`，回報 `updated`、`deduplicated` 或 `indeterminate`。`revisionId` 增加也不保證 Studio 看得到新內容；Studio 端的快取不在 Open Cloud 能確認的範圍內。換內容時不要帶 `updateMask`（`updateMask=fileContent` 會失敗並回 `Unknown field file_content`），它只用於修改中繼資料。

**100k 截斷是 StudioMCP 自己的限制。** 直接對 StudioMCP 量測：100,000 字元的回覆完整送達；120,000 字元的回覆停在 100,015 字元，結尾是 `... (truncated)`。沒有任何 client 能解除這個限制。因此 `roblox_extract_place` 用三道防護，缺一不可：

1. 每塊結尾放一個哨兵；沒有哨兵的塊視為不完整。只看長度無法分辨完整的回覆和被截斷的回覆。
2. UTF-8 安全的切點由 Lua 決定並回報，呼叫端從那裡接著讀，兩邊從不各自計算邊界。
3. 逐檔校驗位元組數（用 `Buffer.byteLength`，不是 `String.length`）。任何一檔對不上就中止整次抽取，因為局部正確的快照看起來像成功。

每次呼叫把資料暫存在自己的 key 底下：`shared.RBXEXTRACT_<32 位十六進位>`（只在 Lua VM 記憶體裡，不進 DataModel 也不進 `.rbxl`），用完就清掉，所以重疊的呼叫不會讀到彼此的資料。清不掉時，下一次碰到同一個 Studio 的呼叫會再清一次，總共最多試三次。每把 key 也記著最後一次使用的時間，每建立一把新的 key 之前，會先清掉閒置超過 15 分鐘的 key，所以釋放失敗、關機或當掉時留下的 key，會在下一次呼叫那個 Studio 時消失。關機途中 server 絕不為了清理而重新連上 Studio。

實例名稱幾乎可以是任何字串，包括 `..`、路徑分隔符，以及 `CON`、`NUL` 這類 Windows 裝置名，所以每段路徑都會先清理。裝置名在每個平台上都會補一個 `_`（`CON` 變成 `CON_.server.luau`），在 macOS 抽出的快照搬到 Windows 也打得開；寫入前也會確認最終路徑落在輸出資料夾內。

整份新快照先寫進抽取在輸出資料夾裡新建的資料夾（`.studio-sidecar-staging-<隨機字串>`）。所有檔案都到齊之後才開始切換：上一次快照的檔案先移到一旁，新檔以硬連結放到正式位置，名字已被占用時硬連結會失敗（不支援硬連結的檔案系統改用獨佔建立）。切換途中任何一步失敗，就收掉新檔、把上一次的快照搬回原位，所以失敗的抽取會讓上一次的快照維持原樣。寫到同一個資料夾的抽取依序進行。中途被強制結束的抽取可能留下 `.studio-sidecar-staging-*` 資料夾，裡面只有快照檔，可以直接刪掉。

從不覆蓋任何東西。名字已經被占用時（包括檔案系統視為同名的名字，例如不分大小寫的磁碟上的 `Σ`、`ς` 與 `σ`），該腳本改用下一個 `~n` 後綴，`scene/scripts.json` 記下實際寫入的路徑。重跑到同一個資料夾時，只換掉該資料夾上一次 `scene/scripts.json` 列出的檔案；`scene/` 底下的檔案不是 Studio Sidecar 寫的資料夾會被拒絕。那些檔案之中若有被做成硬連結的，拿掉的只是這個名字，另一個名字底下的內容維持原樣。

**Studio 橋接必須和 server 活得一樣久。** 每次呼叫後就關閉它，會讓第一次呼叫成功、之後每次都失敗，錯誤訊息是 "Unable to reach Roblox Studio right now"，聽起來像 Studio 沒開。其實不是：關閉會殺掉 stub，下一次呼叫就和 broker 搶時間。冷啟動時，新的 stub 還沒連上 broker 之前也會出現同一句訊息，所以橋接只針對這一句訊息重試列出 Studio 的呼叫，最多 20 秒；每次重試前的等待比上一次多 250 毫秒，最長 1.5 秒。server 開始關機後，橋接拒絕任何新連線，所以那時還在收尾的呼叫不會再生出一隻新的 stub。

**Open Cloud 接受的格式很窄。** Model 只接受 `.fbx`；Decal 接受 bmp、jpeg、png 與 tga；Audio 接受 mp3 與 ogg，只能新建、不能更新，而且有每月配額。格式錯誤要等輪詢 operation 之後才會失敗，所以在本機先擋下。Model 與 Decal 從未支援封存，`roblox_archive_asset` 一開始就會說明。

## 平台支援

| | Windows | macOS |
|---|:---:|:---:|
| 開啟指定 place | ✅ 已驗證 | ✅ 已實作，**未在真機驗證** |
| 行程與 broker 查詢 | ✅ 已驗證（PowerShell） | ✅ 已驗證（`ps` + `lsof`） |
| stub 清理 | ✅ 已驗證 | ✅ 已實作，**未在真機驗證** |
| 視窗標題 | ✅ | ❌ 一律 `undefined`（需要輔助使用權限） |
| Open Cloud 工具 | ✅ | ✅（一般 HTTP） |

平台差異隔離在 `ports/process-inspector.ts` 後面；broker 判定、stub 分類與清理都共用。Linux 會明確拒絕，而不是回傳空的快照，因為 Roblox Studio 不能在 Linux 上執行，空的回答會被讀成「沒有 Studio 在跑」。

## 邊界

- **不改變視窗焦點。** 搶焦點可能讓一個游離按鍵關掉剛載好的 place。
- **`roblox_luau_safe` 不是執行任意程式碼的新途徑。** `execute_luau` 本來就在 client 手上；這個工具只是在同一個入口前加上強制的 PlaceId 守衛、包住整段程式的單一 `pcall` 與分塊結果。`pcall` 會接住執行期錯誤，把它變成可讀的回傳值；錯誤之後的程式不會執行，錯誤之前做的修改也不會復原。它不是沙箱。
- **不逆向 broker 在 13469 上的私有協定。** 以一般 MCP client 的身分和 `StudioMCP` 溝通，就沒有這個必要。
- **不提供「從物品欄移除」。** 那要透過 `inventory.roblox.com`，並帶登入後的 session cookie 與 CSRF token，Open Cloud API 金鑰做不到。
- **已知限制：輸出資料夾裡既有的資料夾可能在切換途中被換掉。** 檔案寫在新建的暫存資料夾裡，但放到正式位置時，仍是照路徑走輸出資料夾裡既有的子資料夾。每一層都先用 `realpath` 解析並確認落在輸出資料夾內；同一台機器上的其他程式仍可以在檢查與搬移之間把某個資料夾換成 symlink（time-of-check/time-of-use）。搬移只會建立新的名字，最壞的情況是輸出資料夾外多出一個新檔，外面的東西不會被覆蓋或刪除。
- **已知限制：沒釋放的 buffer 會留到下一次呼叫。** 釋放不掉的 Luau buffer 會留在 Studio 的 `shared` 表裡，直到之後有呼叫碰到同一個 Studio（閒置清理還要等它閒置滿 15 分鐘），或 Studio 關閉為止。

## 開發

```bash
corepack pnpm install
corepack pnpm run verify          # 型別檢查、測試、build、stdio smoke
corepack pnpm run verify:live     # 對真實的 Studio 與帳號做唯讀檢查
corepack pnpm run verify:extract  # 端到端：open_place → place_guard → luau_safe → extract_place
```

`verify:live` 只做唯讀操作：不上傳、不更新、不開 place、不終止行程。它的 Open Cloud 部分需要 `ROBLOX_API_KEY` 和一個資產 ID（`node scripts/verify-live.mjs <assetId>`），缺少時就跳過。

`verify:extract` 需要 `ROBLOX_VERIFY_PLACE_ID`、`ROBLOX_VERIFY_UNIVERSE_ID`（你自己擁有的 place）與 `ROBLOX_VERIFY_BASELINE`（一份手工製作、逐位元組校驗過的腳本快照）。它會開一個 Studio 實例，把抽出來的腳本逐位元組和快照比對。這些步驟刻意串成一條，因為橋接生命週期的 bug 只有在連續多次工具呼叫時才會出現。

## 授權與商標

[MIT](https://github.com/gjlmotea/studio-sidecar-mcp/blob/main/LICENSE)。

Studio Sidecar 是獨立的開源專案，與 Roblox Corporation 無隸屬關係，也未獲其背書。Roblox、Roblox Studio 與 Luau 是 Roblox Corporation 的商標。
