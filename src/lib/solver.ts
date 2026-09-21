// 字幕节奏修复核心求解器
//
// 问题：保持文字内容与顺序不变、选区首条开始时间与末条结束时间不变，
//       联合调整 (a) 文字断句切点 (b) 各条毫秒边界，
//       使全部约束满足且“边界总移动量”最小。
//
// 锚点锁定：可对每条字幕分别锁定【文字归属 / 开始时间 / 结束时间】。
//   - 锁定文字归属 ⇒ 该条左右两个切点固定在其原始位置（DP/搜索只动自由切点）；
//   - 锁定开始/结束 ⇒ 该时间边界在 L1 保序回归中以极大权重钉死（与首末边界相同）；
//   - 求解前对相邻钉死点做区间可行性预检，直接报告冲突锚点与最小所需时长/间隔。
//
// 约束（每条字幕）：
//   - 折行行数 ≤ MAX_LINES（标准字幕两行），每行 ≤ maxChars（词感知折行）
//   - 时长 ≥ ceil(1000 * 字数 / cps)                     （每秒字符数下限）
//   - 相邻两条间隔 ≥ gapMs（前一条结束 + gap ≤ 后一条开始）
//
// 算法：
//   1. 给定断句，时间边界优化是带“非减序”约束的 L1 回归（L1 保序回归），
//      用 PAVA（Pool Adjacent Violators）+ 加权中位数求【精确全局最优】，
//      目标 Σ|新边界 − 原边界|。
//   2. 给定时间，断句优化是分层有向无环图上的 DP，词典序最小化
//      (时长缺口, 文字移动量)，对该时间方案取【精确最优】。
//   3. 联合优化为非凸问题：以三组结构化切点 + 上百组随机切点为起点交替迭代到
//      不动点，再对最佳方案做单切点平移的邻域搜索，取其中移动量最小的方案。
//      给定断句的时间解、给定时长的断句解均为各自子问题的精确最优。
//
// PAVA 的数学变换：
//   节点链 b_0, e_0, b_1, e_1, ..., b_{n-1}, e_{n-1}。
//   累加偏移 S：S(e_i)=S(b_i)−D_i，S(b_i)=S(e_{i-1})−gap，
//   令 z = t + S，所有约束等价于 z 非减，锚点目标为 z = 原时间 + S，
//   于是成为标准 L1 保序回归；两端用极大权重钉死。

import { SrtCue } from './srt'
import { charsOf, flattenCues, wrapOffsets, wrapText } from './text'

export const MAX_LINES = 2
export const MAX_SELECTION = 30
const PIN_WEIGHT = 1e12
const MAX_ROUNDS = 25

export interface Settings {
  /** 每秒字符数（时长 ≥ 1000*字数/cps） */
  cps: number
  /** 单行字数上限 */
  maxChars: number
  /** 相邻字幕最小提示间隔（毫秒） */
  gapMs: number
}

/** 单条字幕的锚点锁定（与选区内字幕按下标一一对应） */
export interface CueLock {
  /** 锁定文字归属：该条文字（及其左右切点）保持原样 */
  text?: boolean
  /** 锁定开始时间 */
  start?: boolean
  /** 锁定结束时间 */
  end?: boolean
}

export interface Conflict {
  rule: string
  message: string
}

export interface SolvedCue {
  startMs: number
  endMs: number
  lines: string[]
  /** 各行在 text（trim 后）中的码点偏移区间 */
  lineOffsets: Array<[number, number]>
  text: string
  dStart: number
  dEnd: number
  cpsActual: number
}

export interface SolveMetrics {
  /** 内部毫秒边界移动绝对值之和 */
  timeMoveMs: number
  /** 文字移动量：每个非空字符 |新属条号 − 原属条号| 之和 */
  charMove: number
  movedCharCount: number
}

export interface SolveOk {
  ok: true
  text: string
  cues: SolvedCue[]
  /** 原始切点 / 新切点（码点偏移，长度 n+1） */
  origCuts: number[]
  newCuts: number[]
  /** 每个码点的原始/新归属条号；无归属为 −1 */
  origOwner: Int32Array
  newOwner: Int32Array
  insertedSpace: Uint8Array
  metrics: SolveMetrics
  rounds: number
}

export interface SolveFail {
  ok: false
  conflicts: Conflict[]
}

export type SolveResult = SolveOk | SolveFail

// ---------------------------------------------------------------------------
// L1 保序回归（PAVA + 加权中位数）
// ---------------------------------------------------------------------------

interface Anchor {
  value: number
  weight: number
}

interface SegBlock {
  /** 合并后的锚点列表（惰性排序，仅在求中位数时整理） */
  raw: { v: number; w: number }[]
  sorted: { v: number; w: number }[] | null
  weight: number
  lo: number
  hi: number
}

function blockMedian(b: SegBlock): number {
  if (!b.sorted) {
    b.sorted = b.raw.slice().sort((a, c) => a.v - c.v)
    // 合并相邻同值
    const m = b.sorted
    let w = 0
    for (let i = 0; i < m.length; i++) {
      w += m[i].w
      if (i + 1 < m.length && m[i + 1].v === m[i].v) {
        m[i].w += m[i + 1].w
        m.splice(i + 1, 1)
        i--
      }
    }
    b.weight = w
  }
  // 下中位数：首个累计权重 *2 ≥ 总权重 的取值
  let acc = 0
  for (const it of b.sorted) {
    acc += it.w
    if (acc * 2 >= b.weight - 1e-9) return it.v
  }
  return b.sorted[b.sorted.length - 1].v
}

