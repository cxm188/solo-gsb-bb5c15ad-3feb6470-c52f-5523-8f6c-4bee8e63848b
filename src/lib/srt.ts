// SRT 解析与导出

export interface SrtCue {
  /** 原始文件中的序号（从 1 开始） */
  index: number
  startMs: number
  endMs: number
  /** 逐行保留的原始文本 */
  lines: string[]
}

export interface ParseResult {
  cues: SrtCue[]
  /** 解析过程中跳过的可疑块数量 */
  warnings: string[]
}

const TIME_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/

function toMs(h: string, m: string, s: string, ms: string): number {
  return (
    Number(h) * 3600000 +
    Number(m) * 60000 +
    Number(s) * 1000 +
    Number(ms.padEnd(3, '0'))
  )
}

/** 宽松解析 SRT：兼容 BOM、CRLF、逗号/点毫秒、时间行内附加设置 */
export function parseSrt(raw: string): ParseResult {
  const warnings: string[] = []
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 按空行切块
  const blocks = text.split(/\n[ \t]*\n/)
  const cues: SrtCue[] = []

  for (const block of blocks) {
    const rows = block.split('\n').map((r) => r.trimEnd()).filter((r) => r.trim() !== '')
    if (rows.length === 0) continue

    let timeRow = -1
    for (let i = 0; i < Math.min(rows.length, 3); i++) {
      if (TIME_RE.test(rows[i])) {
        timeRow = i
        break
      }
    }
    if (timeRow === -1) {
      warnings.push('跳过无法识别的块：' + block.slice(0, 40))
      continue
    }

    const m = rows[timeRow].match(TIME_RE)!
    const startMs = toMs(m[1], m[2], m[3], m[4])
    const endMs = toMs(m[5], m[6], m[7], m[8])
    const lines = rows.slice(timeRow + 1)
    if (lines.length === 0) {
      warnings.push(`第 ${cues.length + 1} 条字幕缺少文本，已跳过`)
      continue
    }
    cues.push({ index: cues.length + 1, startMs, endMs, lines })
  }

  return { cues, warnings }
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0')
}

export function msToSrtTime(ms: number): string {
  const v = Math.max(0, Math.round(ms))
  const h = Math.floor(v / 3600000)
  const m = Math.floor((v % 3600000) / 60000)
  const s = Math.floor((v % 60000) / 1000)
  const milli = v % 1000
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`
}

/** 生成 SRT 文本；序号统一重排 */
export function formatSrt(cues: Array<{ startMs: number; endMs: number; lines: string[] }>): string {
  return cues
    .map((c, i) => {
      return `${i + 1}\n${msToSrtTime(c.startMs)} --> ${msToSrtTime(c.endMs)}\n${c.lines.join('\n')}`
    })
    .join('\n\n') + '\n'
}
