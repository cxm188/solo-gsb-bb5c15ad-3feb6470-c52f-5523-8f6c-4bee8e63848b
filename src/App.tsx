import { useCallback, useMemo, useState } from 'react'
import CompareView from './components/CompareView'
import { formatSrt, msToSrtTime, parseSrt, SrtCue } from './lib/srt'
import { solve, SolveResult, MAX_SELECTION, Settings } from './lib/solver'
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

  const runSolve = () => {
    if (!range) return
    const r = solve(selectedCues, settings)
    setResult(r)
    setConfirmed(false)
  }

  const exportSrt = () => {
    if (!result || !result.ok || !range) return
    // 用修复结果替换选区，其余条保持原样；序号统一重排
    const all = parsed.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, lines: c.lines }))
    const fixed = result.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, lines: c.lines }))
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
          导入 SRT → 选择至多 {MAX_SELECTION} 条连续字幕 → 设置节奏参数 → 最小化边界移动量求解。
          文字内容与顺序、片段总起止时间保持不变，所有数据仅保存在本浏览器。
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
          <button className="ghost" onClick={() => { persistSource(SAMPLE_SRT); persistRange(null); setParseWarnings([]) }}>
            载入示例
          </button>
          {parsed.cues.length > 0 && (
            <button
              className="ghost"
              onClick={() => {
                clearAll()
                setSource('')
                persistRange(null)
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
            {parsed.cues.map((c, i) => (
              <div
                key={i}
                className={`cue-row${range && i >= range[0] && i <= range[1] ? ' selected' : ''}`}
                onClick={() => toggleCue(i)}
              >
                <span className="idx">{i + 1}</span>
                <span className="t">
                  {msToSrtTime(c.startMs)} → {msToSrtTime(c.endMs)}
                </span>
                <span>{c.lines.join(' ')}</span>
              </div>
            ))}
          </div>
          {range && (
            <p className="hint" style={{ marginTop: 8 }}>
              已选第 {range[0] + 1} – {range[1] + 1} 条（共 {range[1] - range[0] + 1} 条）；片段起止固定为{' '}
              {msToSrtTime(parsed.cues[range[0]].startMs)} – {msToSrtTime(parsed.cues[range[1]].endMs)}
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
            <p className="hint">按提示放宽对应参数后重新求解即可。</p>
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
          </div>
          <CompareView origCues={selectedCues} result={result} />
          <div className="row" style={{ marginTop: 14 }}>
            <button onClick={exportSrt}>确认并导出 fixed.srt</button>
            <button className="ghost" onClick={runSolve}>重新求解</button>
            {confirmed && <span className="badge good">已导出</span>}
            <span className="hint">导出文件包含全部字幕：选区替换为修复结果，选区外保持原样并重排序号。</span>
          </div>
        </section>
      )}
    </div>
  )
}
