// 文本展平与智能断行工具（Unicode 码点感知，兼容中日韩文字）

/** 按码点拆分（正确处理代理对 / emoji） */
export function charsOf(s: string): string[] {
  return Array.from(s)
}

const CJK_RE =
  /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯\p{Extended_Pictographic}]/u

export function isCJK(ch: string): boolean {
  return CJK_RE.test(ch)
}

/**
 * 将多条字幕按原始顺序展平为一个字符串。
 * - 条内换行视为空格
 * - 相邻两条之间仅在“后一条以拉丁字母/数字开头、且前一字符不是空格或 CJK”时补一个空格，
 *   避免把被切开的英文单词重新连上，也避免在中文里硬塞空格。
 */
export function flattenCues(
  cueLines: string[][]
): { text: string; /** 每条原始字幕对应的切点（字符偏移），长度 = cues + 1 */ cuts: number[] } {
  const parts: string[] = []
  const cuts: number[] = [0]

  for (let i = 0; i < cueLines.length; i++) {
    if (i > 0) {
      const prev = parts.join('')
      const next = cueLines[i].map((l) => l.trim()).filter(Boolean).join(' ')
      const lastCh = charsOf(prev).pop() ?? ''
      const firstCh = charsOf(next.trimStart())[0] ?? ''
      if (
        lastCh &&
        lastCh !== ' ' &&
        !isCJK(lastCh) &&
        firstCh &&
        /[A-Za-z0-9]/.test(firstCh)
      ) {
        parts.push(' ')
      }
    }
    const flat = cueLines[i].map((l) => l.trim()).filter(Boolean).join(' ')
    parts.push(flat)
    cuts.push(charsOf(parts.join('')).length)
  }

  return { text: parts.join(''), cuts }
}

const LEADING_PUNCT_RE =
  /[，。！？、：；）」』！？，．・…—’”％‰℃、。々〆ー～]/

function isBreakable(ch: string): boolean {
  return ch === ' ' || isCJK(ch)
}

/**
 * 词感知折行：返回各行在【输入字符串 trim 后】中的码点切点 [start,end)。
 * 长度达到 maxChars 时：行末本身可断（CJK/空格）则满行断，否则回退到窗口内
 * 最近断点（为拉丁词保词）；不可断开的超长“词”则硬切。随后做行首标点修复。
 */
export function wrapOffsets(input: string, maxChars: number): Array<[number, number]> {
  const chars = charsOf(input.trim())
  const n = chars.length
  if (n === 0) return [[0, 0]]

  const cuts = [0]
  let start = 0
  while (start < n) {
    if (start + maxChars >= n) break
    let bp: number
    if (isBreakable(chars[start + maxChars - 1])) {
      bp = start + maxChars - 1
    } else {
      bp = -1
      for (let j = start + maxChars - 2; j >= start; j--) {
        if (isBreakable(chars[j])) {
          bp = j
          break
        }
      }
    }
    if (bp >= start) start = bp + 1
    else start += maxChars
    cuts.push(start)
  }
  cuts.push(n)

  // 初始行区间
  let ranges: Array<[number, number]> = []
  for (let i = 0; i < cuts.length - 1; i++) ranges.push([cuts[i], cuts[i + 1]])

  // 行首标点修复：把行首标点挪到上一行
  for (let i = 1; i < ranges.length; i++) {
    let [s, e] = ranges[i]
    while (s < e && LEADING_PUNCT_RE.test(chars[s])) {
      const [ps, pe] = ranges[i - 1]
      if (pe - ps < maxChars) {
        ranges[i - 1] = [ps, pe + 1]
        s++
      } else break
    }
    ranges[i] = [s, e]
  }

  // 去掉因 trim 产生的首尾空白与空行
  ranges = ranges
    .map(([s, e]) => {
      while (s < e && chars[s] === ' ') s++
      while (e > s && chars[e - 1] === ' ') e--
      return [s, e] as [number, number]
    })
    .filter(([s, e]) => e > s)
  return ranges.length ? ranges : [[0, 0]]
}

export function wrapText(input: string, maxChars: number): string[] {
  const chars = charsOf(input.trim())
  return wrapOffsets(input, maxChars).map(([s, e]) => chars.slice(s, e).join(''))
}