/** L1 保序回归：输入按位置排列的锚点，输出每个位置的拟合值 */
function isotonicL1(anchors: Anchor[]): number[] {
  const blocks: SegBlock[] = []
  for (let p = 0; p < anchors.length; p++) {
    blocks.push({
      raw: [{ v: anchors[p].value, w: anchors[p].weight }],
      sorted: anchors[p].weight >= 1 ? [{ v: anchors[p].value, w: anchors[p].weight }] : null,
      weight: anchors[p].weight,
      lo: p,
      hi: p,
    })
    while (blocks.length >= 2) {
      const r = blocks[blocks.length - 1]
      const l = blocks[blocks.length - 2]
      if (blockMedian(l) <= blockMedian(r)) break
      // 合并（惰性：仅拼接 raw，O(1)）
      const merged: SegBlock = {
        raw: l.raw.length >= r.raw.length ? l.raw.concat(r.raw) : r.raw.concat(l.raw),
        sorted: null,
        weight: l.weight + r.weight,
        lo: l.lo,
        hi: r.hi,
      }
      blocks.splice(blocks.length - 2, 2, merged)
    }
  }
  const out = new Array<number>(anchors.length)
  for (const b of blocks) {
    const med = blockMedian(b)
    for (let p = b.lo; p <= b.hi; p++) out[p] = med
  }
  return out
}

// ---------------------------------------------------------------------------
// 时间优化：给定切点（由此得每条字数），求最优毫秒边界
// ---------------------------------------------------------------------------

interface TimingSolution {
  starts: number[]
  ends: number[]
  /** 内部边界移动绝对值之和 */
  moveMs: number
}

function optimizeTimingImpl(
  cues: SrtCue[],
  cuts: number[],
  settings: Settings,
  locks?: Array<CueLock | undefined>
): TimingSolution | null {
  const n = cues.length
  const { cps, gapMs } = settings
  const lengths: number[] = []
  for (let i = 0; i < n; i++) lengths.push(cuts[i + 1] - cuts[i])
  const D = lengths.map((len) => Math.ceil((1000 * len) / cps))

  // 节点链：b_0, e_0, b_1, e_1, ..., b_{n-1}, e_{n-1}（共 2n 个）
  //   b_i → e_i 长度 ≥ D_i；e_i → b_{i+1} 长度 ≥ gap。
  const P = 2 * n
  const anchors: Anchor[] = new Array(P)
  const S = new Int32Array(P)

  // 钉死点：首条开始 / 末条结束（恒定）+ 用户锁定的时间锚点
  const pins = new Map<number, number>()
  pins.set(0, cues[0].startMs)
  pins.set(P - 1, cues[n - 1].endMs)
  if (locks) {
    for (let i = 0; i < n; i++) {
      const lk = locks[i]
      if (!lk) continue
      if (lk.start) pins.set(2 * i, cues[i].startMs)
      if (lk.end) pins.set(2 * i + 1, cues[i].endMs)
    }
  }

  for (let i = 0; i < n; i++) {
    const bp = 2 * i
    const ep = 2 * i + 1
    S[bp] = i === 0 ? 0 : S[bp - 1] - gapMs
    S[ep] = S[bp] - D[i]
    anchors[bp] = { value: cues[i].startMs + S[bp], weight: pins.has(bp) ? PIN_WEIGHT : 1 }
    anchors[ep] = { value: cues[i].endMs + S[ep], weight: pins.has(ep) ? PIN_WEIGHT : 1 }
  }

  const z = isotonicL1(anchors)
  const t = z.map((zv, p) => zv - S[p])

  // 钉死点（含锁定锚点）必须不动；若被合并说明锚点间约束在该断句下不可同时满足
  for (const [pos, time] of pins) {
    if (Math.round(t[pos]) !== time) return null
  }

  const starts: number[] = []
  const ends: number[] = []
  for (let i = 0; i < n; i++) {
    starts.push(t[2 * i])
    ends.push(t[2 * i + 1])
  }

  let moveMs = 0
  for (let i = 1; i < n; i++) moveMs += Math.abs(starts[i] - cues[i].startMs)
  for (let i = 0; i < n - 1; i++) moveMs += Math.abs(ends[i] - cues[i].endMs)

  return { starts, ends, moveMs }
}

// ---------------------------------------------------------------------------
// 断句 DP：给定每条实际时长，求最优切点
// 目标词典序：(Σ 时长缺口, Σ 文字移动量)
// ---------------------------------------------------------------------------

interface DPContext {
  n: number
  N: number
  chars: string[]
  settings: Settings
  durations: number[]
  /** diffPref[owner2][p] = Σ_{j<p} |owner2−origOwner[j]|（插入空格与无归属不计） */
  diffPref: Int32Array[]
  nonSpacePrefix: Int32Array
  validCache: Map<number, boolean>
  /** fixedCut[k] ≥ 0 表示第 k 个切点必须落在该码点位置（文字归属锁定） */
  fixedCut: Int32Array
}

