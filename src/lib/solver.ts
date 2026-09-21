// 字幕节奏修复核心求解器
//
// 问题：保持文字内容与顺序不变、选区首条开始时间与末条结束时间不变，
//       联合调整 (a) 文字断句切点 (b) 各条毫秒边界，
//       使全部约束满足且“边界总移动量”最小。
//
// 锚点锁定（可选，按条分别指定）：
//   - text[i]  文字归属锁定：第 i 条的文字内容不进不出，切点 origCuts[i]/[i+1] 固定；
//   - start[i] 开始时间锁定：第 i 条开始边界在 PAVA 中以极大权重钉死；
//   - end[i]   结束时间锁定：第 i 条结束边界在 PAVA 中以极大权重钉死。
//   选区首条开始与末条结束始终隐式钉死。锁定导致无解时，报告互相冲突的锚点对、
//   实测跨度与最小所需时长/间隔（含差额），而不是通用失败。
//
// 约束（每条字幕）：
//   - 折行行数 ≤ MAX_LINES（标准字幕两行），每行 ≤ maxChars（词感知折行）
//     文字锁定条目不参与折行限制，导出时逐字保留原始行。
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

import { SrtCue, msToSrtTime } from './srt'
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

/**
 * 锚点锁定：长度可小于 n（缺省视为未锁定）。
 * 首条开始（start[0]）与末条结束（end[n-1]）始终隐式锁定。
 */
export interface AnchorLocks {
  /** 文字归属锁定：该条文字不进不出，相邻切点固定为原始切点 */
  text: boolean[]
  /** 开始时间锁定 */
  start: boolean[]
  /** 结束时间锁定 */
  end: boolean[]
}

