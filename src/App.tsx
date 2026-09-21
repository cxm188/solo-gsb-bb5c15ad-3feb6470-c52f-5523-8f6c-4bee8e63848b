import { useCallback, useMemo, useState } from 'react'
import CompareView from './components/CompareView'
import { formatSrt, msToSrtTime, parseSrt, SrtCue } from './lib/srt'
import { solve, SolveResult, MAX_SELECTION, Settings, AnchorLocks } from './lib/solver'
import { loadJSON, saveJSON, STORAGE_KEYS, clearAll } from './lib/storage'
import { SAMPLE_SRT } from './lib/sample'

type Range = [number, number] | null
type LockKind = 'text' | 'start' | 'end'

/** 全局锚点锁定：按字幕在原文件中的序号存储，选区变化后仍有效的锁定自动保留 */
interface LockStore {
  text: number[]
  start: number[]
  end: number[]
}

const EMPTY_LOCKS: LockStore = { text: [], start: [], end: [] }

const DEFAULT_SETTINGS: Settings = { cps: 17, maxChars: 18, gapMs: 120 }

function LockSummary({ range, locksStore }: { range: Range; locksStore: LockStore }) {
  const inRange = (i: number) => !!range && i >= range[0] && i <= range[1]
  const nt = locksStore.text.filter(inRange).length
  const ns = locksStore.start.filter((i) => inRange(i) && i !== range![0]).length
  const ne = locksStore.end.filter((i) => inRange(i) && i !== range![1]).length
  const total = nt + ns + ne
  if (total === 0) return null
  return (
    <span className="hint lock-summary">
      已锁定 {total} 个锚点（
      {nt > 0 && `文字 ×${nt} `}
      {ns > 0 && `开始 ×${ns} `}
      {ne > 0 && `结束 ×${ne}`}）
    </span>
  )
}

