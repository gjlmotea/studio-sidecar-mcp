import type { ProcessInspector, RawProcess } from '../ports/process-inspector.js';
import { run } from './shell.js';

/**
 * macOS 的行程與連線查詢：`ps` + `lsof`。
 *
 * 解析邏輯全部抽成純函式並有單元測試 —— 這台開發機是 Windows，
 * 本檔的整合路徑**沒有在真 macOS 上跑過**，所以至少要讓解析本身是被驗證的。
 */

/** `ps -axo pid=,ppid=,lstart=,comm=` 的一行。 */
export function parsePsLine(line: string): RawProcess | undefined {
  // lstart 是固定五欄的日期（`Fri Aug 30 02:48:00 2026`），comm 可能含空白，
  // 所以按位置切而不是無腦 split。
  const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/.exec(line);
  if (!match) return undefined;
  const [, pid, ppid, lstart, command] = match;
  if (pid === undefined || ppid === undefined || command === undefined) return undefined;

  // `lstart` 是本地時間且不帶時區（`Fri Aug 30 02:48:00 2026`），
  // 依執行機器的時區解讀再正規化成 ISO(UTC) —— 清理器的時數門檻是拿它相減的，
  // 只要前後一致就正確。
  let startedAt: string | undefined;
  if (lstart !== undefined) {
    const parsed = new Date(lstart);
    startedAt = Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }

  const executablePath = command.trim();
  const name = executablePath.slice(executablePath.lastIndexOf('/') + 1);

  return {
    pid: Number.parseInt(pid, 10),
    parentPid: Number.parseInt(ppid, 10),
    startedAt,
    name,
    executablePath: executablePath === '' ? undefined : executablePath,
    // macOS 讀不到別的 App 的視窗標題（需要 Accessibility 授權）。
    windowTitle: undefined,
  };
}

export function parsePsOutput(stdout: string): readonly RawProcess[] {
  return stdout
    .split(/\r?\n/)
    .map(parsePsLine)
    .filter((row): row is RawProcess => row !== undefined);
}

/**
 * `lsof -Fp` 的輸出：每筆記錄一行，pid 那行以 `p` 開頭。
 * 找不到符合的連線時 lsof 回結束碼 1 且無輸出，那是正常結果不是錯誤。
 */
export function parseLsofPids(stdout: string): readonly number[] {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('p')) continue;
    const value = Number.parseInt(line.slice(1), 10);
    if (Number.isFinite(value)) pids.add(value);
  }
  return [...pids];
}

export class DarwinProcessInspector implements ProcessInspector {
  readonly platform: NodeJS.Platform = 'darwin';

  async listAll(): Promise<readonly RawProcess[]> {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {
      allowFailure: true,
      timeoutMs: 60_000,
    });
    return parsePsOutput(stdout);
  }

  async listeningPid(port: number): Promise<number | undefined> {
    const { stdout } = await run(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    return parseLsofPids(stdout)[0];
  }

  async connectedPids(port: number): Promise<readonly number[]> {
    const { stdout } = await run(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fp'],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    return parseLsofPids(stdout);
  }

  async isAlive(pid: number): Promise<boolean> {
    const { code } = await run('ps', ['-p', String(pid)], { allowFailure: true, timeoutMs: 15_000 });
    return code === 0;
  }

  async kill(pids: readonly number[]): Promise<readonly { pid: number; reason: string }[]> {
    const failures: { pid: number; reason: string }[] = [];
    for (const pid of pids) {
      const { code, stderr } = await run('kill', ['-9', String(pid)], {
        allowFailure: true,
        timeoutMs: 15_000,
      });
      if (code !== 0) failures.push({ pid, reason: stderr.trim() || `kill 結束碼 ${code}` });
    }
    return failures;
  }
}
