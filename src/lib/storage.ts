// 浏览器本地持久化（localStorage）。所有数据仅存于本机浏览器。

export const STORAGE_KEYS = {
  source: 'srtfix.source.v1',
  selection: 'srtfix.selection.v1',
  settings: 'srtfix.settings.v1',
  locks: 'srtfix.locks.v1',
} as const

export function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 容量超限或隐私模式下静默失败，不影响使用
  }
}

export function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function clearAll(): void {
  Object.values(STORAGE_KEYS).forEach((k) => localStorage.removeItem(k))
}
