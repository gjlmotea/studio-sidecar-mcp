import { randomUUID } from 'node:crypto';

import { SENTINEL } from './extraction.js';

/**
 * 要送進 `execute_luau` 的 Luau 片段。
 *
 * 三條共通紀律：
 * - **全程唯讀**，不對 DataModel 做任何寫入。
 * - 結果放進 `shared.*`（Lua VM 的執行期記憶體，**不碰 DataModel、不進 .rbxl**），
 *   之後的切片呼叫就只剩兩行，不必每次重算。用完設回 `nil`。
 * - 🔴 **每次呼叫用自己的 buffer 名**（`newBufferKey()`），建立、切片、釋放都帶同一把。
 *   `shared` 是整個 Studio 共用的；固定一個名字時，兩個重疊的呼叫會讀到對方的內容，
 *   長度剛好一樣就照樣回報成功。
 * - **buffer 會到期**：釋放失敗或關機時跳過的 key 不會永遠留著，見 `BUFFER_IDLE_SECONDS`。
 * - 每一段回傳都以哨兵收尾，讓呼叫端能辨識截斷。
 */

/** buffer 名的格式：直接拼進 Luau 當 `shared.<key>`，所以只能是識別字。 */
const BUFFER_KEY = /^RBXEXTRACT_[0-9a-f]{32}$/;

/** 一次呼叫專用的 buffer 名。 */
export function newBufferKey(): string {
  return `RBXEXTRACT_${randomUUID().replaceAll('-', '')}`;
}

/** 存放結果的 Lua 全域。用完要清掉。 */
function bufferRef(key: string): string {
  if (!BUFFER_KEY.test(key)) {
    throw new Error(`Invalid buffer key: ${JSON.stringify(key)}`);
  }
  return `shared.${key}`;
}

/**
 * buffer 閒置多久之後可以被清掉（秒）。
 *
 * 釋放失敗、或關機途中為了不重開 StudioMCP 而跳過釋放時，那把 key 原本會一直留在 Studio 的 `shared` 裡。
 * 現在每個 buffer 建立時都在 `shared.RBXEXTRACT_EXPIRES` 登記到期時間，每次切片往後延；
 * 之後任何一次建立 buffer 的呼叫（不管是哪個 Sidecar 行程）都會先清掉已經到期的。
 * 一次切片的呼叫上限是 180 秒，所以進行中的抽取不會被當成閒置；萬一真的被清掉，
 * 下一次切片拿不到 buffer 會中止，不會靜默少一段。
 */
export const BUFFER_IDLE_SECONDS = 15 * 60;

/** 到期表。名字不符合 buffer key 的格式，不會跟任何一個 buffer 撞名。 */
const EXPIRES_REF = 'shared.RBXEXTRACT_EXPIRES';

/**
 * 清掉到期的 buffer，再登記這一個。整段包 pcall：清理出錯也不能擋住真正要做的事。
 * 只清名字符合 buffer key 格式的項目，到期表被別的程式塞了別的名字也不會誤刪 `shared` 裡其他東西。
 */
function registerBufferLuau(key: string): string {
  bufferRef(key);
  return `
pcall(function()
	local now = os.time()
	local expires = ${EXPIRES_REF}
	if type(expires) ~= "table" then
		expires = {}
		${EXPIRES_REF} = expires
	end
	for name, deadline in pairs(expires) do
		if type(name) == "string" and string.match(name, "^RBXEXTRACT_%x+$")
			and (type(deadline) ~= "number" or deadline < now) then
			shared[name] = nil
			expires[name] = nil
		end
	end
	expires["${key}"] = now + ${BUFFER_IDLE_SECONDS}
end)`;
}

/** 走訪這些 service 底下的腳本。與抽出後 `src/<Service>/…` 的目錄約定一致。 */
const SCRIPT_SERVICES = [
  'Workspace',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'ServerScriptService',
  'ServerStorage',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'SoundService',
  'Lighting',
  'TextChatService',
] as const;

/** 寫入前的 placeId 守衛。對不上就回報，不做任何事。 */
export function placeGuardLuau(expectedPlaceId: string): string {
  return `
local expected = ${expectedPlaceId}
local ok = game.PlaceId == expected
return string.format("placeId=%d expected=%d match=%s gameId=%d", game.PlaceId, expected,
	tostring(ok), game.GameId) .. "${SENTINEL}"`;
}

/**
 * 把所有腳本串成單一資料流放進 buffer。
 *
 * `#src` 在 Lua 數的是**位元組**，這正是呼叫端要拿來校驗的數字 ——
 * 用 JS 的 `String.length`（數字元）比會對不起來。
 */
export function buildScriptStreamLuau(key: string): string {
  const buffer = bufferRef(key);
  return `${registerBufferLuau(key)}
local out, count = {}, 0
local function walk(inst, path)
	for _, child in ipairs(inst:GetChildren()) do
		local childPath = path .. "/" .. child.Name
		if child:IsA("LuaSourceContainer") then
			-- 受保護的容器可能讀不到 Source，個別跳過而不是整批中止。
			local ok, src = pcall(function() return child.Source end)
			if ok and type(src) == "string" then
				count += 1
				out[#out + 1] = string.format("<<<RBXFILE|%s|%s|%d>>>", childPath, child.ClassName, #src)
				out[#out + 1] = src
			end
		end
		walk(child, childPath)
	end
end
for _, name in ipairs({${SCRIPT_SERVICES.map((s) => `"${s}"`).join(', ')}}) do
	local ok, service = pcall(function() return game:GetService(name) end)
	if ok and service then walk(service, name) end
end
${buffer} = table.concat(out, "\\n")
return string.format("bytes=%d count=%d", #${buffer}, count) .. "${SENTINEL}"`;
}

