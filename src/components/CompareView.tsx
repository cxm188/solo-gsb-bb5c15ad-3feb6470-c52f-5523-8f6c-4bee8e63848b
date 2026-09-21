import { CueLock, SolveOk } from '../lib/solver'
import { SrtCue, msToSrtTime } from '../lib/srt'
import { charsOf } from '../lib/text'

function Delta({ ms }: { ms: number }) {
  if (ms === 0) return <span className="delta zero">±0</span>
  const sign = ms > 0 ? '+' : '−'
  return (
    <span className="delta moved">
      {sign}
      {Math.abs(ms)}ms
    </span>
  )
}

/** 锚点锁定标记：🔒文字 / 🔒开始 / 🔒结束 */
function LockTags({ lk }: { lk?: CueLock }) {
  if (!lk || (!lk.text && !lk.start && !lk.end)) return null
  return (
    <>
      {lk.text && <span className="lock-tag">🔒文字</span>}
      {lk.start && <span className="lock-tag">🔒开始</span>}
      {lk.end && <span className="lock-tag">🔒结束</span>}
    </>
  )
}

/** 逐字符渲染：归属发生变化的字符加高亮（空格不高亮） */
function HighlightedChars({
  chars,
  movedAt,
  keyBase,
}: {
  chars: string[]
  /** 相对本片段的布尔数组：该字符是否跨条移动 */
  movedAt: boolean[]
  keyBase: string
}) {
  return (
    <>
      {chars.map((ch, j) =>
        movedAt[j] ? (
          <span key={`${keyBase}-${j}`} className="ch-moved">
            {ch}
          </span>
        ) : (
          <span key={`${keyBase}-${j}`}>{ch}</span>
        )
      )}
    </>
  )
}

export default function CompareView({
  origCues,
  result,
  locks,
}: {
  origCues: SrtCue[]
  result: SolveOk
  /** 与 origCues 下标对齐的锚点锁定 */
  locks?: Array<CueLock | undefined>
}) {
  const chars = charsOf(result.text)

  // 原稿列：按原始切点分段，移动判定 = origOwner ≠ newOwner
  const origColumns = origCues.map((_, i) => {
    const q = result.origCuts[i]
    const p = result.origCuts[i + 1]
    const seg = chars.slice(q, p)
    const movedAt = seg.map((_, j) => {
      const g = q + j
      return !result.insertedSpace[g] && result.origOwner[g] !== result.newOwner[g]
    })
    return { seg, movedAt }
  })

  // 结果列：按新切点分段，再按各行偏移显式换行
  const newColumns = result.cues.map((cue, i) => {
    const q = result.newCuts[i]
    const p = result.newCuts[i + 1]
    const seg = chars.slice(q, p)
    const movedAt = seg.map((_, j) => {
      const g = q + j
      return !result.insertedSpace[g] && result.origOwner[g] !== result.newOwner[g]
    })
    return { cue, seg, movedAt }
  })

  return (
    <div className="compare">
      {/* 原稿列 */}
      <div>
        <div className="col-head">原稿（黄色 = 将被移走的文字，🔒 = 锚点锁定）</div>
        <div className="col-body">
          {origCues.map((c, i) => (
            <div className="cue-card" key={i}>
              <div className="meta">
                <span className="time">
                  {msToSrtTime(c.startMs)} → {msToSrtTime(c.endMs)}
                </span>
                <span>
                  #{i + 1}
                  <LockTags lk={locks?.[i]} />
                </span>
              </div>
              <div className="body">
                <HighlightedChars
                  chars={origColumns[i].seg}
                  movedAt={origColumns[i].movedAt}
                  keyBase={`o${i}`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 结果列 */}
      <div>
        <div className="col-head">修复结果（黄色 = 跨条移动的文字，蓝色 = 时间移动，🔒 = 锁定保持）</div>
        <div className="col-body">
          {newColumns.map(({ cue, seg, movedAt }, i) => {
            const lk = locks?.[i]
            return (
              <div className="cue-card new" key={i}>
                <div className="meta">
                  <span className="time">
                    {msToSrtTime(cue.startMs)}
                    {lk?.start ? <span className="delta locked">🔒锁定</span> : <Delta ms={cue.dStart} />}
                    {' → '}
                    {msToSrtTime(cue.endMs)}
                    {lk?.end ? <span className="delta locked">🔒锁定</span> : <Delta ms={cue.dEnd} />}
                  </span>
                  <span>
                    #{i + 1} <span className="cps-tag">{cue.cpsActual} 字/秒</span>
                    {lk?.text && <span className="lock-tag">🔒文字</span>}
                  </span>
                </div>
                <div className="body">
                  {cue.lineOffsets.map(([ls, le], li) => (
                    <div key={li}>
                      <HighlightedChars
                        chars={seg.slice(ls, le)}
                        movedAt={movedAt.slice(ls, le)}
                        keyBase={`n${i}-${li}`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
