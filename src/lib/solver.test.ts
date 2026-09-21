// 求解器正确性测试（非生产代码）：
//  - optimizeTimingImpl 与整数坐标暴力枚举的最优值逐案对照
//  - solve 与“枚举全部断句 × 每案最优时间”的全局最优对照
//  - 约束满足性、文字保持、起止钉死
//  - 无解冲突场景
import { parseSrt, SrtCue } from './srt'
import { solve, Settings, optimizeTimingImpl } from './solver'
import { charsOf, flattenCues, wrapText, isCJK } from './text'

let pass = 0
let fail = 0
function assert(cond: boolean, msg: string) {
  if (cond) pass++
  else {
    fail++
    console.error('  ✗ ' + msg)
  }
}
function approx(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps
}

// --- 暴力：给定 cuts，整数时间上的逐点 DP（前缀最小值），求最小移动量 ---
function bruteTiming(cues: SrtCue[], lengths: number[], s: Settings) {
  const n = cues.length
  const D = lengths.map((l) => Math.ceil((1000 * l) / s.cps))
  const B0 = cues[0].startMs
  const Eend = cues[n - 1].endMs
  // 位置：b0, e0, b1, e1, ..., b_{n-1}, e_{n-1}；间隔交替 D_i / gap
  const gaps: number[] = []
  const fixed: (number | null)[] = []
  const orig: number[] = []
  for (let i = 0; i < n; i++) {
    fixed.push(i === 0 ? B0 : null)
    orig.push(cues[i].startMs)
    gaps.push(D[i])
    fixed.push(i === n - 1 ? Eend : null)
    orig.push(cues[i].endMs)
    if (i < n - 1) gaps.push(s.gapMs)
  }
  const P = 2 * n
  let dp = new Map<number, number>()
  dp.set(B0, 0)
  for (let p = 1; p < P; p++) {
    const g = gaps[p - 1]
    const ndp = new Map<number, number>()
    // 对前一层做“≤ t−g”的滑动最小值
    const keys = [...dp.keys()].sort((a, b) => a - b)
    let pref = Infinity
    let ki = 0
    const tLo = p === P - 1 ? Eend : B0
    const tHi = p === P - 1 ? Eend : Eend
    for (let t = tLo; t <= tHi; t++) {
      while (ki < keys.length && keys[ki] <= t - g) {
        pref = Math.min(pref, dp.get(keys[ki])!)
        ki++
      }
      if (pref === Infinity) continue
      if (fixed[p] !== null && t !== fixed[p]) continue
      const cost = fixed[p] !== null ? 0 : Math.abs(t - orig[p])
      ndp.set(t, pref + cost)
    }
    dp = ndp
    if (dp.size === 0) return Infinity
  }
  const v = dp.get(Eend)
  return v ?? Infinity
}

// --- 暴力：枚举所有合法断句 cuts（0=c0<c1<...<cn=N），求每案最优时间 ---
// --- 暴力：枚举所有合法断句，记录最优 cuts 与移动量 ---
function bruteSolveDetailed(cues: SrtCue[], s: Settings): { cost: number; cuts: number[] | null } {
  const { text } = flattenCues(cues.map((c) => c.lines))
  const chars = charsOf(text)
  const N = chars.length
  const n = cues.length
  const maxLen = 2 * s.maxChars
  let globalBest = Infinity
  let bestCuts: number[] | null = null

  const valid = (q: number, p: number) => {
    if (p - q < 1 || p - q > maxLen) return false
    const seg = chars.slice(q, p).join('').trim()
    if (!seg) return false
    return wrapText(seg, s.maxChars).length <= 2
  }

  const cutsArr = [0]
  const rec = (i: number, start: number) => {
    if (i === n - 1) {
      if (!valid(start, N)) return
      const cuts = cutsArr.concat([N])
      const t = optimizeTimingImpl(cues, cuts, s)
      if (t && t.moveMs < globalBest) {
        globalBest = t.moveMs
        bestCuts = cuts
      }
      return
    }
    for (let p = start + 1; p <= N - (n - 1 - i); p++) {
      if (p - start > maxLen) break
      if (!valid(start, p)) continue
      cutsArr.push(p)
      rec(i + 1, p)
      cutsArr.pop()
    }
  }
  rec(0, 0)
  return { cost: globalBest, cuts: bestCuts }
}