export default function App() {
  const [source, setSource] = useState<string>(() => loadJSON<string>(STORAGE_KEYS.source) ?? '')
  const [range, setRange] = useState<Range>(() => loadJSON<[number, number]>(STORAGE_KEYS.selection))
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...(loadJSON<Partial<Settings>>(STORAGE_KEYS.settings) ?? {}),
  }))
  const [locksStore, setLocksStore] = useState<LockStore>(
    () => loadJSON<LockStore>(STORAGE_KEYS.locks) ?? EMPTY_LOCKS
  )
  const [result, setResult] = useState<SolveResult | null>(null)
  const [parseWarnings, setParseWarnings] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)

  const parsed = useMemo(() => (source ? parseSrt(source) : { cues: [], warnings: [] }), [source])

  const persistSource = useCallback((v: string) => {
    setSource(v)
    saveJSON(STORAGE_KEYS.source, v)
  }, [])

  const persistLocks = useCallback((v: LockStore) => {
    setLocksStore(v)
    saveJSON(STORAGE_KEYS.locks, v)
    setResult(null)
    setConfirmed(false)
  }, [])

  const persistRange = useCallback(
    (r: Range) => {
      setRange(r)
      setResult(null)
      setConfirmed(false)
      if (r) {
        saveJSON(STORAGE_KEYS.selection, r)
        // 收缩选区时丢弃选区外的锁定；扩展选区保留仍有效的锁定
        const inRange = (idx: number) => idx >= r![0] && idx <= r![1]
        persistLocks({
          text: locksStore.text.filter(inRange),
          start: locksStore.start.filter(inRange),
          end: locksStore.end.filter(inRange),
        })
      } else {
        localStorage.removeItem(STORAGE_KEYS.selection)
        persistLocks(EMPTY_LOCKS)
      }
    },
    [locksStore, persistLocks]
  )

  const persistSettings = useCallback((s: Settings) => {
    setSettings(s)
    saveJSON(STORAGE_KEYS.settings, s)
    setResult(null)
    setConfirmed(false)
  }, [])

  const clearSource = () => {
    clearAll()
    setSource('')
    persistRange(null)
    setResult(null)
    setParseWarnings([])
  }

  const onFile = async (file: File) => {
    const text = await file.text()
    const r = parseSrt(text)
    setParseWarnings(r.warnings)
    persistSource(text)
    persistRange(null)
    setResult(null)
  }

  const selectedCues: SrtCue[] = useMemo(() => {
    if (!range) return []
    return parsed.cues.slice(range[0], range[1] + 1)
  }, [parsed.cues, range])

  /** 当前选区生效的锁定（相对选区的下标数组；首条开始/末条结束隐式锁定） */
  const activeLocks: AnchorLocks = useMemo(() => {
    const n = range ? range[1] - range[0] + 1 : 0
    const has = (arr: number[], i: number) => (range ? arr.includes(range[0] + i) : false)
    return {
      text: Array.from({ length: n }, (_, i) => has(locksStore.text, i)),
      start: Array.from({ length: n }, (_, i) => has(locksStore.start, i)),
      end: Array.from({ length: n }, (_, i) => has(locksStore.end, i)),
    }
  }, [range, locksStore])

  const runSolve = () => {
    if (!range) return
    const r = solve(selectedCues, settings, activeLocks)
    setResult(r)
    setConfirmed(false)
  }

  const exportSrt = () => {
    if (!result || !result.ok || !range) return
    // 用修复结果替换选区，其余条保持原样；序号统一重排
    const all = parsed.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, lines: c.lines }))
    const fixed = result.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, lines: c.lines }))

    // 防御性校验：锁定的文字与时间必须与原稿逐项一致（正常求解下恒成立）
    for (let i = 0; i < fixed.length; i++) {
      const gi = range[0] + i
      if (activeLocks.text[i]) {
        const a = parsed.cues[gi].lines.join('\n')
        const b = fixed[i].lines.join('\n')
        if (a !== b) {
          alert(`导出校验失败：第 ${gi + 1} 条的文字锁定内容被改动，请重新求解。`)
          return
        }
      }
      if (activeLocks.start[i] && fixed[i].startMs !== parsed.cues[gi].startMs) {
        alert(`导出校验失败：第 ${gi + 1} 条的开始时间锁定未保持，请重新求解。`)
        return
      }
      if (activeLocks.end[i] && fixed[i].endMs !== parsed.cues[gi].endMs) {
        alert(`导出校验失败：第 ${gi + 1} 条的结束时间锁定未保持，请重新求解。`)
        return
      }
    }

    all.splice(range[0], range[1] - range[0] + 1, ...fixed)
    const blob = new Blob([formatSrt(all)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'fixed.srt'
    a.click()
    URL.revokeObjectURL(url)
    setConfirmed(true)
  }

  const toggleCue = (idx: number) => {
    if (!range) {
      persistRange([idx, idx])
      return
    }
    const [a, b] = range
    if (idx >= a && idx <= b) {
      // 点已选条目：单条则取消，否则收缩到该端
      if (a === b) persistRange(null)
      else if (idx === a) persistRange([a + 1, b])
      else if (idx === b) persistRange([a, b - 1])
      else persistRange([a, idx])
    } else {
      // 向近端扩展，限制最多 MAX_SELECTION 条且必须连续
      const distA = Math.abs(idx - a)
      const distB = Math.abs(idx - b)
      let na: number, nb: number
      if (idx < a) [na, nb] = distA <= distB ? [idx, b] : [a, idx]
      else [na, nb] = distB <= distA ? [a, idx] : [idx, b]
      if (nb - na + 1 > MAX_SELECTION) {
        alert(`最多选择连续的 ${MAX_SELECTION} 条字幕`)
        return
      }
      persistRange([na, nb])
    }
  }

  const toggleLock = (globalIdx: number, kind: LockKind) => {
    const arr = locksStore[kind]
    const next = arr.includes(globalIdx) ? arr.filter((x) => x !== globalIdx) : [...arr, globalIdx]
    persistLocks({ ...locksStore, [kind]: next })
  }

  const inSelection = (i: number) => !!range && i >= range[0] && i <= range[1]

  const LOCK_META: Array<{ kind: LockKind; title: string; label: string }> = [
    { kind: 'text', title: '锁定文字归属：该条文字不进不出', label: '文' },
    { kind: 'start', title: '锁定开始时间：该条开始边界不动', label: '始' },
    { kind: 'end', title: '锁定结束时间：该条结束边界不动', label: '终' },
  ]

  return (
    <div className="app">
      <header className="app-header">
        <h1>字幕节奏修复</h1>
        <p className="sub">
          导入 SRT → 选择至多 {MAX_SELECTION} 条连续字幕 → 设置节奏参数（可锁定文字/开始/结束锚点）→
          最小化边界移动量求解。文字内容与顺序、片段总起止时间保持不变，所有数据仅保存在本浏览器。
        </p>
      </header>

      {/* 第一步：导入 */}
      <section className="panel">
        <h2>
          <span className="step-num">1</span>导入 SRT
        </h2>
        <div className="row">
          <label className="field">
            <span className="hint">选择本地 .srt 文件</span>
            <input
              type="file"
              accept=".srt,text/plain"
              onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
            />
          </label>
          <button
            className="ghost"
            onClick={() => {
              persistSource(SAMPLE_SRT)
              persistRange(null)
              setParseWarnings([])
            }}
          >
            载入示例
          </button>
          {parsed.cues.length > 0 && (
            <button className="ghost" onClick={clearSource}>
              清空
            </button>
          )}
          <span className="hint">
            {parsed.cues.length > 0 && `已解析 ${parsed.cues.length} 条字幕`}
          </span>
        </div>
        {parseWarnings.length > 0 && (
          <p className="hint" style={{ color: 'var(--warn)', marginTop: 8 }}>
            解析提示：{parseWarnings.join('；')}
          </p>
        )}
      </section>

      {/* 第二步：选择连续字幕 + 锚点锁定 */}
      {parsed.cues.length > 0 && (
        <section className="panel">
          <h2>
            <span className="step-num">2</span>
            选择连续字幕并锁定锚点（点击条目扩展/收缩选区，最多 {MAX_SELECTION} 条）
          </h2>
          <div className="cue-picker">
            {parsed.cues.map((c, i) => {
              const selected = inSelection(i)
              const implicitStart = range !== null && i === range[0]
              const implicitEnd = range !== null && i === range[1]
              return (
                <div
                  key={i}
                  className={`cue-row${selected ? ' selected' : ''}${
                    locksStore.text.includes(i) ||
                    locksStore.start.includes(i) ||
                    locksStore.end.includes(i)
                      ? ' has-lock'
                      : ''
                  }`}
                  onClick={() => toggleCue(i)}
                >
                  <span className="idx">{i + 1}</span>
                  <span className="t">
                    {msToSrtTime(c.startMs)} → {msToSrtTime(c.endMs)}
                  </span>
                  <span className="cue-text">{c.lines.join(' ')}</span>
                  <span className="locks" onClick={(e) => e.stopPropagation()}>
                    {LOCK_META.map(({ kind, title, label }) => {
                      const implicit = (kind === 'start' && implicitStart) || (kind === 'end' && implicitEnd)
                      const on = locksStore[kind].includes(i)
                      return (
                        <button
                          key={kind}
                          className={`lock-btn${on || implicit ? ' on' : ''}${implicit ? ' implicit' : ''}`}
                          title={implicit ? `${title}（片段端点始终固定）` : title}
                          disabled={implicit || !selected}
                          onClick={() => toggleLock(i, kind)}
                        >
                          {implicit ? '🔒' : on ? '🔒' : ''}
                          {label}
                        </button>
                      )
                    })}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            {range && (
              <span className="hint">
                已选第 {range[0] + 1} – {range[1] + 1} 条（共 {range[1] - range[0] + 1} 条）；片段起止固定为{' '}
                {msToSrtTime(parsed.cues[range[0]].startMs)} – {msToSrtTime(parsed.cues[range[1]].endMs)}
              </span>
            )}
            {range && <LockSummary range={range} locksStore={locksStore} />}
            {(locksStore.text.length + locksStore.start.length + locksStore.end.length) > 0 && (
              <button
                className="ghost small"
                onClick={() => persistLocks(EMPTY_LOCKS)}
              >
                解除全部锁定
              </button>
            )}
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            🔒
            <strong>文</strong> = 锁定该条文字归属（断句不进不出）；<strong>始/终</strong>
            = 锁定开始/结束时间。选区首条开始与末条结束始终固定。修改选区或参数后，仍有效的锁定会保留。
          </p>
        </section>
      )}

      {/* 第三步：参数 */}
      {range && (
        <section className="panel">
          <h2>
            <span className="step-num">3</span>节奏参数
          </h2>
          <div className="row">
            <label className="field">
              <label>每秒字符数（CPS 上限）</label>
              <input
                type="number"
                min={1}
                max={60}
                step={1}
                value={settings.cps}
                onChange={(e) => persistSettings({ ...settings, cps: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <label>单行字数上限</label>
              <input
                type="number"
                min={1}
                max={80}
                step={1}
                value={settings.maxChars}
                onChange={(e) => persistSettings({ ...settings, maxChars: Number(e.target.value) })}
              />
            </label>
            <label className="field">
              <label>最小提示间隔（毫秒）</label>
              <input
                type="number"
                min={0}
                max={5000}
                step={10}
                value={settings.gapMs}
                onChange={(e) => persistSettings({ ...settings, gapMs: Number(e.target.value) })}
              />
            </label>
            <div style={{ alignSelf: 'flex-end' }}>
              <button onClick={runSolve}>求最小移动方案</button>
            </div>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            每条字幕最多 2 行；时长不短于「字数 ÷ CPS」；相邻两条之间（前一条结束到后一条开始）至少保留指定毫秒间隔。
            求解器会在保持全部锁定项不变的前提下，联合调整其余断句与时间边界。
          </p>
        </section>
      )}

      {/* 第四步：结果 */}
      {result && !result.ok && (
        <section className="panel">
          <div className="conflicts">
            <h3>无解：以下规则相互冲突（共 {result.conflicts.length} 项）</h3>
            <ul>
              {result.conflicts.map((cf, i) => (
                <li key={i}>
                  <span className="rule">【{cf.rule}】</span> {cf.message}
                </li>
              ))}
            </ul>
            <p className="hint">按提示解除冲突锚点或放宽对应参数后重新求解即可。</p>
          </div>
        </section>
      )}

      {result?.ok && (
        <section className="panel">
          <h2>
            <span className="step-num">4</span>原稿 与 修复结果
          </h2>
          <div className="metrics">
            <div className="metric">
              <div className="v">{result.metrics.timeMoveMs.toLocaleString()} ms</div>
              <div className="k">时间边界总移动量</div>
            </div>
            <div className="metric">
              <div className="v">{result.metrics.charMove.toLocaleString()}</div>
              <div className="k">文字移动量（字符×跨条数）</div>
            </div>
            <div className="metric">
              <div className="v">{result.metrics.movedCharCount}</div>
              <div className="k">发生跨条移动的字符数</div>
            </div>
          </div>
          <div className="legend">
            <span>
              <span className="sw sw-text" /> 黄色底纹：跨条移动的文字
            </span>
            <span>
              <span className="sw sw-time" /> 蓝色标签：该时间边界移动的毫秒数
            </span>
            <span>
              <span className="sw sw-lock" /> 🔒 / 紫框：锚点锁定项（求解与导出均严格保持）
            </span>
          </div>
          <CompareView origCues={selectedCues} result={result} locks={activeLocks} />
          <div className="row" style={{ marginTop: 14 }}>
            <button onClick={exportSrt}>确认并导出 fixed.srt</button>
            <button className="ghost" onClick={runSolve}>重新求解</button>
            {confirmed && <span className="badge good">已导出</span>}
            <span className="hint">导出文件包含全部字幕：选区替换为修复结果，选区外保持原样并重排序号；锁定的文字与时间逐字逐毫秒保持。</span>
          </div>
        </section>
      )}
    </div>
  )
}
