import type { EventEmitter } from 'node:events';

import { log as defaultLog } from './logger.js';

/** 關機時要收的資源。 */
export type CloseTarget = {
  readonly name: string;
  readonly close: () => Promise<void>;
};

export type ShutdownHost = {
  readonly stdin: EventEmitter & { readonly readableEnded?: boolean; readonly destroyed?: boolean };
  readonly stdout: EventEmitter;
  /** 收 SIGINT／SIGTERM 的對象，正式執行時是 `process`。 */
  readonly signals: EventEmitter;
  /** 預設把 `process.exitCode` 設成 1。 */
  readonly markFailed?: () => void;
  /** 預設 `process.exit`。 */
  readonly exit?: (code: number) => void;
  readonly forcedExitMs?: number;
  readonly log?: typeof defaultLog;
};

export type Lifecycle = {
  /**
   * 啟動完成時呼叫。啟動期間收到的關機要求這時才執行，
   * 回 false＝已經關機了，呼叫端不要再繼續。
   */
  readonly startupComplete: () => Promise<boolean>;
  readonly shutdown: (reason: string) => Promise<void>;
};

/**
 * 比 SDK 收子行程的整段流程長：關 stdin 後等 2 秒、SIGTERM 再等 2 秒，最後才 SIGKILL。
 * 比這短的話，強制結束會搶在 SIGKILL 之前，StudioMCP 就留下來了。
 */
const FORCED_EXIT_TIMEOUT_MS = 5_000;

/**
 * 把所有「Host 走了」的訊號接到同一條關機流程。
 *
 * 🔴 stdio server 最常見的結束方式是 Host 直接關掉 stdin，不是送 signal。
 * 第一版只聽 SIGINT／SIGTERM／EPIPE，stdin 結束時不走關機流程，
 * 連著的 StudioMCP 子行程就不會被收，留下一隻 stub。
 *
 * listener 在啟動前就掛上；啟動途中收到的要求先記著，等 `startupComplete()` 再收，
 * 免得關到一半又被啟動流程接回去。
 */
export function installShutdown(host: ShutdownHost, targets: readonly CloseTarget[]): Lifecycle {
  const write = host.log ?? defaultLog;
  const markProcessFailed = host.markFailed ?? ((): void => {
    process.exitCode = 1;
  });
  let failed = false;
  const markFailed = (): void => {
    failed = true;
    markProcessFailed();
  };
  const exit = host.exit ?? ((code: number): void => {
    process.exit(code);
  });
  const forcedExitMs = host.forcedExitMs ?? FORCED_EXIT_TIMEOUT_MS;

  let started = false;
  let requested: string | null = null;
  let running: Promise<void> | null = null;

  const onStdinEnd = (): void => {
    request('stdin-end');
  };
  const onStdinClose = (): void => {
    request('stdin-close');
  };
  const onStdinError = (error: NodeJS.ErrnoException): void => {
    markFailed();
    write('error', 'stdin error', { detail: error.message });
    request('stdin-error');
  };
  const onSigint = (): void => {
    request('SIGINT');
  };
  const onSigterm = (): void => {
    request('SIGTERM');
  };
  const onStdoutError = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') {
      markFailed();
      write('error', 'stdout error', { detail: error.message });
    }
    request(error.code === 'EPIPE' ? 'stdout-EPIPE' : 'stdout-error');
  };

  function removeHandlers(): void {
    host.stdin.off('end', onStdinEnd);
    host.stdin.off('close', onStdinClose);
    host.stdin.off('error', onStdinError);
    host.signals.off('SIGINT', onSigint);
    host.signals.off('SIGTERM', onSigterm);
    host.stdout.off('error', onStdoutError);
  }

  async function closeAll(reason: string): Promise<boolean> {
    write('info', 'shutting down', { reason });
    const results = await Promise.allSettled(targets.map(async (target) => await target.close()));
    let allClosed = true;
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      allClosed = false;
      markFailed();
      write('error', 'shutdown failure', {
        target: targets[i]?.name ?? 'unknown',
        detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
    removeHandlers();
    return allClosed;
  }

  function shutdown(reason: string): Promise<void> {
    if (running === null) {
      // 有資源收不掉（例如子行程卡住）時，時間到就整個結束，讓作業系統回收。
      const forced = setTimeout(() => {
        write('error', 'shutdown timeout; forcing process exit', { reason, timeoutMs: forcedExitMs });
        exit(failed ? 1 : 0);
      }, forcedExitMs);
      forced.unref();
      running = closeAll(reason).then((allClosed) => {
        if (allClosed) clearTimeout(forced);
      });
    }
    return running;
  }

  function request(reason: string): void {
    requested ??= reason;
    if (started) void shutdown(requested);
  }

  host.stdin.once('end', onStdinEnd);
  host.stdin.once('close', onStdinClose);
  host.stdin.on('error', onStdinError);
  host.signals.on('SIGINT', onSigint);
  host.signals.on('SIGTERM', onSigterm);
  host.stdout.on('error', onStdoutError);

  return {
    async startupComplete(): Promise<boolean> {
      started = true;
      if (requested === null && (host.stdin.readableEnded === true || host.stdin.destroyed === true)) {
        requested = 'stdin-already-closed';
      }
      if (requested === null) return true;
      await shutdown(requested);
      return false;
    },
    shutdown,
  };
}