function bruteSolve(cues: SrtCue[], s: Settings): number {
  return bruteSolveDetailed(cues, s).cost
}

function mkCue(s: number, e: number, lines: string[]): SrtCue {
  return { index: 0, startMs: s, endMs: e, lines }
}

console.log('== 时间优化 PAVA vs 暴力 ==')
{
  const rng = mulberry(42)
  let cases = 0
  for (let trial = 0; trial < 60; trial++) {
    const n = 2 + Math.floor(rng() * 3) // 2..4
    const cps = 8 + Math.floor(rng() * 15)
    const gap = [0, 40, 80, 120][Math.floor(rng() * 4)]
    // 随机字数与时间，保证有足够余量
    const lens: number[] = []
    let total = 0
    for (let i = 0; i < n; i++) {
      const l = 2 + Math.floor(rng() * 10)
      lens.push(l)
      total += l
    }
    const minSpan = Math.ceil((1000 * total) / cps) + (n - 1) * gap
    const span = minSpan + Math.floor(rng() * 2500)
    const cuts = [0]
    lens.forEach((l) => cuts.push(cuts[cuts.length - 1] + l))
    const start0 = 1000 + Math.floor(rng() * 2000)
    const cues: SrtCue[] = []
    for (let i = 0; i < n; i++) {
      const b = i === 0 ? start0 : start0 + Math.floor(rng() * span)
      const dur = 400 + Math.floor(rng() * 2200)
      const e = i === n - 1 ? start0 + span : Math.min(start0 + span, b + dur)
      cues.push(mkCue(Math.min(b, e - 100), Math.max(e, Math.min(b, e - 100) + 200), ['x']))
    }
    cues[0] = { ...cues[0], startMs: start0 }
    cues[n - 1] = { ...cues[n - 1], endMs: start0 + span }
    const s: Settings = { cps, maxChars: 40, gapMs: gap }
    const got = optimizeTimingImpl(cues, cuts, s)
    if (!got) {
      // 暴力也应不可行
      const brute = bruteTiming(cues, lens, s)
      assert(brute === Infinity, `trial ${trial}: PAVA 判不可行但暴力=${brute}`)
      continue
    }
    cases++
    const brute = bruteTiming(cues, lens, s)
    assert(approx(got.moveMs, brute), `trial ${trial}: moveMs=${got.moveMs} brute=${brute} (n=${n} cps=${cps} gap=${gap})`)
    // 约束校验
    for (let i = 0; i < n; i++) {
      assert(got.ends[i] - got.starts[i] >= Math.ceil((1000 * lens[i]) / cps) - 1e-6, `trial ${trial} cue ${i} 时长不足`)
      if (i > 0) assert(got.starts[i] - got.ends[i - 1] >= gap - 1e-6, `trial ${trial} cue ${i} 间隔不足`)
    }
    assert(got.starts[0] === cues[0].startMs && got.ends[n - 1] === cues[n - 1].endMs, `trial ${trial} 起止未钉死`)
  }
  console.log(`  (${cases} 个可行案例完成)`)
}

