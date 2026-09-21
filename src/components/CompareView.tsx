import { AnchorLocks, SolveOk } from '../lib/solver'
import { SrtCue, msToSrtTime } from '../lib/srt'
import { charsOf } from '../lib/text'

function Delta({ ms, locked }: { ms: number; locked?: boolean }) {
  if (locked)
    return (
      <span className="delta locked" title="该时间边界已锁定，求解中保持不变">
        🔒
      </span>
    )
  if (ms === 0) return <span className="delta zero">±0</span>
  const sign = ms > 0 ? '+' : '−'
  return (
    <span className="delta moved">
      {sign}
      {Math.abs(ms)}ms
    </span>
  )
}

/** 逐字符渲染：归属发生变化的字符加高亮（空格不高亮）；文字锁定条整体不高亮 */
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

function LockBadges({ locks, i }: { locks: AnchorLocks; i: number }) {
  const items: string[] = []
  if (locks.text[i]) items.push('🔒文字')
  if (locks.start[i]) items.push('🔒开始')
  if (locks.end[i]) items.push('🔒结束')
  if (items.length === 0) return null
  return (
    <span className="lock-badges" title="本条目锚点已锁定，求解与导出均严格保持">
      {items.map((t) => (
        <span key={t} className="lock-badge">
          {t}
        </span>
      ))}
    </span>
  )
}

export default function CompareView({
  origCues,
  result,
  locks,
}: {
  origCues: SrtCue[]
  result: SolveOk
  locks: AnchorLocks
}) {
  const chars = charsOf(result.text)

  // 原稿列：按原始切点分段，移动判定 = origOwner ≠ newOwner（文字锁定条不参与移动）
  const origColumns = origCues.map((_, i) => {
    const q = result.origCuts[i]
    const p = result.origCuts[i + 1]
    const seg = chars.slice(q, p)
    const movedAt = seg.map((_, j) => {
      const g = q + j
      return !locks.text[i] && !result.insertedSpace[g] && result.origOwner[g] !== result.newOwner[g]
    })
    return { seg, movedAt }
  })

  // 结果列：按新切点分段，再按各行偏移显式换行；文字锁定条直接展示原始行
  const newColumns = result.cues.map((cue, i) => {
    const segMoved = (g: number) =>
      !locks.text[i] && !result.insertedSpace[g] && result.origOwner[g] !== result.newOwner[g]
    return { cue, segMoved, i }
  })

  return (
    <div className="compare">
      {/* 原稿列 */}
      <div>
        <div className="col-head">原稿（黄色 = 将被移走的文字；🔒 = 已锁定）</div>
        <div className="col-body">
          {origCues.map((c, i) => (
            <div className={`cue-card${locks.text[i] ? ' locked' : ''}`} key={i}>
              <div className="meta">
                <span className="time">
                  {msToSrtTime(c.startMs)} <Delta ms={0} locked={locks.start[i]} /> →{' '}
                  {msToSrtTime(c.endMs)} <Delta ms={0} locked={locks.end[i]} />
                </span>
                <span>
                  #{i + 1} <LockBadges locks={locks} i={i} />
                </span>
              </div>
              {locks.text[i] ? (
                <div className="body">
                  {c.lines.map((ln, li) => (
                    <div key={li} className="locked-line">
                      {ln}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="body">
                  <HighlightedChars
                    chars={origColumns[i].seg}
                    movedAt={origColumns[i].movedAt}
                    keyBase={`o${i}`}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 结果列 */}
      <div>
        <div className="col-head">修复结果（黄色 = 跨条移动的文字，蓝色 = 时间移动，🔒 = 锁定保持）</div>
        <div className="col-body">
          {newColumns.map(({ cue, segMoved, i }) => (
            <div className={`cue-card new${locks.text[i] ? ' locked' : ''}`} key={i}>
              <div className="meta">
                <span className="time">
                  {msToSrtTime(cue.startMs)}
                  <Delta ms={cue.dStart} locked={locks.start[i]} /> → {msToSrtTime(cue.endMs)}
                  <Delta ms={cue.dEnd} locked={locks.end[i]} />
                </span>
                <span>
                  #{i + 1} <span className="cps-tag">{cue.cpsActual} 字/秒</span>
                  <LockBadges locks={locks} i={i} />
                </span>
              </div>
              {locks.text[i] ? (
                <div className="body">
                  {cue.lines.map((ln, li) => (
                    <div key={li} className="locked-line">
                      {ln}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="body">
                  {(() => {
                    const q = result.newCuts[i]
                    const p = result.newCuts[i + 1]
                    const seg = chars.slice(q, p)
                    return cue.lineOffsets.map(([ls, le], li) => {
                      const lineSeg = seg.slice(ls, le)
                      const movedAt = lineSeg.map((_, j) => segMoved(q + ls + j))
                      return (
                        <div key={li}>
                          <HighlightedChars
                            chars={lineSeg}
                            movedAt={movedAt}
                            keyBase={`n${i}-${li}`}
                          />
                        </div>
                      )
                    })
                  })()}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
