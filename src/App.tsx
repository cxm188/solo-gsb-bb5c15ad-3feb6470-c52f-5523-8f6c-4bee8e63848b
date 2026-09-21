import { useCallback, useMemo, useState } from 'react'
import CompareView from './components/CompareView'
import { formatSrt, msToSrtTime, parseSrt, SrtCue } from './lib/srt'
import { solve, SolveResult, MAX_SELECTION, Settings, CueLock } from './lib/solver'
import { loadJSON, saveJSON, STORAGE_KEYS, clearAll } from './lib/storage'
import { SAMPLE_SRT } from './lib/sample'

type Range = [number, number] | null

const DEFAULT_SETTINGS: Settings = { cps: 17, maxChars: 18, gapMs: 120 }

export default function App() {
  const [source, setSource] = useState<string>(() => loadJSON<string>(STORAGE_KEYS.source) ?? '')
  const [range, setRange] = useState<Range>(() => loadJSON<[number, number]>(STORAGE_KEYS.selection))
  const [settings, setSettings] = useState<Settings>(() => ({
    ...DEFAULT_SETTINGS,
    ...(loadJSON<Partial<Settings>>(STORAGE_KEYS.settings) ?? {}),
  }))
  // 锚点锁定：按全局字幕序号存储；修改选区/参数后保留，重新导入字幕时清空
  const [locks, setLocks] = useState<Record<number, CueLock>>(
    () => loadJSON<Record<number, CueLock>>(STORAGE_KEYS.locks) ?? {}
  )
  const [result, setResult] = useState<SolveResult | null>(null)
  const [parseWarnings, setParseWarnings] = useState<string[]>([])
  const [confirmed, setConfirmed] = useState(false)

  const parsed = useMemo(() => (source ? parseSrt(source) : { cues: [], warnings: [] }), [source])

  const persistSource = useCallback((v: string) => {
    setSource(v)
    saveJSON(STORAGE_KEYS.source, v)
  }, [])

  const persistRange = useCallback((r: Range) => {
    setRange(r)
    setResult(null)
    setConfirmed(false)
    if (r) saveJSON(STORAGE_KEYS.selection, r)
    else localStorage.removeItem(STORAGE_KEYS.selection)
  }, [])

  const persistSettings = useCallback((s: Settings) => {
    setSettings(s)
    saveJSON(STORAGE_KEYS.settings, s)
    setResult(null)
    setConfirmed(false)
  }, [])

  const persistLocks = useCallback((next: Record<number, CueLock>) => {
    setLocks(next)
    saveJSON(STORAGE_KEYS.locks, next)
    setResult(null)
    setConfirmed(false)
  }, [])

  const toggleLock = useCallback(
    (idx: number, kind: keyof CueLock) => {
      const cur = locks[idx] ?? {}
      const updated: CueLock = { ...cur, [kind]: !cur[kind] }
      const next = { ...locks }
      if (!updated.text && !updated.start && !updated.end) delete next[idx]
      else next[idx] = updated
      persistLocks(next)
    },
    [locks, persistLocks]
  )

  const onFile = async (file: File) => {
    const text = await file.text()
    const r = parseSrt(text)
    setParseWarnings(r.warnings)
    persistSource(text)
    persistRange(null)
    persistLocks({})
    setResult(null)
  }

  const selectedCues: SrtCue[] = useMemo(() => {
    if (!range) return []
    return parsed.cues.slice(range[0], range[1] + 1)
  }, [parsed.cues, range])

  // 选区内各条的锁定（与 selectedCues 下标对齐）
  const selectionLocks: Array<CueLock | undefined> = useMemo(() => {
    if (!range) return []
    return selectedCues.map((_, k) => locks[range[0] + k])
  }, [selectedCues, locks, range])

  const lockCount = Object.keys(locks).length
  const selLockCount = selectionLocks.filter((l) => l && (l.text || l.start || l.end)).length

  const runSolve = () => {
    if (!range) return
    const r = solve(selectedCues, settings, selectionLocks)
    setResult(r)
    setConfirmed(false)
  }

  const exportSrt = () => {
    if (!result || !result.ok || !range) return
    // 防御性校验：求解结果不得违反任何锁定（求解器已保证，此处兜底中止）
    for (let k = 0; k < result.cues.length; k++) {
      const lk = locks[range[0] + k]
      const orig = parsed.cues[range[0] + k]
      const c = result.cues[k]
      if (!lk || !orig) continue
      if (
        (lk.start && c.startMs !== orig.startMs) ||
        (lk.end && c.endMs !== orig.endMs) ||
        (lk.text && c.text !== orig.lines.map((l) => l.trim()).filter(Boolean).join(' '))
      ) {
        alert('求解结果违反了锚点锁定，已中止导出。请重新求解。')
        return
      }
    }
    // 用修复结果替换选区，其余条保持原样；序号统一重排。
    // 锁定项严格使用原始值：锁定文字导出原始行，锁定时间导出原始毫秒。
    const all = parsed.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, lines: c.lines }))
    const fixed = result.cues.map((c, k) => {
      const lk = locks[range[0] + k]
      const orig = parsed.cues[range[0] + k]
      return {
        startMs: lk?.start ? orig.startMs : c.startMs,
        endMs: lk?.end ? orig.endMs : c.endMs,
        lines: lk?.text ? orig.lines : c.lines,
      }
    })
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

  return (
    <div className="app">
      <header className="app-header">
        <h1>字幕节奏修复</h1>
        <p className="sub">
          导入 SRT → 选择至多 {MAX_SELECTION} 条连续字幕 → 设置节奏参数（可选锚点锁定）→ 最小化边界移动量求解。
          文字内容与顺序、片段总起止时间及锁定项保持不变，所有数据仅保存在本浏览器。
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
          <button className="ghost" onClick={() => { persistSource(SAMPLE_SRT); persistRange(null); persistLocks({}); setParseWarnings([]) }}>
            载入示例
          </button>
          {parsed.cues.length > 0 && (
            <button
              className="ghost"
              onClick={() => {
                clearAll()
                setSource('')
                persistRange(null)
                persistLocks({})
                setResult(null)
                setParseWarnings([])
              }}
            >
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

      {/* 第二步：选择连续字幕 */}
      {parsed.cues.length > 0 && (
        <section className="panel">
          <h2>
            <span className="step-num">2</span>
            选择连续字幕（点击条目扩展/收缩选区，最多 {MAX_SELECTION} 条）
          </h2>
          <div className="cue-picker">
            {parsed.cues.map((c, i) => {
              const inRange = !!range && i >= range[0] && i <= range[1]
              const lk = locks[i]
              return (
                <div
                  key={i}
                  className={`cue-row${inRange ? ' selected' : ''}`}
                  onClick={() => toggleCue(i)}
                >
                  <span className="idx">{i + 1}</span>
                  <span className="t">
                    {msToSrtTime(c.startMs)} → {msToSrtTime(c.endMs)}
                  </span>
                  <span>{c.lines.join(' ')}</span>
                  <span className="lock-cell" onClick={(e) => e.stopPropagation()}>
                    {inRange ? (
                      <>
                        <button
                          type="button"
                          className={`lock-btn${lk?.text ? ' on' : ''}`}
                          title="锁定文字归属：该条文字保持原样，不参与跨条断句调整"
                          onClick={() => toggleLock(i, 'text')}
                        >
                          文
                        </button>
                        <button
                          type="button"
                          className={`lock-btn${lk?.start ? ' on' : ''}`}
                          title="锁定开始时间：该条开始时间保持原值"
                          onClick={() => toggleLock(i, 'start')}
                        >
                          始
                        </button>
                        <button
                          type="button"
                          className={`lock-btn${lk?.end ? ' on' : ''}`}
                          title="锁定结束时间：该条结束时间保持原值"
                          onClick={() => toggleLock(i, 'end')}
                        >
                          终
                        </button>
                      </>
                    ) : (
                      lk && (
                        <span className="lock-tags" title="该条仍有锁定，但不在当前选区内，本次求解不生效">
                          {lk.text && <span className="lock-tag">文</span>}
                          {lk.start && <span className="lock-tag">始</span>}
                          {lk.end && <span className="lock-tag">终</span>}
                        </span>
                      )
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          {range && (
            <p className="hint" style={{ marginTop: 8 }}>
              已选第 {range[0] + 1} – {range[1] + 1} 条（共 {range[1] - range[0] + 1} 条）；片段起止固定为{' '}
              {msToSrtTime(parsed.cues[range[0]].startMs)} – {msToSrtTime(parsed.cues[range[1]].endMs)}
              {selLockCount > 0 && `；选区内 ${selLockCount} 条已设锚点锁定`}
            </p>
          )}
          {parsed.cues.length > 0 && (
            <p className="hint" style={{ marginTop: 4 }}>
              锚点锁定：选区内每行右侧「文 / 始 / 终」分别锁定该条的文字归属、开始时间、结束时间（再点取消）。
              锁定项在求解与导出时严格保持原值；修改选区或参数后锁定仍保留（仅选区内的锁定参与求解），重新导入字幕后自动清空。
              {lockCount > 0 && (
                <>
                  {' '}当前共 {lockCount} 条已锁定。
                  <button className="ghost" style={{ marginLeft: 8, padding: '2px 10px' }} onClick={() => persistLocks({})}>
                    清除全部锁定
                  </button>
                </>
              )}
            </p>
          )}
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
            <p className="hint">按提示放宽对应参数、解除或调整冲突的锚点锁定后重新求解即可。</p>
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
              <span className="sw sw-lock" /> 🔒 标记：锚点锁定项（求解与导出均严格保持原值）
            </span>
          </div>
          <CompareView origCues={selectedCues} result={result} locks={selectionLocks} />
          <div className="row" style={{ marginTop: 14 }}>
            <button onClick={exportSrt}>确认并导出 fixed.srt</button>
            <button className="ghost" onClick={runSolve}>重新求解</button>
            {confirmed && <span className="badge good">已导出</span>}
            <span className="hint">导出文件包含全部字幕：选区替换为修复结果，选区外保持原样并重排序号；锁定项严格保持原文字与原时间。</span>
          </div>
        </section>
      )}
    </div>
  )
}
