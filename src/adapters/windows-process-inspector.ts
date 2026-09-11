import type { ProcessInspector, RawProcess } from '../ports/process-inspector.js';
import { run } from './shell.js';

/** ConvertTo-Json 對單一元素的陣列會塌成物件，取回時要補回陣列。 */
export function asArray<T>(value: readonly T[] | T | null | undefined): readonly T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
}

type RawRow = {
  readonly Pid: number;
  readonly Ppid: number;
  readonly Started: string | null;
  readonly Name: string;
  readonly Path: string | null;
  readonly Title?: string | null;
};

export function toRawProcess(row: RawRow): RawProcess {
  const title = row.Title ?? undefined;
  return {
    pid: row.Pid,
    parentPid: row.Ppid,
    startedAt: row.Started ?? undefined,
    name: row.Name,
    executablePath: row.Path ?? undefined,
    windowTitle: title === '' ? undefined : title,
  };
}

/** PowerShell 一律以 UTF-8 輸出：視窗標題會有中文，走預設 ANSI 代碼頁會變亂碼。 */
const PRELUDE = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n";

async function ps(script: string, timeoutMs = 30_000): Promise<string> {
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PRELUDE + script],
    { timeoutMs },
  );
  return result.stdout;
}

/**
 * 一次取回全部行程，含視窗標題。
 *
 * 視窗標題只有 `Get-Process` 有、行程血緣只有 CIM 有，所以先把 `Get-Process` 的標題
 * 做成 pid → title 的雜湊表，再走一次 CIM 併起來 —— 全部在單一次 PowerShell 啟動內完成。
 */
const LIST_ALL = `
$titles = @{}
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  if ($p.MainWindowTitle) { $titles[[int]$p.Id] = $p.MainWindowTitle }
}
ConvertTo-Json -Depth 3 -Compress -InputObject @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{
      Pid     = [int]$_.ProcessId
      Ppid    = [int]$_.ParentProcessId
      Started = if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }
      Name    = $_.Name
      Path    = $_.ExecutablePath
      Title   = $titles[[int]$_.ProcessId]
    }
  })`;

export class WindowsProcessInspector implements ProcessInspector {
  readonly platform: NodeJS.Platform = 'win32';

  async listAll(): Promise<readonly RawProcess[]> {
    const raw = await ps(LIST_ALL, 60_000);
    const text = raw.trim();
    if (text === '' || text === 'null') return [];
    return asArray(JSON.parse(text) as RawRow[]).map(toRawProcess);
  }

  async listeningPid(port: number): Promise<number | undefined> {
    const raw = await ps(
      `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue |`
      + ` Select-Object -First 1; if ($c) { [int]$c.OwningProcess } else { '' }`,
      15_000,
    );
    const text = raw.trim();
    return text === '' ? undefined : Number.parseInt(text, 10);
  }

  async connectedPids(port: number): Promise<readonly number[]> {
    const raw = await ps(
      `@(Get-NetTCPConnection -ErrorAction SilentlyContinue |`
      + ` Where-Object { $_.RemotePort -eq ${port} } |`
      + ` Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
      15_000,
    );
    const text = raw.trim();
    if (text === '') return [];
    return text.split(',').map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
  }

  async isAlive(pid: number): Promise<boolean> {
    const raw = await ps(
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`,
      15_000,
    );
    return raw.trim() === 'yes';
  }

  async kill(pids: readonly number[]): Promise<readonly { pid: number; reason: string }[]> {
    if (pids.length === 0) return [];
    const raw = await ps(`
$failures = @()
foreach ($target in @(${pids.join(',')})) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$target" -ErrorAction SilentlyContinue
  $parentPid = if ($proc) { [int]$proc.ParentProcessId } else { 0 }
  try { Stop-Process -Id $target -Force -ErrorAction Stop }
  catch { $failures += [pscustomobject]@{ Pid = $target; Reason = $_.Exception.Message }; continue }
  # stub 死後，包住它的 cmd.exe 外殼若已無子行程就一併收掉。
  if ($parentPid -gt 0) {
    Start-Sleep -Milliseconds 150
    $wrapper = Get-CimInstance Win32_Process -Filter "ProcessId=$parentPid" -ErrorAction SilentlyContinue
    if ($wrapper -and $wrapper.Name -eq 'cmd.exe') {
      $kids = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" -ErrorAction SilentlyContinue)
      if ($kids.Count -eq 0) { Stop-Process -Id $parentPid -Force -ErrorAction SilentlyContinue }
    }
  }
}
ConvertTo-Json -InputObject @($failures) -Depth 3 -Compress`);
    const text = raw.trim();
    if (text === '' || text === '[]' || text === 'null') return [];
    return asArray(JSON.parse(text) as { Pid: number; Reason: string }[]).map((row) => ({
      pid: row.Pid,
      reason: row.Reason,
    }));
  }
}
