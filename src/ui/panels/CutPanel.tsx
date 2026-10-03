/**
 * ②カット：自動カット候補の確認と適用（設計書 7.5）。
 */
import { useEffect, useRef, useState } from 'react'
import * as ops from '../../core/project/ops'
import type { Suggestion } from '../../core/project/types'
import { sourceRangeToTimeline } from '../../core/time/time'
import { ja } from '../../i18n/ja'
import { seek } from '../../playback/controller'
import { cutParams, recomputeSuggestions } from '../../store/jobs'
import { edit, useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { fmtTime } from '../timeline/draw'

export function CutPanel() {
  const project = useProject((s) => s.project)!
  const analysis = useSession((s) => s.analysis)
  const selected = useSession((s) => s.selectedSuggestion)
  const [params, setParams] = useState({ ...cutParams })
  const listRef = useRef<HTMLUListElement>(null)

  const pending = project.suggestions
    .filter((s) => s.status === 'pending')
    .map((s) => ({
      s,
      at: sourceRangeToTimeline(project.videoTrack, s.assetId, s.sourceStart, s.sourceEnd),
    }))
    .filter((x) => x.at.length > 0)
    .sort((a, b) => a.at[0]!.start - b.at[0]!.start)
  const deletable = pending.filter((x) => x.s.kind !== 'highlight')
  const anyDone = Object.values(analysis).some((a) => a.status === 'done')

  useEffect(() => {
    listRef.current?.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const update = (patch: Partial<typeof params>) => {
    const next = { ...params, ...patch }
    setParams(next)
    Object.assign(cutParams, next)
    recomputeSuggestions()
  }

  const kindLabel = (s: Suggestion) => ja.cut[s.kind]
  const removedSec = deletable.reduce(
    (sum, x) => sum + x.at.reduce((a, r) => a + r.end - r.start, 0),
    0,
  )

  return (
    <div className="panel">
      <p className="hint">{ja.stepHints.cut}</p>
      <fieldset className="mode">
        <legend>モード</legend>
        {(['game', 'talk'] as const).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name="cutmode"
              checked={project.mode === m}
              onChange={() => {
                edit(ops.setMode, m)
                recomputeSuggestions()
              }}
            />
            {ja.modes[m].label}
          </label>
        ))}
      </fieldset>
      {project.mode === 'talk' ? (
        <label className="slider">
          {ja.cut.tightness}：<b>{params.minSilence.toFixed(1)} 秒</b>
          <input
            type="range"
            min={0.3}
            max={2}
            step={0.1}
            value={params.minSilence}
            onChange={(e) => update({ minSilence: Number(e.target.value) })}
          />
        </label>
      ) : (
        <>
          <label className="slider">
            {ja.cut.sensitivity}：<b>+{params.thresholdDb} dB</b>
            <input
              type="range"
              min={3}
              max={12}
              step={1}
              value={params.thresholdDb}
              onChange={(e) => update({ thresholdDb: Number(e.target.value) })}
            />
          </label>
          <label className="slider">
            {ja.cut.target}
            <input
              type="number"
              min={0}
              step={1}
              value={params.targetMinutes}
              onChange={(e) => update({ targetMinutes: Math.max(0, Number(e.target.value)) })}
            />
          </label>
        </>
      )}
      <div className="row">
        <button type="button" onClick={() => recomputeSuggestions()} disabled={!anyDone}>
          {ja.cut.recompute}
        </button>
        <button
          type="button"
          className="primary"
          disabled={deletable.length === 0}
          title="すべての削除候補をまとめて適用します（元に戻すで1回で戻せます）"
          onClick={() =>
            edit(
              ops.applySuggestions,
              deletable.map((x) => x.s.id),
            )
          }
        >
          {ja.cut.applyAll}（{deletable.length}件・{fmtTime(removedSec)}）
        </button>
      </div>
      <p className="muted small">N / Shift+N で候補を移動、Enter で削除、Backspace で残す。</p>
      {!anyDone && <p className="muted">{ja.cut.waiting}</p>}
      {anyDone && pending.length === 0 && <p className="muted">{ja.cut.none}</p>}
      <ul className="suggestions" ref={listRef}>
        {pending.map(({ s, at }) => {
          const start = at[0]!.start
          const len = at.reduce((a, r) => a + r.end - r.start, 0)
          return (
            <li
              key={s.id}
              className={`sug kind-${s.kind}${s.id === selected ? ' is-selected' : ''}`}
              onClick={() => {
                useSession.setState({ selectedSuggestion: s.id })
                seek(Math.max(0, start - 2))
              }}
            >
              <span className="sug-kind">{kindLabel(s)}</span>
              <span className="sug-time">
                {fmtTime(start)}〜（{len.toFixed(1)}秒）
              </span>
              <span className="sug-score" title="スコア">
                {Math.round(s.score * 100)}
              </span>
              {s.kind !== 'highlight' ? (
                <span className="sug-actions">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      edit(ops.applySuggestions, [s.id])
                    }}
                  >
                    {ja.cut.accept}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      edit(ops.rejectSuggestions, [s.id])
                    }}
                  >
                    {ja.cut.reject}
                  </button>
                </span>
              ) : (
                <span className="sug-actions muted small">残す場面</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
