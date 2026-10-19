import type { ScriptTarget } from '../domain/extraction.js';

/** 一份要寫進快照的腳本：名稱表排好的路徑與它的原始碼。 */
export type PlannedScript = {
  readonly target: ScriptTarget;
  readonly content: string;
};

/** 一次抽取要落地的全部內容。 */
export type SnapshotPlan = {
  readonly scripts: readonly PlannedScript[];
  /** `scene/place.json` 的內容。 */
  readonly place: string;
  /**
   * 產生 `scene/scripts.json`。參數是每份腳本實際落地的相對路徑，順序與 `scripts` 相同：
   * 名字要到切換時才確定（輸出目錄裡別人的檔會占走名字），所以清單最後才寫。
   */
  readonly manifest: (files: readonly string[]) => string;
};

export type CommittedSnapshot = {
  /** 每份腳本實際的相對路徑，順序與 `SnapshotPlan.scripts` 相同。 */
  readonly files: readonly string[];
  /** 寫入的絕對路徑：腳本與兩個 scene 檔。 */
  readonly written: readonly string[];
};

/**
 * 把一次抽取寫成輸出目錄裡的快照。
 *
 * 契約：
 * - 新快照全部寫完才動上一次的快照；寫到一半失敗時，上一次的快照原樣留著。
 * - 只換掉上一次抽取自己寫的檔（上一次的 `scene/scripts.json` 列出的那些），其餘一律不碰、不覆蓋；
 *   名字被別人的檔占走時改用名稱表的下一個名字。
 * - 同一個輸出目錄的寫入依序進行，不會交錯。
 */
export interface SnapshotStore {
  commit(outDir: string, plan: SnapshotPlan): Promise<CommittedSnapshot>;
}