console.log('== 全局 solve vs 全断句枚举 ==')
{
  const rng = mulberry(7)
  for (let trial = 0; trial < 25; trial++) {
    const n = 2 + Math.floor(rng() * 3)
    const cps = 6 + Math.floor(rng() * 10)
    const gap = [0, 60, 120][Math.floor(rng() * 3)]
    const maxChars = 4 + Math.floor(rng() * 4)
    // 生成 CJK 文本（可任意断）
    const totalChars = n * 2 + Math.floor(rng() * (n * 4))
    let txt = ''
    for (let k = 0; k < totalChars; k++) txt += String.fromCharCode(0x4e00 + Math.floor(rng() * 1500))
    // 随机切成 n 条
    const bounds = [0]
    while (bounds.length < n) {
      const p = 1 + Math.floor(rng() * (totalChars - 1))
      if (!bounds.includes(p)) bounds.push(p)
    }
    bounds.sort((a, b) => a - b)
    bounds.push(totalChars)
    const minSpan = Math.ceil((1000 * totalChars) / cps) + (n - 1) * gap
    const span = minSpan + Math.floor(rng() * 1500)
    const start0 = 5000
    const cues: SrtCue[] = []
    for (let i = 0; i < n; i++) {
      const b = i === 0 ? start0 : start0 + Math.floor(rng() * span)
      const e =
        i === n - 1
          ? start0 + span
          : Math.min(start0 + span, Math.min(b, start0 + span - 100) + 300 + Math.floor(rng() * 1200))
      const bb = Math.min(b, e - 100)
      cues.push(mkCue(bb, Math.max(e, bb + 200), [txt.slice(bounds[i], bounds[i + 1])]))
    }
    cues[0] = { ...cues[0], startMs: start0 }
    cues[n - 1] = { ...cues[n - 1], endMs: start0 + span }
    const s: Settings = { cps, maxChars, gapMs: gap }
    const res = solve(cues, s)
    const brute = bruteSolve(cues, s)
    if (res.ok) {
      assert(approx(res.metrics.timeMoveMs, brute), `trial ${trial}: solve=${res.metrics.timeMoveMs} brute=${brute} (n=${n},cps=${cps},mc=${maxChars},gap=${gap})`)
      if (!approx(res.metrics.timeMoveMs, brute)) {
        const bd = bruteSolveDetailed(cues, s)
        const lens = (cs: number[]) => cs.slice(1).map((p, k) => p - cs[k])
        console.log(`    ours cuts=${JSON.stringify(res.newCuts)} lens=${JSON.stringify(lens(res.newCuts))}`)
        console.log(`    brute cuts=${JSON.stringify(bd.cuts)} lens=${JSON.stringify(lens(bd.cuts!))}`)
        console.log(`    orig cues=${JSON.stringify(cues.map((c) => [c.startMs, c.endMs, c.lines[0]]))}`)
      }
      // 文字完全保持
      const joined = res.cues.map((c) => c.text).join('')
      assert(joined === txt, `trial ${trial}: 文字被改动`)
      // 约束
      res.cues.forEach((c, i) => {
        const len = charsOf(c.text).length
        assert(c.endMs - c.startMs + 1e-6 >= Math.ceil((1000 * len) / cps), `trial ${trial} cue ${i} CPS 违反`)
        c.lines.forEach((l) => assert(charsOf(l).length <= maxChars, `trial ${trial} cue ${i} 行超长`))
        assert(c.lines.length <= 2, `trial ${trial} cue ${i} 超过两行`)
        if (i > 0) assert(c.startMs - res.cues[i - 1].endMs + 1e-6 >= gap, `trial ${trial} cue ${i} 间隔违反`)
      })
    } else {
      assert(brute === Infinity, `trial ${trial}: solve 判无解但暴力=${brute}`)
    }
  }
}

console.log('== 无解冲突：间隔耗尽总跨度 ==')
{
  const cues = [
    mkCue(0, 400, ['一二三四五六']),
    mkCue(400, 900, ['abcdefgh']),
  ]
  const res = solve(cues, { cps: 20, maxChars: 40, gapMs: 1000 })
  assert(!res.ok, '跨度 900ms、gap 1000 应无解')
  if (!res.ok) assert(res.conflicts.some((c) => c.rule.includes('间隔')), '应报告间隔冲突')
}

console.log('== 无解冲突：CPS 过严 ==')
{
  const cues = [
    mkCue(0, 300, ['一二三四五六七八九十']),
    mkCue(300, 500, ['一二三四五六七八九十']),
  ]
  const res = solve(cues, { cps: 2, maxChars: 40, gapMs: 0 })
  assert(!res.ok && res.conflicts.some((c) => c.rule.includes('字符数')), '20字/2字每秒需10000ms，跨度500应报 CPS 冲突')
}

console.log('== 无解冲突：容量不足 ==')
{
  const cues = [mkCue(0, 10000, ['一二三四五六七八九十十一十二十三十四十五十六十七十八十九二十'])]
  const res = solve(cues, { cps: 2, maxChars: 5, gapMs: 0 })
  assert(!res.ok && res.conflicts.some((c) => c.rule.includes('单行字数')), '1条×2行×5字容不下22字')
}