/**
 * 取出 buffer 的一段。
 *
 * 🔴 **切點的 UTF-8 安全由 Lua 這邊決定並回報**（`<<<AT|實際結束位置>>>`），
 * 呼叫端拿它當下一段的起點。若改成兩邊各自算，只要有一邊的邊界調整邏輯不同步，
 * 就會漏掉或重複位元組，而且長度校驗要到最後才爆。
 */
export function sliceBufferLuau(key: string, start: number, maxBytes: number): string {
  return `
local s = ${bufferRef(key)}
if type(s) ~= "string" then return "<<<AT|0>>>" .. "${SENTINEL}" end
local expires = ${EXPIRES_REF}
if type(expires) == "table" and expires["${key}"] ~= nil then expires["${key}"] = os.time() + ${BUFFER_IDLE_SECONDS} end
local start = ${start}
local finish = math.min(start + ${maxBytes} - 1, #s)
-- 續接位元組是 0x80–0xBF。若切點的下一個位元組是續接位元組，代表切在字元中間，
-- 往前退到字元邊界。
while finish > start and finish < #s do
	local nextByte = string.byte(s, finish + 1)
	if nextByte and nextByte >= 128 and nextByte <= 191 then
		finish = finish - 1
	else
		break
	end
end
return string.format("<<<AT|%d>>>", finish) .. string.sub(s, start, finish) .. "${SENTINEL}"`;
}

/** 用完把 buffer 還給 Lua VM，到期表裡的登記也一起拿掉。 */
export function releaseBufferLuau(key: string): string {
  return `
${bufferRef(key)} = nil
local expires = ${EXPIRES_REF}
if type(expires) == "table" then expires["${key}"] = nil end
return "released${SENTINEL}"`;
}

/**
 * 把使用者的 Luau 包起來執行，結果放進 buffer。
 *
 * 兩件內建版沒有替你做的事：
 * - **整段包 pcall** —— `execute_luau` 沒有 `RobloxScript` capability，碰到受保護屬性
 *   （例如 `Lighting.Technology`）會讓**整段中止**。包起來之後錯誤變成可讀的回傳值；
 *   但只有一個 pcall，錯誤之後的程式照樣不執行，之前做的修改也不會復原。
 * - **結果進 buffer 而不是直接回傳** —— 直接回傳超過 100,000 字元會被靜默截斷。
 *   放進 buffer 之後由呼叫端分塊取回，長度不再是限制。
 */
export function runUserLuau(key: string, code: string): string {
  const buffer = bufferRef(key);
  return `${registerBufferLuau(key)}
local ok, result = pcall(function()
${code}
end)
local text
if ok then
	text = type(result) == "string" and result or tostring(result)
else
	text = "!!LUAU_ERROR!! " .. tostring(result)
end
${buffer} = text
return string.format("ok=%s bytes=%d", tostring(ok), #text) .. "${SENTINEL}"`;
}

/** 使用者程式碼拋錯時，buffer 內容的前綴。 */
export const LUAU_ERROR_PREFIX = '!!LUAU_ERROR!! ';

/** 讀 place 層級設定，對應快照的 `scene/place.json`。 */
export function placeMetaLuau(): string {
  return `
local HttpService = game:GetService("HttpService")
local function safe(fn, fallback)
	local ok, value = pcall(fn)
	if ok then return value end
	return fallback
end
local ws, lighting = game:GetService("Workspace"), game:GetService("Lighting")
local meta = {
	placeName = game.Name,
	placeId = game.PlaceId,
	gameId = game.GameId,
	creatorId = safe(function() return game.CreatorId end, 0),
	creatorType = safe(function() return tostring(game.CreatorType) end, "Unknown"),
	workspace = {
		gravity = ws.Gravity,
		fallenPartsDestroyHeight = safe(function() return ws.FallenPartsDestroyHeight end, nil),
		streamingEnabled = safe(function() return ws.StreamingEnabled end, nil),
	},
	lighting = {
		brightness = lighting.Brightness,
		clockTime = lighting.ClockTime,
		fogEnd = lighting.FogEnd,
		globalShadows = lighting.GlobalShadows,
		-- Lighting.Technology 需要 RobloxScript capability，execute_luau 沒有 ——
		-- 不包 pcall 會讓整段中止。
		technology = safe(function() return tostring(lighting.Technology) end, nil),
	},
}
return HttpService:JSONEncode(meta) .. "${SENTINEL}"`;
}

/** 解析 `<<<AT|n>>>` 前綴，回傳實際結束位置與剩下的內容。 */
export function parseSliceHeader(text: string): { readonly endOffset: number; readonly body: string } {
  const match = /^<<<AT\|(\d+)>>>/.exec(text);
  if (!match) {
    throw new Error(`Slice reply is missing the <<<AT|n>>> prefix; got: ${JSON.stringify(text.slice(0, 60))}`);
  }
  const raw = match[1];
  return {
    endOffset: Number.parseInt(raw ?? '0', 10),
    body: text.slice(match[0].length),
  };
}
