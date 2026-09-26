import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * extract_place 的真機端到端驗證。
 *
 * 驗收標準不是「跑得完」，而是**抽出來的腳本要跟一份人工抽取的快照
 * 逐位元組一致**。那份快照是先前手工分塊、逐檔校驗做出來的，
 * 拿它當基準才驗得出這套自動化有沒有漏東西。
 *
 * 用法：
 *   ROBLOX_VERIFY_PLACE_ID=<placeId> ROBLOX_VERIFY_UNIVERSE_ID=<universeId> \
 *   ROBLOX_VERIFY_BASELINE=<人工快照的 src 目錄> node scripts/verify-extract-live.mjs
 *
 * 目標必須是你自己的 place：流程會開一個 Studio 實例並在裡面跑 Luau（全程唯讀）。
 */

const TARGET = {
	placeId: process.env.ROBLOX_VERIFY_PLACE_ID?.trim() ?? '',
	universeId: process.env.ROBLOX_VERIFY_UNIVERSE_ID?.trim() ?? '',
};
const baselineArg = process.env.ROBLOX_VERIFY_BASELINE?.trim();
if (!/^[0-9]+$/.test(TARGET.placeId) || !/^[0-9]+$/.test(TARGET.universeId) || !baselineArg) {
	console.error('需要 ROBLOX_VERIFY_PLACE_ID、ROBLOX_VERIFY_UNIVERSE_ID（十進位數字）與 ROBLOX_VERIFY_BASELINE。');
	process.exit(2);
}
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const baseline = resolve(baselineArg);

const transport = new StdioClientTransport({
	command: process.execPath,
	args: ['dist/index.js'],
	cwd: projectRoot,
	stderr: 'pipe',
	env: getDefaultEnvironment(),
});
// server 的 stderr 是診斷的唯一來源，一定要印出來。
transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
const client = new Client({ name: 'extract-live', version: '0.0.0' });
await client.connect(transport);