function segKey(q: number, p: number): number {
  return q * 100000 + p
}

/** 段 [q,p) 是否合法：≥1 个非空字符、折行 ≤ MAX_LINES、每行 ≤ maxChars */
function segmentValid(ctx: DPContext, q: number, p: number): boolean {
  const key = segKey(q, p)
  const cached = ctx.validCache.get(key)
  if (cached !== undefined) return cached

  const len = p - q
  let ok = true
  if (len < 1 || len > MAX_LINES * ctx.settings.maxChars) ok = false
  if (ok && ctx.nonSpacePrefix[p] - ctx.nonSpacePrefix[q] < 1) ok = false
  if (ok) {
    const segText = ctx.chars.slice(q, p).join('').trim()
    const wrapped = wrapText(segText, ctx.settings.maxChars)
    if (wrapped.length > MAX_LINES) ok = false
  }
  ctx.validCache.set(key, ok)
  return ok
}

const DP_INF = 1 << 30

/** 断句 DP（密集数组实现），词典序最小化 (时长缺口, 文字移动量)；固定切点强制取原值 */
function optimizeCuts(ctx: DPContext): number[] | null {
  const { n, N, settings, durations, diffPref, fixedCut } = ctx
  const maxLen = MAX_LINES * settings.maxChars
  const cps = settings.cps

  // 状态按“末位置 p”索引；第 i 层只保留每个 p 的最优（词典序）
  let gapArr = new Int32Array(N + 1).fill(DP_INF)
  let moveArr = new Int32Array(N + 1).fill(DP_INF)
  gapArr[0] = 0
  moveArr[0] = 0
  const backs: Int32Array[] = []

  for (let i = 1; i <= n; i++) {
    const ng = new Int32Array(N + 1).fill(DP_INF)
    const nm = new Int32Array(N + 1).fill(DP_INF)
    const back = new Int32Array(N + 1).fill(-1)
    const dur = durations[i - 1]
    const owner = i - 1
    const diff = diffPref[owner]
    const endLimit = i === n ? N : N - (n - i)
    const startLimit = i === 1 ? 0 : N - (n - i + 1)
    const fixedP = fixedCut[i]
    for (let q = i - 1; q <= startLimit; q++) {
      const gq = gapArr[q]
      if (gq === DP_INF) continue
      const mq = moveArr[q]
      const hi = Math.min(endLimit, q + maxLen, N)
      for (let p = q + 1; p <= hi; p++) {
        if (i === n && p !== N) continue
        if (fixedP >= 0 && p !== fixedP) continue
        if (!segmentValid(ctx, q, p)) continue
        const minDur = Math.ceil((1000 * (p - q)) / cps)
        const gapPen = gq + (minDur > dur ? minDur - dur : 0)
        if (gapPen > ng[p]) continue
        const movePen = mq + diff[p] - diff[q]
        if (gapPen < ng[p] || (gapPen === ng[p] && movePen < nm[p])) {
          ng[p] = gapPen
          nm[p] = movePen
          back[p] = q
        }
      }
    }
    backs.push(back)
    gapArr = ng
    moveArr = nm
  }

  if (gapArr[N] === DP_INF) return null
  const cuts = new Array<number>(n + 1)
  cuts[n] = N
  let p = N
  for (let i = n; i >= 1; i--) {
    p = backs[i - 1][p]
    if (p < 0) return null
    cuts[i - 1] = p
  }
  return cuts
}

// ---------------------------------------------------------------------------
// 初始切点：给定每条“目标累计比例”，贪心取离目标最近的合法切点
// ---------------------------------------------------------------------------

function greedyCuts(ctx: DPContext, targetCum: number[]): number[] | null {
  const { n, N, fixedCut } = ctx
  const maxLen = MAX_LINES * ctx.settings.maxChars
  const cuts = [0]
  for (let i = 0; i < n - 1; i++) {
    const start = cuts[i]
    const rest = n - 1 - i // 当前之后还剩几条
    const lo = Math.max(start + 1, N - rest * maxLen)
    const hi = Math.min(start + maxLen, N - rest) // 后续每条至少 1 字
    if (lo > hi) return null
    const fx = fixedCut[i + 1]
    if (fx >= 0) {
      // 固定切点：必须取原值
      if (fx < lo || fx > hi || !segmentValid(ctx, start, fx)) return null
      cuts.push(fx)
      continue
    }
    const target = Math.round(targetCum[i] * N)
    let chosen = -1
    for (let d = 0; d <= maxLen + 1 && chosen === -1; d++) {
      for (const c of d === 0 ? [target] : [target + d, target - d]) {
        if (c >= lo && c <= hi && segmentValid(ctx, start, c)) {
          chosen = c
          break
        }
      }
    }
    if (chosen === -1) return null
    cuts.push(chosen)
  }
  cuts.push(N)
  if (!segmentValid(ctx, cuts[n - 1], N)) return null
  return cuts
}

