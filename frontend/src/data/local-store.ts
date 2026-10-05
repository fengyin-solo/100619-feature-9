import { allEntries, commit, entriesOf, resetEntries } from './domain-store'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 阈值版本、幂等账本等注浆域数据见 domain-store.ts；本文件保留原有读写入口，
// 各页面与 local-service.ts 沿用 listRows/saveRows 的读法不变。

const STORAGE_KEY = 'shield-tunnel-construction:v2'

export function allRows(): Record<string, EntryRow[]> {
  return allEntries()
}

export function listRows(key: string): EntryRow[] {
  return entriesOf(key)
}

/** 普通模块直接整组保存；注浆/拌制请走 local-service 的事务动作，避免两边各算一遍。 */
export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft.entries[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  return resetEntries(key)
}

export function storageKey(): string {
  return STORAGE_KEY
}

export { SEED_ROWS }