export function emptyLocks(n: number): AnchorLocks {
  return {
    text: new Array<boolean>(n).fill(false),
    start: new Array<boolean>(n).fill(false),
    end: new Array<boolean>(n).fill(false),
  }
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
  /** 文字归属被锁定：lines/lineOffsets 为原始行，导出须逐字保持 */
  lockedText?: boolean
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
  /** 本次求解实际生效的锚点锁定（长度 n，含隐式端点钉死） */
  locks: AnchorLocks
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

/**
 * 给定切点求最优毫秒边界。pins 中为 true 的节点（2n 链位置）以极大权重钉死。
 * 首 b_0、末 e_{n-1} 即使未在 pins 中声明也始终钉死。
 */
function optimizeTimingImpl(
  cues: SrtCue[],
  cuts: number[],
  settings: Settings,
  pins?: boolean[]
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
  const pinned = pins ? pins.slice() : new Array<boolean>(P).fill(false)

  for (let i = 0; i < n; i++) {
    const bp = 2 * i
    const ep = 2 * i + 1
    S[bp] = i === 0 ? 0 : S[bp - 1] - gapMs
    S[ep] = S[bp] - D[i]
    const pinB = i === 0 || pinned[bp]
    const pinE = i === n - 1 || pinned[ep]
    if (pinB) pinned[bp] = true
    if (pinE) pinned[ep] = true
    anchors[bp] = { value: cues[i].startMs + S[bp], weight: pinB ? PIN_WEIGHT : 1 }
    anchors[ep] = { value: cues[i].endMs + S[ep], weight: pinE ? PIN_WEIGHT : 1 }
  }

  const z = isotonicL1(anchors)
  const t = z.map((zv, p) => zv - S[p])

  // 钉死点必须不动；若被合并说明该断句下锚点约束互相冲突（总时长/间隔不足）
  for (let p = 0; p < P; p++) {
    if (pinned[p] && Math.round(t[p]) !== (p % 2 === 0 ? cues[p >> 1].startMs : cues[p >> 1].endMs)) {
      return null
    }
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
  /** 原始切点（文字锁定时固定为该值） */
  origCuts: number[]
  /** fixed[k] = 切点 k 必须等于 origCuts[k] */
  fixed: boolean[]
  /** 第 i 条文字归属锁定 → 段 [cuts[i], cuts[i+1]) 恒为原始段、免折行检查 */
  textLocked: boolean[]
  /** cutLo[k]/cutHi[k]：切点 k（1..n-1）受相邻固定切点推出的硬界 */
  cutLo: Int32Array
  cutHi: Int32Array
}

function segKey(q: number, p: number): number {
  return q * 100000 + p
}

/** 段 [q,p) 是否合法：≥1 个非空字符、折行 ≤ MAX_LINES、每行 ≤ maxChars */
function segmentValid(ctx: DPContext, q: number, p: number, segIdx?: number): boolean {
  // 文字锁定段恒合法（原始内容，导出时原样保留；空段在预检阶段单独报错）
  if (segIdx !== undefined && ctx.textLocked[segIdx]) return true
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

/** 断句 DP（密集数组实现），词典序最小化 (时长缺口, 文字移动量) */
function optimizeCuts(ctx: DPContext): number[] | null {
  const { n, N, settings, durations, diffPref, fixed, cutLo, cutHi, origCuts } = ctx
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
    // 固定切点（文字锁定条目的任一侧）只允许其原始位置；其余在硬界内枚举
    const fixedEnd = fixed[i]
    const fixedStart = i === 1 || fixed[i - 1]
    const pLo = fixedEnd ? origCuts[i] : i === n ? N : cutLo[i]
    const pHi = fixedEnd ? origCuts[i] : i === n ? N : cutHi[i]
    const qLo = fixedStart ? origCuts[i - 1] : cutLo[i - 1]
    const qHi = fixedStart ? origCuts[i - 1] : cutHi[i - 1]
    for (let q = qLo; q <= qHi; q++) {
      const gq = gapArr[q]
      if (gq === DP_INF) continue
      const mq = moveArr[q]
      for (let p = Math.max(pLo, q + 1); p <= Math.min(pHi, q + maxLen, N); p++) {
        if (i === n && p !== N) continue
        if (!segmentValid(ctx, q, p, i - 1)) continue
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
  const { n, N, textLocked, origCuts, cutLo, cutHi } = ctx
  const maxLen = MAX_LINES * ctx.settings.maxChars
  const cuts = new Array<number>(n + 1)
  cuts[0] = 0
  cuts[n] = N
  for (let k = 1; k < n; k++) {
    if (textLocked[k - 1] || textLocked[k]) {
      cuts[k] = origCuts[k]
      continue
    }
    const lo = Math.max(cutLo[k], cuts[k - 1] + 1)
    const hi = Math.min(cutHi[k], cuts[k - 1] + maxLen)
    if (lo > hi) return null
    const target = Math.round(targetCum[k - 1] * N)
    let chosen = -1
    for (let d = 0; d <= maxLen + 1 && chosen === -1; d++) {
      for (const c of d === 0 ? [target] : [target + d, target - d]) {
        if (c >= lo && c <= hi && segmentValid(ctx, cuts[k - 1], c, k - 1)) {
          chosen = c
          break
        }
      }
    }
    if (chosen === -1) return null
    cuts[k] = chosen
  }
  for (let i = 0; i < n; i++) {
    if (!segmentValid(ctx, cuts[i], cuts[i + 1], i)) return null
  }
  return cuts
}

/** 在合法区间内随机逐条生成切点（局部合法，再由时间优化判全局可行） */
function randomCuts(ctx: DPContext, rng: () => number): number[] | null {
  const { n, N, textLocked, origCuts, cutLo, cutHi } = ctx
  const maxLen = MAX_LINES * ctx.settings.maxChars
  const cuts = new Array<number>(n + 1)
  cuts[0] = 0
  cuts[n] = N
  for (let k = 1; k < n; k++) {
    if (textLocked[k - 1] || textLocked[k]) {
      cuts[k] = origCuts[k]
      continue
    }
    const lo = Math.max(cutLo[k], cuts[k - 1] + 1)
    const hi = Math.min(cutHi[k], cuts[k - 1] + maxLen)
    if (lo > hi) return null
    const feasible: number[] = []
    for (let c = lo; c <= hi; c++) if (segmentValid(ctx, cuts[k - 1], c, k - 1)) feasible.push(c)
    if (feasible.length === 0) return null
    cuts[k] = feasible[Math.floor(rng() * feasible.length)]
  }
  for (let i = 0; i < n; i++) {
    if (!segmentValid(ctx, cuts[i], cuts[i + 1], i)) return null
  }
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
// 锚点锁定：结构与冲突分析
// ---------------------------------------------------------------------------

interface LockData {
  textLocked: boolean[]
  startLocked: boolean[]
  endLocked: boolean[]
  /** 固定切点：fixed[k] = true 表示切点 k 必须等于 origCuts[k] */
  fixed: boolean[]
  cutLo: Int32Array
  cutHi: Int32Array
  /** 自由断句块（连续未文字锁定的条 a..b，两侧为固定切点） */
  freeBlocks: Array<{ a: number; b: number }>
  /** PAVA 2n 节点链上的钉死位 */
  pins: boolean[]
  hasLocks: boolean
}

function buildLockData(n: number, origCuts: number[], locks: AnchorLocks, maxLen: number): LockData {
  const textLocked = new Array<boolean>(n)
  const startLocked = new Array<boolean>(n)
  const endLocked = new Array<boolean>(n)
  for (let i = 0; i < n; i++) {
    textLocked[i] = !!locks.text[i]
    startLocked[i] = !!locks.start[i]
    endLocked[i] = !!locks.end[i]
  }
  // 首条开始 / 末条结束隐式钉死
  startLocked[0] = true
  endLocked[n - 1] = true

  const fixed = new Array<boolean>(n + 1).fill(false)
  fixed[0] = true
  fixed[n] = true
  for (let i = 0; i < n; i++) {
    if (textLocked[i]) {
      fixed[i] = true
      fixed[i + 1] = true
    }
  }

  // 切点硬界：相邻固定切点 Pa/Pb 之间，切点 k 须满足
  //   每段 ≥1 字：Pa+(k-a) ≤ k ≤ Pb-(b-k)
  //   每段 ≤maxLen：Pa+(k-a)·maxLen ≥ k 且 (b-k)·maxLen ≥ Pb-k
  const cutLo = new Int32Array(n + 1)
  const cutHi = new Int32Array(n + 1)
  for (let k = 0; k <= n; k++) {
    if (fixed[k]) {
      cutLo[k] = cutHi[k] = origCuts[k]
      continue
    }
    let l = k - 1
    while (!fixed[l]) l--
    let r = k + 1
    while (!fixed[r]) r++
    const dl = k - l
    const dr = r - k
    cutLo[k] = Math.max(origCuts[l] + dl, origCuts[r] - dr * maxLen)
    cutHi[k] = Math.min(origCuts[r] - dr, origCuts[l] + dl * maxLen)
  }

  const freeBlocks: Array<{ a: number; b: number }> = []
  for (let i = 0; i < n; i++) {
    if (textLocked[i]) continue
    const a = i
    while (i < n && !textLocked[i]) i++
    freeBlocks.push({ a, b: i - 1 })
  }

  const pins = new Array<boolean>(2 * n).fill(false)
  for (let i = 0; i < n; i++) {
    pins[2 * i] = startLocked[i]
    pins[2 * i + 1] = endLocked[i]
  }

  // “有锚点锁定”仅指用户显式锁定（端点钉死是既有行为，不切换预检路径）
  const hasLocks = textLocked.some(Boolean) || locks.start.some(Boolean) || locks.end.some(Boolean)

  return { textLocked, startLocked, endLocked, fixed, cutLo, cutHi, freeBlocks, pins, hasLocks }
}

/**
 * 集中装填下界：count 个字符分进 m 条（每条 1..cap 字），
 * 求 Σ ceil(1000·len/cps) 的最小可能值（字符尽量集中到少数条）。
 * 不可行返回 null。
 */
function packedMinDur(count: number, m: number, cap: number, cps: number): number | null {
  if (count < m || count > m * cap) return null
  let need = 0
  let rest = count
  let slots = m
  while (slots > 0) {
    const fill = Math.min(cap, rest - (slots - 1))
    need += Math.ceil((1000 * fill) / cps)
    rest -= fill
    slots--
  }
  return need
}

/** “第 k 条开始/结束”的中文锚点名 */
function pinName(p: number): string {
  const cue = (p >> 1) + 1
  return p % 2 === 0 ? `第 ${cue} 条开始锚点` : `第 ${cue} 条结束锚点`
}

/**
 * 锚点冲突预检：按时间锚点把节点链划分为若干区域，逐区检查
 * 间隔、时长下限（自由块用集中装填下界）与容量。冲突写入 conflicts。
 */
function analyzeAnchorConflicts(
  cues: SrtCue[],
  chars: string[],
  origCuts: number[],
  settings: Settings,
  ld: LockData,
  conflicts: Conflict[]
): void {
  const n = cues.length
  const { textLocked, pins, freeBlocks } = ld
  const maxLen = MAX_LINES * settings.maxChars
  const cps = settings.cps
  const gap = settings.gapMs

  // 每条归属的自由块（文字锁定条为 -1）
  const blockOf = new Int32Array(n).fill(-1)
  freeBlocks.forEach((bl, bi) => {
    for (let i = bl.a; i <= bl.b; i++) blockOf[i] = bi
  })

  // 1) 锁定条原始段非空
  for (let i = 0; i < n; i++) {
    if (textLocked[i] && origCuts[i + 1] - origCuts[i] < 1) {
      conflicts.push({
        rule: '锚点冲突',
        message: `第 ${i + 1} 条的文字归属被锁定，但该条原始文字为空，无法保持归属。请解除该条的文字锁定。`,
      })
    }
  }

  // 2) 自由块容量（受折行行长 / 行数限制；锁定条不受此限）
  for (const bl of freeBlocks) {
    const Pa = origCuts[bl.a]
    const Pb = origCuts[bl.b + 1]
    const count = Pb - Pa
    const m = bl.b - bl.a + 1
    const cap = m * maxLen
    if (count > cap) {
      const left =
        bl.a === 0
          ? '片段开始'
          : `第 ${bl.a} 条文字锚点（${msToSrtTime(cues[bl.a - 1].endMs)} 处切点）`
      const right =
        bl.b === n - 1
          ? '片段结束'
          : `第 ${bl.b + 2} 条文字锚点（${msToSrtTime(cues[bl.b + 1].startMs)} 处切点）`
      conflicts.push({
        rule: '锚点冲突',
        message: `锁定的文字锚点把 ${m} 条字幕夹在 ${left} 与 ${right} 之间：该区间有 ${count} 字，但每行 ${settings.maxChars} 字、最多 ${MAX_LINES} 行时 ${m} 条仅能容纳 ${cap} 字，至少多出 ${count - cap} 字。请解除相邻的文字锁定，或调大单行字数。`,
      })
    }
    // 块内不可断开的超长拉丁词（锁定条内的词原样保留，不检查）
    const segText = chars.slice(Pa, Pb).join('')
    for (const tok of segText.match(/[A-Za-z0-9'’\-]+/g) ?? []) {
      if (charsOf(tok).length > settings.maxChars) {
        conflicts.push({
          rule: '锚点冲突',
          message: `锁定文字锚点之间的单词“${tok.length > 20 ? tok.slice(0, 20) + '…' : tok}”长 ${charsOf(tok).length} 字，超过单行上限 ${settings.maxChars} 字且无法在词内断开，又不能越过文字锚点。请解除相关文字锁定、调大单行字数，或人工拆分该词。`,
        })
      }
    }
  }

  // 3) 时间锚点逐区检查
  const pinPos: number[] = []
  for (let p = 0; p < 2 * n; p++) if (pins[p]) pinPos.push(p)

  const nodeTime = (p: number) => (p % 2 === 0 ? cues[p >> 1].startMs : cues[p >> 1].endMs)

  for (let z = 1; z < pinPos.length; z++) {
    const pL = pinPos[z - 1]
    const pR = pinPos[z]
    const tL = nodeTime(pL)
    const tR = nodeTime(pR)
    const span = tR - tL
    if (span < 0) {
      conflicts.push({
        rule: '锚点冲突',
        message: `${pinName(pL)}（${msToSrtTime(tL)}）晚于${pinName(pR)}（${msToSrtTime(tR)}），原稿时间本身倒置。请先修正原稿时间。`,
      })
      continue
    }

    // 区域跨越的 D 边（整条 cue）与 gap 边（e_i → b_{i+1}）
    const cuesIn: number[] = []
    let gaps = 0
    for (let p = pL; p < pR; p++) {
      if (p % 2 === 0) cuesIn.push(p >> 1)
      else gaps++ // 奇数位置发出 e_i → b_{i+1} 的间隔边
    }
    const gapNeed = gaps * gap

    // 时长下限（保守必要条件）：
    //   - 文字锁定条：字数固定；
    //   - 完全落在区域内的自由块：全部字符不能越过区域两端的时间锚点（时间锚点
    //     两侧的相对顺序固定），按集中装填给下界；
    //   - 跨区域边界的自由块：字符可推出区域，区域内每条至少 1 字。
    let durNeed = 0
    const seenBlock = new Set<number>()
    for (const i of cuesIn) {
      if (textLocked[i]) {
        durNeed += Math.ceil((1000 * (origCuts[i + 1] - origCuts[i])) / cps)
        continue
      }
      const bi = blockOf[i]
      if (seenBlock.has(bi)) continue
      seenBlock.add(bi)
      const bl = freeBlocks[bi]
      const members = cuesIn.filter((x) => blockOf[x] === bi)
      const i0 = Math.min(...members)
      const i1 = Math.max(...members)
      const m = i1 - i0 + 1
      if (bl.a >= i0 && bl.b <= i1) {
        const count = origCuts[bl.b + 1] - origCuts[bl.a]
        const packed = packedMinDur(count, m, maxLen, cps)
        if (packed !== null) durNeed += packed
      } else {
        durNeed += m * Math.ceil(1000 / cps)
      }
    }

    const need = durNeed + gapNeed
    if (span < need) {
      const diff = need - span
      if (cuesIn.length === 0) {
        conflicts.push({
          rule: '锚点冲突',
          message: `${pinName(pL)}（${msToSrtTime(tL)}）与${pinName(pR)}（${msToSrtTime(tR)}）互相冲突：两者间隔仅 ${span} ms，但相邻字幕间至少需要 ${gapNeed} ms 的提示间隔（${gaps} × ${gap} ms），还差 ${gapNeed - span} ms。请解除其中一个时间锚点，或调小最小间隔。`,
        })
      } else {
        const from = cuesIn[0] + 1
        const to = cuesIn[cuesIn.length - 1] + 1
        const rangeTxt = from === to ? `第 ${from} 条` : `第 ${from}–${to} 条`
        const lockedNote = cuesIn.some((i) => textLocked[i])
          ? '（其中文字锁定条目的字数不可改变，其余文字已按最集中方式装填）'
          : ''
        conflicts.push({
          rule: '锚点冲突',
          message: `${pinName(pL)}（${msToSrtTime(tL)}）与${pinName(pR)}（${msToSrtTime(tR)}）互相冲突：两锚点之间仅 ${span} ms，但 ${rangeTxt} 至少需要 ${durNeed} ms 展示时长${lockedNote}与 ${gapNeed} ms 间隔（共 ${need} ms），还差 ${diff} ms。请解除其中一个时间锚点、调大 CPS（放宽节奏下限）或调小最小间隔。`,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export function solve(cuesInput: SrtCue[], settings: Settings, locksArg?: AnchorLocks): SolveResult {
  const conflicts: Conflict[] = []
  const cues = cuesInput.map((c, i) => ({ ...c, index: i }))
  const n = cues.length

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

  // 2. 锚点锁定（首条开始 / 末条结束隐式钉死）
  const locks: AnchorLocks = {
    text: (locksArg?.text ?? []).map((v) => !!v),
    start: (locksArg?.start ?? []).map((v) => !!v),
    end: (locksArg?.end ?? []).map((v) => !!v),
  }
  while (locks.text.length < n) locks.text.push(false)
  while (locks.start.length < n) locks.start.push(false)
  while (locks.end.length < n) locks.end.push(false)
  const ld = buildLockData(n, origCuts, locks, MAX_LINES * settings.maxChars)

  // 3. 冲突预检
  const fixedStart = cues[0].startMs
  const fixedEnd = cues[n - 1].endMs
  const span = fixedEnd - fixedStart
  const minTotalDur = Math.ceil((1000 * N) / settings.cps)
  const minGapTotal = (n - 1) * settings.gapMs

  if (ld.hasLocks) {
    // 锚点模式：逐锚点区域报告具体冲突（含所需时长/间隔与差额）
    analyzeAnchorConflicts(cues, chars, origCuts, settings, ld, conflicts)
    if (conflicts.length) return { ok: false, conflicts }
  } else {
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
  }

  // 4. DP 上下文（与时长无关的部分）
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

  const baseCtx: DPContext = {
    n,
    N,
    chars,
    settings,
    durations: [],
    diffPref,
    nonSpacePrefix,
    validCache: new Map<number, boolean>(),
    origCuts,
    fixed: ld.fixed,
    textLocked: ld.textLocked,
    cutLo: ld.cutLo,
    cutHi: ld.cutHi,
  }

  // 预热：一次性计算自由块内所有可能段 [q,p) 的折行合法性（锁定段免检查）
  {
    const maxLen = MAX_LINES * settings.maxChars
    for (const bl of ld.freeBlocks) {
      for (let q = origCuts[bl.a]; q < origCuts[bl.b + 1]; q++) {
        for (let p = q + 1; p <= Math.min(origCuts[bl.b + 1], q + maxLen); p++) {
          segmentValid(baseCtx, q, p)
        }
      }
    }
  }

  // 时间优化结果按切点缓存（搜索中会反复评估相同构型；锚点钉死在本次求解内不变）
  const timingCache = new Map<string, TimingSolution | null>()
  const timingOf = (cutsArg: number[]): TimingSolution | null => {
    const key = cutsArg.join(',')
    if (timingCache.has(key)) return timingCache.get(key)!
    const t = optimizeTimingImpl(cues, cutsArg, settings, ld.pins)
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
  const startBest = bestBox.v
  if (startBest) {
    const rng = mulberry32(987654321)
    const stepMax = MAX_LINES * settings.maxChars
    const vctx: DPContext = { ...baseCtx, durations: [] }

    const cutsFeasible = (cs: number[]): boolean => {
      for (let i = 0; i < n; i++) if (!segmentValid(vctx, cs[i], cs[i + 1], i)) return false
      // 固定切点（文字锚点边界）不得移动
      for (let k = 1; k < n; k++) if (ld.fixed[k] && cs[k] !== origCuts[k]) return false
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
    // 仅自由切点（非文字锚点边界）可参与扰动
    const freeCutIdx: number[] = []
    for (let k = 1; k < n; k++) if (!ld.fixed[k]) freeCutIdx.push(k)
    const STEPS = n <= 12 ? 240 : n <= 20 ? 120 : 36
    for (let step = 0; step < STEPS && freeCutIdx.length > 0; step++) {
      const T = 600 * (1 - step / STEPS) + 10
      const cand = state.cuts.slice()
      const moveKind = rng()
      const pickIdx = () => freeCutIdx[Math.floor(rng() * freeCutIdx.length)]
      const pickDelta = () => {
        const mag = 1 + Math.floor(rng() * Math.min(stepMax, 1 + ((step % 4) + 1) * 3))
        return (rng() < 0.5 ? -1 : 1) * mag
      }
      if (moveKind < 0.55 || freeCutIdx.length < 2) {
        // 单切点平移
        cand[pickIdx()] += pickDelta()
      } else if (moveKind < 0.8) {
        // 相邻双切点同向同幅（中间条块平移；两切点须相邻且都自由）
        const pairs: Array<[number, number]> = []
        for (let k = 1; k < n - 1; k++)
          if (!ld.fixed[k] && !ld.fixed[k + 1]) pairs.push([k, k + 1])
        if (pairs.length === 0) {
          cand[pickIdx()] += pickDelta()
        } else {
          const [i, j2] = pairs[Math.floor(rng() * pairs.length)]
          const d = pickDelta()
          cand[i] += d
          cand[j2] += d
        }
      } else {
        // 两个随机自由切点独立扰动
        const i = pickIdx()
        const j = pickIdx()
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
        for (let k = 1; k < n; k++) if (ld.fixed[k] && cand[k] !== origCuts[k]) return
        for (let i = 0; i < n; i++) if (!segmentValid(vctx, cand[i], cand[i + 1], i)) return
        const t = timingOf(cand)
        if (!t) return
        if (t.moveMs < improvedCost) {
          improvedCost = t.moveMs
          improved = cand
          consider(cand, t)
        }
      }
      for (let i = 1; i < n; i++) {
        if (ld.fixed[i]) continue
        for (let d = -R; d <= R; d++) {
          if (d === 0) continue
          const cand = cur.slice()
          cand[i] += d
          tryCand(cand)
        }
      }
      if (n <= 20) for (let i = 1; i < n - 1; i++) {
        if (ld.fixed[i] || ld.fixed[i + 1]) continue
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

  // 5. 锚点模式下的兜底救援：预检通过但启发式未找到方案时，用原始时长做确定性
  //    断句 DP，再做一次时间优化；仍失败则按实际切点重算最紧的锚点区域冲突。
  if (!bestBox.v && ld.hasLocks) {
    const rescueCtx: DPContext = {
      ...baseCtx,
      durations: cues.map((c) => c.endMs - c.startMs),
    }
    const rescueCuts = optimizeCuts(rescueCtx)
    const rescueTiming = rescueCuts ? timingOf(rescueCuts) : null
    if (rescueCuts && rescueTiming) {
      consider(rescueCuts, rescueTiming)
    } else if (rescueCuts) {
      // 断句存在可行分配，但时间锚点钉不下：逐时间锚点区域按实际字数重算缺口
      const pinPos: number[] = []
      for (let p = 0; p < 2 * n; p++) if (ld.pins[p]) pinPos.push(p)
      const nodeTime = (p: number) => (p % 2 === 0 ? cues[p >> 1].startMs : cues[p >> 1].endMs)
      let worst: { diff: number; msg: string } | null = null
      for (let z = 1; z < pinPos.length; z++) {
        const pL = pinPos[z - 1]
        const pR = pinPos[z]
        const span2 = nodeTime(pR) - nodeTime(pL)
        const cuesIn: number[] = []
        let gaps = 0
        for (let p = pL; p < pR; p++) {
          if (p % 2 === 0) cuesIn.push(p >> 1)
          else gaps++
        }
        let need = gaps * settings.gapMs
        for (const i of cuesIn) need += Math.ceil((1000 * (rescueCuts[i + 1] - rescueCuts[i])) / settings.cps)
        const diff = need - span2
        if (diff > 0 && (!worst || diff > worst.diff)) {
          const rangeTxt =
            cuesIn.length === 1
              ? `第 ${cuesIn[0] + 1} 条`
              : `第 ${cuesIn[0] + 1}–${cuesIn[cuesIn.length - 1] + 1} 条`
          worst = {
            diff,
            msg: `${pinName(pL)}（${msToSrtTime(nodeTime(pL))}）与${pinName(pR)}（${msToSrtTime(nodeTime(pR))}）互相冲突：两锚点之间仅 ${span2} ms，但按实际可行断句，${rangeTxt} 至少需要 ${need - gaps * settings.gapMs} ms 时长与 ${gaps * settings.gapMs} ms 间隔（共 ${need} ms），还差 ${diff} ms。请解除其中一个时间锚点、调大 CPS 或调小最小间隔。`,
          }
        }
      }
      return {
        ok: false,
        conflicts: [
          {
            rule: '锚点冲突',
            message:
              worst?.msg ??
              '当前锚点锁定下找不到可行方案。请解除部分锚点（文字归属 / 开始 / 结束时间）后重试。',
          },
        ],
      }
    }
  }

  // 6. 组装结果
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
    const visibleLen = charsOf(segText.replace(/\s+/g, '')).length
    const dur = timing.ends[i] - timing.starts[i]
    if (ld.textLocked[i]) {
      // 文字归属锁定：逐字保留原始行（不重新折行），偏移按扁平文本顺序定位
      const rawLines = cues[i].lines
      const lines = rawLines.map((l) => l.trim()).filter(Boolean)
      const offsets: Array<[number, number]> = []
      let cursor = 0
      for (const ln of lines) {
        const probe = segText.indexOf(ln, cursor)
        const s = probe < 0 ? cursor : probe
        const e = s + charsOf(ln).length
        offsets.push([s, e])
        cursor = e
      }
      solvedCues.push({
        startMs: timing.starts[i],
        endMs: timing.ends[i],
        lines: rawLines,
        lineOffsets: offsets.length ? offsets : [[0, 0]],
        text: segText,
        dStart: timing.starts[i] - cues[i].startMs,
        dEnd: timing.ends[i] - cues[i].endMs,
        cpsActual: dur > 0 ? Math.round(((visibleLen * 1000) / dur) * 10) / 10 : 0,
        lockedText: true,
      })
      continue
    }
    const segChars = charsOf(segText)
    const lineOffsets = wrapOffsets(segText, settings.maxChars)
    const lines = lineOffsets.map(([s, e]) => segChars.slice(s, e).join(''))
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
    locks: {
      text: ld.textLocked.slice(),
      start: ld.startLocked.slice(),
      end: ld.endLocked.slice(),
    },
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
