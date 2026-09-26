// 直連 StudioMCP 時，execute_luau 的回傳上限到底是多少？
//
// 先前的紀錄是「MCP 回傳硬上限 100,000 字元，超過靜默截斷」。但那是**透過
// Claude Code harness**觀察到的。本 server 是直連 client，限制可能不同 —— 這決定
// extract_place 要不要那整套分塊／哨兵機械，所以先量清楚。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SIZES = [50_000, 90_000, 100_000, 120_000, 200_000, 500_000, 1_000_000];
const SENTINEL = '<<<END>>>';

const transport = new StdioClientTransport({
	command: 'cmd.exe',
	args: ['/c', `${process.env.LOCALAPPDATA}\\Roblox\\mcp.bat`],
	stderr: 'pipe',
	env: getDefaultEnvironment(),
});
const client = new Client({ name: 'payload-limit-probe', version: '0.0.0' });
await client.connect(transport);

try {
	const studios = JSON.parse(
		(await client.callTool({ name: 'list_roblox_studios', arguments: {} })).content[0].text,
	).studios;
	const studioId = studios?.[0]?.id;
	if (!studioId) {
		console.log('沒有連線中的 Studio，無法探測。');
		process.exit(1);
	}
	console.log(`目標：${studios[0].name}\n`);
	console.log('要求長度   實收字元   收到哨兵   判定');
	console.log('--------   --------   --------   ----');

	for (const size of SIZES) {
		// 產生剛好 size 個字元的 payload，尾端接哨兵。哨兵在＝沒被截斷。
		const code = `local n = ${size - SENTINEL.length}\n`
			+ `return string.rep("x", n) .. "${SENTINEL}"`;
		let text;
		try {
			const res = await client.callTool({
				name: 'execute_luau',
				arguments: { studio_id: studioId, datamodel_type: 'Edit', code },
			});
			text = res.content?.[0]?.text ?? '';
		} catch (error) {
			console.log(`${String(size).padStart(8)}   ${'ERR'.padStart(8)}   ${'-'.padStart(8)}   ${error.message.slice(0, 40)}`);
			continue;
		}
		const hasSentinel = text.includes(SENTINEL);
		const verdict = hasSentinel ? '完整' : '🔴 被截斷';
		console.log(
			`${String(size).padStart(8)}   ${String(text.length).padStart(8)}   `
			+ `${(hasSentinel ? 'YES' : 'no').padStart(8)}   ${verdict}`,
		);
		if (!hasSentinel) {
			console.log(`\n           尾端 60 字元：${JSON.stringify(text.slice(-60))}`);
			break;
		}
	}
} finally {
	await client.close();
}