/** 在合法区间内随机逐条生成切点（局部合法，再由时间优化判全局可行） */
function randomCuts(ctx: DPContext, rng: () => number): number[] | null {
  const { n, N, fixedCut } = ctx
  const maxLen = MAX_LINES * ctx.settings.maxChars
  const cuts = [0]
  for (let i = 0; i < n - 1; i++) {
    const start = cuts[i]
    const rest = n - 1 - i
    const lo = Math.max(start + 1, N - rest * maxLen)
    const hi = Math.min(start + maxLen, N - rest)
    if (lo > hi) return null
    const fx = fixedCut[i + 1]
    if (fx >= 0) {
      if (fx < lo || fx > hi || !segmentValid(ctx, start, fx)) return null
      cuts.push(fx)
      continue
    }
    const feasible: number[] = []
    for (let c = lo; c <= hi; c++) if (segmentValid(ctx, start, c)) feasible.push(c)
    if (feasible.length === 0) return null
    cuts.push(feasible[Math.floor(rng() * feasible.length)])
  }
  cuts.push(N)
  if (!segmentValid(ctx, cuts[n - 1], N)) return null
  return cuts
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function computeOwners(cuts: number[], N: number): Int32Array {
  const owner = new Int32Array(N)
  let k = 0
  for (let j = 0; j < N; j++) {
    while (k < cuts.length - 2 && j >= cuts[k + 1]) k++
    owner[j] = k
  }
  return owner
}

function charMoveOf(
  origOwner: Int32Array,
  newOwner: Int32Array,
  inserted: Uint8Array
): { move: number; moved: number } {
  let move = 0
  let moved = 0
  for (let j = 0; j < origOwner.length; j++) {
    if (inserted[j] || origOwner[j] < 0) continue
    const d = Math.abs(newOwner[j] - origOwner[j])
    move += d
    if (d > 0) moved++
  }
  return { move, moved }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function solve(
  cuesInput: SrtCue[],
  settings: Settings,
  locks?: Array<CueLock | undefined>
): SolveResult {
  const conflicts: Conflict[] = []
  const cues = cuesInput.map((c, i) => ({ ...c, index: i }))
  const n = cues.length
  const lockAt = (i: number): CueLock => locks?.[i] ?? {}
  const hasLocks = !!locks && locks.some((l) => l && (l.text || l.start || l.end))

  if (n === 0) return { ok: false, conflicts: [{ rule: '选区为空', message: '请至少选择 1 条字幕。' }] }
  if (!Number.isFinite(settings.cps) || settings.cps <= 0)
    conflicts.push({ rule: '每秒字符数非法', message: '每秒字符数必须为正数。' })
  if (!Number.isFinite(settings.maxChars) || settings.maxChars <= 0)
    conflicts.push({ rule: '单行字数非法', message: '单行字数必须为正数。' })
  if (settings.gapMs < 0)
    conflicts.push({ rule: '最小间隔非法', message: '最小提示间隔不能为负。' })
  if (conflicts.length) return { ok: false, conflicts }

  // 1. 展平文字
  const { text, cuts: origCuts } = flattenCues(cues.map((c) => c.lines))
  const chars = charsOf(text)
  const N = chars.length

  // 拼接插入的空格：恰好落在原始切点上的空格
  const insertedSpace = new Uint8Array(N)
  for (let k = 1; k < origCuts.length - 1; k++) {
    const p = origCuts[k]
    if (p < N && chars[p] === ' ') insertedSpace[p] = 1
  }

  const origOwner = new Int32Array(N)
  {
    let k = 0
    for (let j = 0; j < N; j++) {
      while (k < n - 1 && j >= origCuts[k + 1]) k++
      origOwner[j] = k
    }
  }

  // 文字归属锁定 ⇒ 对应切点固定在原始位置
  const fixedCut = new Int32Array(n + 1).fill(-1)
  fixedCut[0] = 0
  fixedCut[n] = N
  for (let i = 0; i < n; i++) {
    if (lockAt(i).text) {
      fixedCut[i] = origCuts[i]
      fixedCut[i + 1] = origCuts[i + 1]
    }
  }

  // 2a. 锚点预检（文字锁定）：锁定段折行合法性 + 锁定切点间区段容量
  if (hasLocks) {
    const anchorConflicts: Conflict[] = []
    for (let i = 0; i < n; i++) {
      if (!lockAt(i).text) continue
      const seg = chars.slice(origCuts[i], origCuts[i + 1]).join('').trim()
      const segLen = charsOf(seg).length
      if (segLen === 0) {
        anchorConflicts.push({
          rule: '锚点冲突：文字锁定',
          message: `第 ${i + 1} 条文字已锁定，但内容为空，无法满足“每条至少 1 个非空字符”。请解除第 ${i + 1} 条的文字锁定。`,
        })
        continue
      }
      const lineCount = wrapText(seg, settings.maxChars).length
      if (lineCount > MAX_LINES) {
        anchorConflicts.push({
          rule: '锚点冲突：单行字数',
          message: `第 ${i + 1} 条文字已锁定（${segLen} 字），按单行 ${settings.maxChars} 字折行需要 ${lineCount} 行，超过 ${MAX_LINES} 行上限（单行字数至少需 ${Math.ceil(segLen / MAX_LINES)} 且词边界可折行）。请调大单行字数，或解除第 ${i + 1} 条的文字锁定。`,
        })
      }
    }
    // 被固定切点夹住的区段：文字量已确定，容量必须装得下
    let u = 0
    while (u < n) {
      let v = u
      while (v < n - 1 && fixedCut[v + 1] < 0) v++
      const L = fixedCut[v + 1] - fixedCut[u]
      const cap = (v - u + 1) * MAX_LINES * settings.maxChars
      const singleLocked = u === v && !!lockAt(u).text
      if (L > cap && !singleLocked && !(u === 0 && v === n - 1)) {
        anchorConflicts.push({
          rule: '锚点冲突：单行字数',
          message: `第 ${u + 1}–${v + 1} 条之间的文字被文字锚点固定为 ${L} 字，但这 ${v - u + 1} 条最多容纳 ${cap} 字（每条 ${MAX_LINES} 行 × ${settings.maxChars} 字）。请调大单行字数，或解除部分文字锁定。`,
        })
      }
      u = v + 1
    }
    if (anchorConflicts.length) return { ok: false, conflicts: anchorConflicts }
  }

  // 2b. 冲突预检
  const fixedStart = cues[0].startMs
  const fixedEnd = cues[n - 1].endMs
  const span = fixedEnd - fixedStart
  const minTotalDur = Math.ceil((1000 * N) / settings.cps)
  const minGapTotal = (n - 1) * settings.gapMs

  // 不可断开的超长拉丁词（CJK 之间即使无空格也可逐字断开，故只看连续拉丁/数字串）
  const latinRuns = text.match(/[A-Za-z0-9'’\-]+/g) ?? []
  for (const tok of latinRuns) {
    if (charsOf(tok).length > settings.maxChars) {
      conflicts.push({
        rule: '单行字数冲突',
        message: `单词“${tok.length > 20 ? tok.slice(0, 20) + '…' : tok}”长 ${charsOf(tok).length} 字，超过单行上限 ${settings.maxChars} 字且无法在词内断开。请调大单行字数，或人工拆分该词。`,
      })
    }
  }
  if (span < minGapTotal) {
    conflicts.push({
      rule: '最小提示间隔冲突',
      message: `选区总跨度 ${span} ms，不足 ${n - 1} 个间隔所需的 ${minGapTotal} ms（每个间隔 ${settings.gapMs} ms）。请调小最小间隔，或扩大选区时间范围。`,
    })
  }
  if (span < minTotalDur + minGapTotal) {
    conflicts.push({
      rule: '每秒字符数冲突',
      message: `选区共 ${N} 个字符，按 ${settings.cps} 字/秒并保留 ${settings.gapMs} ms 间隔至少需要 ${minTotalDur + minGapTotal} ms，但片段总起止跨度仅 ${span} ms（首条开始与末条结束固定不动）。请调大每秒字符数（放宽节奏下限）或调小间隔，或扩大选区。`,
    })
  }
  const totalCap = n * MAX_LINES * settings.maxChars
  if (N > totalCap) {
    conflicts.push({
      rule: '单行字数冲突',
      message: `${n} 条字幕、每条最多 ${MAX_LINES} 行 × ${settings.maxChars} 字，最多容纳 ${totalCap} 字，选区有 ${N} 字。请调大单行字数。`,
    })
  }
  if (conflicts.length) return { ok: false, conflicts }

  // 2c. 锚点预检（时间锁定）：相邻钉死点之间的区间可行性。
  //     钉死点 = 选区首条开始 / 末条结束（恒定）+ 用户锁定的开始/结束时间。
  //     对每对相邻钉死点：可用时间 ≥ 区间最小时长 + 区间间隔需求，
  //     其中被固定切点夹住的区段文字量确定（取下界 ceil(1000·L/cps)），
  //     其余每条至少 1 字。不满足 ⇒ 无论断句如何调整都无解，直接报告冲突锚点。
  if (hasLocks) {
    interface Pin {
      pos: number // 节点链位置：b_i=2i，e_i=2i+1
      time: number
      label: string
    }
    const pins: Pin[] = [
      {
        pos: 0,
        time: cues[0].startMs,
        label: lockAt(0).start ? '第 1 条开始时间（锁定）' : '第 1 条开始时间（选区起点，固定）',
      },
      {
        pos: 2 * n - 1,
        time: cues[n - 1].endMs,
        label: lockAt(n - 1).end
          ? `第 ${n} 条结束时间（锁定）`
          : `第 ${n} 条结束时间（选区终点，固定）`,
      },
    ]
    for (let i = 0; i < n; i++) {
      const lk = lockAt(i)
      if (lk.start && i !== 0)
        pins.push({ pos: 2 * i, time: cues[i].startMs, label: `第 ${i + 1} 条开始时间（锁定）` })
      if (lk.end && i !== n - 1)
        pins.push({ pos: 2 * i + 1, time: cues[i].endMs, label: `第 ${i + 1} 条结束时间（锁定）` })
    }
    pins.sort((a, b) => a.pos - b.pos)

    const min1 = Math.ceil(1000 / settings.cps)
    const anchorConflicts: Conflict[] = []
    for (let k = 0; k + 1 < pins.length; k++) {
      const A = pins[k]
      const B = pins[k + 1]
      const available = B.time - A.time
      // 完整落在两钉死点之间的字幕序号区间 [cueLo..cueHi]
      const cueLo = Math.ceil(A.pos / 2)
      const cueHi = Math.floor((B.pos - 1) / 2)
      let gapCount = 0
      for (let g = 0; g < n - 1; g++) {
        if (2 * g + 1 >= A.pos && 2 * g + 2 <= B.pos) gapCount++
      }
      // 时长下界：按固定切点划分区段，文字量确定的区段取 ceil(1000·L/cps)
      let durMin = 0
      let u = cueLo
      while (u <= cueHi) {
        let v = u
        while (v + 1 <= cueHi && fixedCut[v + 1] < 0) v++
        if (fixedCut[u] >= 0 && fixedCut[v + 1] >= 0) {
          durMin += Math.ceil((1000 * (fixedCut[v + 1] - fixedCut[u])) / settings.cps)
        } else {
          durMin += (v - u + 1) * min1
        }
        u = v + 1
      }
      const gapNeed = gapCount * settings.gapMs
      const required = durMin + gapNeed
      if (available < required) {
        const parts: string[] = []
        if (durMin > 0) parts.push(`时长至少 ${durMin} ms`)
        if (gapCount > 0) parts.push(`${gapCount} 个间隔 × ${settings.gapMs} ms = ${gapNeed} ms`)
        anchorConflicts.push({
          rule: gapCount > 0 && durMin === 0 ? '锚点冲突：最小间隔' : '锚点冲突：最小时长',
          message: `${A.label}与${B.label}之间可用 ${available} ms，但按当前参数最小需要 ${required} ms（${parts.join(' + ')}），还差 ${required - available} ms。请解除相关锚点锁定、调整锁定时间，或放宽每秒字符数/最小间隔。`,
        })
      }
    }
    if (anchorConflicts.length) return { ok: false, conflicts: anchorConflicts }
  }

  // 3. DP 上下文（与时长无关的部分）
  const nonSpacePrefix = new Int32Array(N + 1)
  for (let j = 0; j < N; j++)
    nonSpacePrefix[j + 1] = nonSpacePrefix[j] + (chars[j] === ' ' ? 0 : 1)

  const diffPref: Int32Array[] = []
  for (let owner2 = 0; owner2 < n; owner2++) {
    const arr = new Int32Array(N + 1)
    for (let j = 0; j < N; j++) {
      arr[j + 1] =
        arr[j] + (!insertedSpace[j] && origOwner[j] >= 0 ? Math.abs(owner2 - origOwner[j]) : 0)
    }
    diffPref.push(arr)
  }

  const baseCtx = {
    n,
    N,
    chars,
    settings,
    diffPref,
    nonSpacePrefix,
    validCache: new Map<number, boolean>(),
    fixedCut,
  }

  // 预热：一次性计算所有可能段 [q,p) 的折行合法性（供 DP / 随机切点 / 邻域共用）
  {
    const maxLen = MAX_LINES * settings.maxChars
    for (let q = 0; q < N; q++) {
      for (let p = q + 1; p <= Math.min(N, q + maxLen); p++) {
        segmentValid(baseCtx as DPContext, q, p)
      }
    }
  }

  // 时间优化结果按切点缓存（搜索中会反复评估相同构型）
  const timingCache = new Map<string, TimingSolution | null>()
  const timingOf = (cutsArg: number[]): TimingSolution | null => {
    const key = cutsArg.join(',')
    if (timingCache.has(key)) return timingCache.get(key)!
    const t = optimizeTimingImpl(cues, cutsArg, settings, locks)
    timingCache.set(key, t)
    return t
  }

  // 4. 多起点搜索（联合断句×时间为非凸问题，交替迭代可能止于局部最优）：
  //    a) 3 组结构化初始切点（均匀 / 按原字数 / 按原时长）
  //    b) 上百组随机【合法】切点（固定随机种子，结果可复现）
  //    c) 模拟退火（单切点 / 相邻双切点 / 双切点独立扰动，每步交替到不动点）
  //    d) 确定性邻域精修：单/双切点 ±1..±3 直接评估原始时间目标，
  //       捕获“非交替不动点”的更优构型，下降迭代到收敛。
  const cum = (w: number[]): number[] => {
    const sum = w.reduce((a, b) => a + b, 0)
    const out: number[] = []
    let acc = 0
    for (let i = 0; i < n - 1; i++) {
      acc += w[i]
      out.push(sum > 0 ? acc / sum : (i + 1) / n)
    }
    return out
  }
  const seedCums: number[][] = [
    cum(new Array(n).fill(1)),
    cum(cues.map((c) => Math.max(1, origCuts[c.index + 1] - origCuts[c.index]))),
    cum(cues.map((c) => Math.max(1, c.endMs - c.startMs))),
  ]

  type BestType = { cuts: number[]; timing: TimingSolution; tuple: [number, number] }
  // 用对象容器持有“当前最优”，避免闭包赋值导致 TS 控制流收窄失效
  const bestBox: { v: BestType | null } = { v: null }
  let roundsUsed = 0

  const tupleOf = (cutsArg: number[], timingArg: TimingSolution): [number, number] => {
    const { move } = charMoveOf(origOwner, computeOwners(cutsArg, N), insertedSpace)
    return [timingArg.moveMs, move]
  }
  const consider = (cutsArg: number[], timingArg: TimingSolution) => {
    const tuple = tupleOf(cutsArg, timingArg)
    const cur = bestBox.v
    if (!cur || tuple[0] < cur.tuple[0] || (tuple[0] === cur.tuple[0] && tuple[1] < cur.tuple[1])) {
      bestBox.v = { cuts: cutsArg.slice(), timing: timingArg, tuple }
    }
  }

  /** 从一组切点交替迭代到不动点 */
  const alternate = (cuts0: number[]) => {
    let cuts = cuts0
    let timing = timingOf(cuts)
    if (!timing) return
    const seen = new Set<string>()
    for (let round = 0; round < MAX_ROUNDS; round++) {
      roundsUsed++
      consider(cuts, timing)
      const key = cuts.join(',')
      if (seen.has(key)) break
      seen.add(key)
      const curTiming: TimingSolution = timing
      const ctx: DPContext = {
        ...baseCtx,
        durations: curTiming.ends.map((e, i) => e - curTiming.starts[i]),
      }
      const next = optimizeCuts(ctx)
      if (!next || next.join(',') === key) break
      cuts = next
      const nextTiming = timingOf(cuts)
      if (!nextTiming) break
      timing = nextTiming
    }
  }

  // 结构化种子
  for (const targetCum of seedCums) {
    const seedCtx: DPContext = {
      ...baseCtx,
      durations: cues.map((c) => c.endMs - c.startMs),
    }
    const cuts = greedyCuts(seedCtx, targetCum)
    if (cuts) alternate(cuts)
  }

  // 随机合法切点重启（固定种子，结果可复现）
  {
    const rng = mulberry32(20260921)
    const seedCtx: DPContext = { ...baseCtx, durations: [] }
    const RANDOM_RESTARTS = n <= 12 ? 120 : n <= 20 ? 60 : 16
    const visited = new Set<string>()
    for (let r = 0; r < RANDOM_RESTARTS; r++) {
      const cuts = randomCuts(seedCtx, rng)
      if (!cuts) continue
      const key = cuts.join(',')
      if (visited.has(key)) continue
      visited.add(key)
      // 随机切点未必满足时间可行性，alternate 内部会判空
      alternate(cuts)
    }
  }

  // 模拟退火局部搜索：邻域 = 单切点平移 / 相邻双切点同移（块平移）/ 双切点独立扰动。
  // 每轮对新构型先交替到不动点再评估；允许短暂上坡以跨越宽谷。
  // 固定切点（文字锁定）不参与扰动。
  const freeCuts: number[] = []
  for (let k = 1; k < n; k++) if (fixedCut[k] < 0) freeCuts.push(k)
  const freePairs = freeCuts.filter((k) => k + 1 <= n - 1 && fixedCut[k + 1] < 0)
  const startBest = bestBox.v
  if (startBest && freeCuts.length > 0) {
    const rng = mulberry32(987654321)
    const stepMax = MAX_LINES * settings.maxChars
    const vctx: DPContext = { ...baseCtx, durations: [] }

    const cutsFeasible = (cs: number[]): boolean => {
      for (let i = 0; i < n; i++) if (!segmentValid(vctx, cs[i], cs[i + 1])) return false
      return true
    }
    const evalCuts = (cs: number[]): { timing: TimingSolution; tuple: [number, number] } | null => {
      const t = timingOf(cs)
      if (!t) return null
      return { timing: t, tuple: tupleOf(cs, t) }
    }
    /** 交替到不动点（返回切点与 tuple） */
    const relax = (cs0: number[]): { cuts: number[]; tuple: [number, number] } | null => {
      let cuts = cs0
      let cur = evalCuts(cuts)
      if (!cur) return null
      const seen = new Set<string>()
      for (let r = 0; r < MAX_ROUNDS; r++) {
        consider(cuts, cur.timing)
        const key = cuts.join(',')
        if (seen.has(key)) break
        seen.add(key)
        const ctx: DPContext = { ...baseCtx, durations: cur.timing.ends.map((e, k) => e - cur!.timing.starts[k]) }
        const jumped = optimizeCuts(ctx)
        if (!jumped || jumped.join(',') === key) break
        const je = evalCuts(jumped)
        if (!je) break
        cuts = jumped
        cur = je
      }
      return { cuts, tuple: cur.tuple }
    }

    let state = { cuts: startBest.cuts.slice(), tuple: startBest.tuple }
    const STEPS = n <= 12 ? 240 : n <= 20 ? 120 : 36
    for (let step = 0; step < STEPS; step++) {
      const T = 600 * (1 - step / STEPS) + 10
      const cand = state.cuts.slice()
      const moveKind = rng()
      const pickDelta = () => {
        const mag = 1 + Math.floor(rng() * Math.min(stepMax, 1 + ((step % 4) + 1) * 3))
        return (rng() < 0.5 ? -1 : 1) * mag
      }
      if (moveKind < 0.55 || freePairs.length === 0) {
        // 单切点平移
        const i = freeCuts[Math.floor(rng() * freeCuts.length)]
        cand[i] += pickDelta()
      } else if (moveKind < 0.8) {
        // 相邻双切点同向同幅（中间条块平移，两个切点均须自由）
        const i = freePairs[Math.floor(rng() * freePairs.length)]
        const d = pickDelta()
        cand[i] += d
        cand[i + 1] += d
      } else {
        // 两个随机自由切点独立扰动
        const i = freeCuts[Math.floor(rng() * freeCuts.length)]
        const j = freeCuts[Math.floor(rng() * freeCuts.length)]
        cand[i] += pickDelta()
        if (j !== i) cand[j] += pickDelta()
      }
      // 单调性修正与越界拒绝
      let ok = cand[0] === 0 && cand[n] === N
      for (let i = 1; i <= n && ok; i++) if (cand[i] <= cand[i - 1]) ok = false
      if (!ok || !cutsFeasible(cand)) continue
      const rlx = relax(cand)
      if (!rlx) continue
      const dCost = rlx.tuple[0] - state.tuple[0]
      if (dCost <= 0 || rng() < Math.exp(-dCost / T)) {
        state = { cuts: rlx.cuts, tuple: rlx.tuple }
      }
    }
  }

  // 确定性邻域精修：直接评估原始时间目标 f(cuts)=timeMove(cuts)（不经 DP 松弛，
  // 因此能捕获“非交替不动点”的更优构型），邻域含单切点与相邻双切点 ±1..±3。
  if (bestBox.v) {
    const vctx: DPContext = { ...baseCtx, durations: [] }
    let cur = bestBox.v.cuts.slice()
    let curCost = bestBox.v.tuple[0]
    const R = Math.min(3, settings.maxChars)
    const maxPass = n <= 20 ? 12 : 6
    for (let pass = 0; pass < maxPass; pass++) {
      let improved: number[] | null = null
      let improvedCost = curCost
      const tryCand = (cand: number[]) => {
        for (let i = 1; i <= n; i++) if (cand[i] <= cand[i - 1]) return
        for (let i = 0; i < n; i++) if (!segmentValid(vctx, cand[i], cand[i + 1])) return
        const t = timingOf(cand)
        if (!t) return
        if (t.moveMs < improvedCost) {
          improvedCost = t.moveMs
          improved = cand
          consider(cand, t)
        }
      }
      for (let i = 1; i < n; i++) {
        if (fixedCut[i] >= 0) continue // 固定切点不动
        for (let d = -R; d <= R; d++) {
          if (d === 0) continue
          const cand = cur.slice()
          cand[i] += d
          tryCand(cand)
        }
      }
      if (n <= 20) for (let i = 1; i < n - 1; i++) {
        if (fixedCut[i] >= 0 || fixedCut[i + 1] >= 0) continue
        for (let d1 = -R; d1 <= R; d1++) {
          for (let d2 = -R; d2 <= R; d2++) {
            if (d1 === 0 && d2 === 0) continue
            const cand = cur.slice()
            cand[i] += d1
            cand[i + 1] += d2
            tryCand(cand)
          }
        }
      }
      if (!improved) break
      cur = improved
      curCost = improvedCost
    }
  }

  // 5. 组装结果
  const finalBest: BestType | null = bestBox.v
  if (!finalBest) {
    return {
      ok: false,
      conflicts: [
        {
          rule: '断句无解',
          message: `在每行 ${settings.maxChars} 字、最多 ${MAX_LINES} 行的联合限制下，无法把全部文字分配到 ${n} 条字幕（词边界约束）。请调大单行字数，或减少选区条数。`,
        },
      ],
    }
  }
  const { cuts, timing } = finalBest
  const newOwner = computeOwners(cuts, N)
  const { move: charMove, moved: movedCharCount } = charMoveOf(origOwner, newOwner, insertedSpace)

  const solvedCues: SolvedCue[] = []
  for (let i = 0; i < n; i++) {
    const segText = chars.slice(cuts[i], cuts[i + 1]).join('').trim()
    const segChars = charsOf(segText)
    const lineOffsets = wrapOffsets(segText, settings.maxChars)
    const lines = lineOffsets.map(([s, e]) => segChars.slice(s, e).join(''))
    const visibleLen = charsOf(segText.replace(/\s+/g, '')).length
    const dur = timing.ends[i] - timing.starts[i]
    solvedCues.push({
      startMs: timing.starts[i],
      endMs: timing.ends[i],
      lines,
      lineOffsets,
      text: segText,
      dStart: timing.starts[i] - cues[i].startMs,
      dEnd: timing.ends[i] - cues[i].endMs,
      cpsActual: dur > 0 ? Math.round(((visibleLen * 1000) / dur) * 10) / 10 : 0,
    })
  }

  return {
    ok: true,
    text,
    cues: solvedCues,
    origCuts,
    newCuts: cuts,
    origOwner,
    newOwner,
    insertedSpace,
    metrics: { timeMoveMs: timing.moveMs, charMove, movedCharCount },
    rounds: roundsUsed,
  }
}

// 仅供测试引用（不参与应用打包）
export { optimizeTimingImpl }