console.log('== 已有可行原稿应 0 移动 ==')
{
  const cues = [
    mkCue(0, 1000, ['一二三四']),
    mkCue(1200, 2200, ['五六七八']),
  ]
  const res = solve(cues, { cps: 10, maxChars: 20, gapMs: 120 })
  assert(res.ok && res.metrics.timeMoveMs === 0, '原稿已满足约束时时间移动应为 0')
}

console.log('== wrapText / 中英展平 ==')
{
  assert(wrapText('一二三四五六', 3).every((l) => charsOf(l).length <= 3), 'CJK 折行行长')
  assert(wrapText('一二三四五六', 3).length === 2, 'CJK 折行行数')
  const w = wrapText('hello world foobar', 8)
  assert(w.every((l) => charsOf(l).length <= 8), '英文词感知折行行长')
  assert(w.join(' ').replace(/\s+/g, ' ') === 'hello world foobar', '英文折行不丢词')
  const { text } = flattenCues([['hello'], ['world']])
  assert(text === 'hello world', '被切开的英文词重新拼接')
  const cjk = flattenCues([['你好'], ['世界']])
  assert(cjk.text === '你好世界', '中文拼接不插空格')
  void isCJK
}

console.log('== 规模上限 n=30 性能与约束 ==')
{
  const rng = mulberry(123)
  const n = 30
  const cps = 15
  const gap = 80
  const maxChars = 16
  const cues: SrtCue[] = []
  let total = 0
  const segs: string[] = []
  for (let i = 0; i < n; i++) {
    const l = 8 + Math.floor(rng() * 20)
    total += l
    let s = ''
    for (let k = 0; k < l; k++) s += String.fromCodePoint(0x4e00 + Math.floor(rng() * 2000))
    segs.push(s)
  }
  const span = Math.ceil((1000 * total) / cps) + (n - 1) * gap + 4000
  const start0 = 10000
  for (let i = 0; i < n; i++) {
    const b = i === 0 ? start0 : start0 + Math.floor((span * i) / n)
    const e = i === n - 1 ? start0 + span : b + 400 + Math.floor(rng() * 1500)
    cues.push(mkCue(b, e, [segs[i]]))
  }
  cues[0] = { ...cues[0], startMs: start0 }
  cues[n - 1] = { ...cues[n - 1], endMs: start0 + span }
  const t0 = Date.now()
  const res = solve(cues, { cps, maxChars, gapMs: gap })
  const dt = Date.now() - t0
  assert(res.ok, `n=30 应可解`)
  if (res.ok) {
    assert(dt < 5000, `n=30 求解应在 5s 内，实际 ${dt}ms`)
    assert(res.cues[0].startMs === start0 && res.cues[n - 1].endMs === start0 + span, 'n=30 起止钉死')
    const rejoined = res.cues.map((c) => c.text).join('')
    assert(rejoined === segs.join(''), 'n=30 文字完整保持')
    let validAll = true
    res.cues.forEach((c, i) => {
      const len = charsOf(c.text).length
      if (c.endMs - c.startMs < Math.ceil((1000 * len) / cps) - 1e-6) validAll = false
      if (c.lines.length > 2 || c.lines.some((l) => charsOf(l).length > maxChars)) validAll = false
      if (i > 0 && c.startMs - res.cues[i - 1].endMs + 1e-6 < gap) validAll = false
    })
    assert(validAll, 'n=30 全部约束满足')
    console.log(`  求解耗时 ${dt}ms，时间移动 ${res.metrics.timeMoveMs}ms`)
  }
}

console.log('== SRT 往返 ==')
{
  const raw = '1\n00:00:01,500 --> 00:00:02,500\nhello\nworld\n\n2\n00:00:03.000 --> 00:00:04.000\nfoo\n'
  const { cues } = parseSrt(raw)
  assert(cues.length === 2 && cues[0].startMs === 1500 && cues[0].lines[1] === 'world', 'SRT 解析（逗号/点毫秒、多行）')
}

function mulberry(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