const workDir = await mkdtemp(join(tmpdir(), 'rbx-extract-'));
let failures = 0;
const check = (label, condition, detail = '') => {
	if (condition) console.log(`  ✓ ${label}`);
	else { failures += 1; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`); }
};

async function walk(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full, base)));
		else out.push(relative(base, full).replace(/\\/g, '/'));
	}
	return out;
}

try {
	console.log('1. 確認目標 place 是否已連線');
	// content[0].text 是給人看的摘要，結構化資料在 structuredContent。
	const listed = (await client.callTool({ name: 'roblox_list_studios', arguments: {} }))
		.structuredContent;
	// 以 placeId 判定目標是否已開：macOS 讀不到視窗標題，不能靠名稱比對。
	const probe = await client.callTool({ name: 'roblox_place_guard', arguments: { placeId: TARGET.placeId } });
	const alreadyOpen = !probe.isError;
	console.log(`   目前 Studio ${listed.studios.length} 個，目標 place ${alreadyOpen ? '已開' : '未開'}`);

	if (!alreadyOpen) {
		console.log('\n2. 開啟目標 place（roblox_open_place）');
		const opened = await client.callTool({
			name: 'roblox_open_place',
			arguments: { ...TARGET, waitMs: 240_000 },
		});
		if (opened.isError) throw new Error(`open_place 失敗：${opened.content[0].text}`);
		const o = opened.structuredContent;
		console.log(`   pid ${o.pid}｜connected=${o.connected}｜等待 ${Math.round(o.waitedMs / 1000)}s`);
		check('已註冊到 broker', o.connected === true, o.windowTitle ?? '');
		if (!o.connected) throw new Error('沒有註冊到 broker，無法繼續。');
	} else {
		console.log('\n2. 略過開啟（已在線）');
	}

	console.log('\n2b. placeId 守衛（roblox_place_guard）');
	const guard = await client.callTool({
		name: 'roblox_place_guard',
		arguments: { placeId: TARGET.placeId },
	});
	check('認出目標 place', guard.isError !== true, guard.content?.[0]?.text);
	if (guard.isError !== true) {
		console.log(`   ${guard.structuredContent.studioName} → studio_id ${guard.structuredContent.studioId}`);
	}
	const wrongGuard = await client.callTool({
		name: 'roblox_place_guard',
		arguments: { placeId: '999999999999' },
	});
	check('🔴 假的 placeId 一定要失敗', wrongGuard.isError === true);

	console.log('\n2c. 安全執行 Luau（roblox_luau_safe）');
	const readOnly = await client.callTool({
		name: 'roblox_luau_safe',
		arguments: {
			placeId: TARGET.placeId,
			code: 'return string.format("parts=%d", #game:GetService("Workspace"):GetDescendants())',
		},
	});
	check('唯讀查詢可用', readOnly.isError !== true && readOnly.structuredContent?.ok === true,
		readOnly.content?.[0]?.text);
	if (readOnly.structuredContent?.ok) console.log(`   ${readOnly.structuredContent.result}`);

	// 受保護屬性：內建版會讓整段中止，包 pcall 之後應該變成可讀的錯誤而不是呼叫失敗。
	const protectedProp = await client.callTool({
		name: 'roblox_luau_safe',
		arguments: { placeId: TARGET.placeId, code: 'return tostring(game:GetService("Lighting").Technology)' },
	});
	check('受保護屬性不會讓整段中止',
		protectedProp.isError !== true,
		protectedProp.content?.[0]?.text);
	if (protectedProp.isError !== true) {
		const s = protectedProp.structuredContent;
		console.log(`   ok=${s.ok}｜${String(s.result).slice(0, 90)}`);
	}

	// 🔴 關鍵案例：超過 100000 字元。內建版會靜默截斷，這裡應該完整取回。
	const BIG = 150_000;
	const big = await client.callTool({
		name: 'roblox_luau_safe',
		arguments: { placeId: TARGET.placeId, code: `return string.rep("A", ${BIG})` },
	});
	check(`🔴 ${BIG} 字元完整取回（內建版會截在 100000）`,
		big.isError !== true && big.structuredContent?.result?.length === BIG,
		`實得 ${big.structuredContent?.result?.length ?? 'ERR'}`);
	if (big.structuredContent) {
		console.log(`   ${big.structuredContent.bytes} 位元組｜${big.structuredContent.chunks} 塊`);
	}

	console.log('\n3. 抽取（roblox_extract_place）');
	const started = Date.now();
	const res = await client.callTool({
		name: 'roblox_extract_place',
		arguments: { placeId: TARGET.placeId, outDir: workDir },
	});
	if (res.isError) throw new Error(`extract_place 失敗：${res.content[0].text}`);
	const r = res.structuredContent;
	console.log(`   ${r.scriptCount} 份腳本｜${r.totalBytes} 位元組｜${r.chunks} 塊｜`
		+ `${Math.round((Date.now() - started) / 1000)}s`);
	check('placeId 相符', r.placeId === TARGET.placeId);
	check('有抽到腳本', r.scriptCount > 0);
	check('分塊數合理', r.chunks >= 1 && r.chunks === Math.max(1, Math.ceil(r.totalBytes / 70000)),
		`chunks=${r.chunks} totalBytes=${r.totalBytes}`);

	console.log('\n4. 與人工快照逐位元組比對');
	let baseFiles;
	try {
		baseFiles = await walk(baseline);
	} catch {
		console.log('   ⚠ 找不到基準快照，略過比對');
		baseFiles = undefined;
	}

	if (baseFiles) {
		const mineAll = await walk(join(workDir, 'src'));
		// 基準快照的路徑不含服務層前綴以外的差異，這裡只比對檔名集合與內容。
		const byName = (list) => new Map(list.map((p) => [p.slice(p.lastIndexOf('/') + 1), p]));
		const baseByName = byName(baseFiles);
		const mineByName = byName(mineAll);

		console.log(`   基準 ${baseFiles.length} 檔｜抽出 ${mineAll.length} 檔`);
		const missing = [...baseByName.keys()].filter((n) => !mineByName.has(n));
		check('沒有漏掉基準裡的檔案', missing.length === 0, missing.join(', '));

		let identical = 0;
		const differing = [];
		for (const [name, basePath] of baseByName) {
			const minePath = mineByName.get(name);
			if (!minePath) continue;
			const a = await readFile(join(baseline, basePath));
			const b = await readFile(join(workDir, 'src', minePath));
			if (a.equals(b)) identical += 1;
			else differing.push(`${name}（基準 ${a.length}B vs 抽出 ${b.length}B）`);
		}
		check(`內容逐位元組一致（${identical}/${baseByName.size}）`, differing.length === 0,
			differing.slice(0, 5).join('\n      '));
	}

	console.log(`\n${failures === 0 ? '真機驗證通過。' : `有 ${failures} 項未通過。`}`);
} finally {
	await client.close();
	await rm(workDir, { recursive: true, force: true });
}

process.exitCode = failures === 0 ? 0 : 1;
