/**
 * ③字幕：文字起こし（設計書 8.1・8.3）、ワンボタン字幕（8.4）、字幕の一覧とスタイル（8.5）。
 */
import { useEffect, useState } from 'react'
import * as ops from '../../core/project/ops'
import type { SubtitleStyle } from '../../core/project/types'
import { charsPerSecond, MAX_CHARS_PER_SEC } from '../../core/subtitles/split'
import { sourceRangeToTimeline, sourceToTimeline, timelineToSource } from '../../core/time/time'
import { ASR_MODELS, type AsrModelKey } from '../../config'
import { ja } from '../../i18n/ja'
import { seek } from '../../playback/controller'
import { generateSubtitles, transcribe, webGpuAvailable } from '../../store/jobs'
import { edit, editCoalesced, useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { STYLE_PRESETS } from '../../render/subtitles'
import { fmtTime } from '../timeline/draw'

const DOWNLOADED_KEY = 've.asr.downloaded'

function downloaded(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DOWNLOADED_KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}

export function SubtitlesPanel() {
  const project = useProject((s) => s.project)!
  const transcripts = useSession((s) => s.transcripts)
  const job = useSession((s) => s.job)
  const playhead = useSession((s) => s.playhead)
  const selectedSub = useSession((s) => s.selectedSubtitle)
  const [model, setModel] = useState<AsrModelKey>('standard')
  const [scope, setScope] = useState<'kept' | 'all'>('kept')
  const [dropPeriod, setDropPeriod] = useState(true)
  const [gpu, setGpu] = useState<boolean | null>(null)

  useEffect(() => {
    void webGpuAvailable().then(setGpu)
  }, [])

  const start = async () => {
    const m = ASR_MODELS[model]
    if (!downloaded().includes(m.id) && !confirm(ja.subs.download(m.sizeMb))) return
    try {
      localStorage.setItem(DOWNLOADED_KEY, JSON.stringify([...downloaded(), m.id]))
    } catch {
      /* 保存できなくても続ける */
    }
    await transcribe(model, scope)
  }

  const segs = Object.entries(transcripts).flatMap(([assetId, list]) =>
    list.map((s, i) => ({ assetId, i, s })),
  )
  const subs = [...project.subtitles]
    .map((s) => ({
      s,
      t:
        sourceToTimeline(project, s.assetId, s.sourceStart) ??
        sourceRangeToTimeline(project.videoTrack, s.assetId, s.sourceStart, s.sourceEnd)[0]
          ?.start ??
        null,
    }))
    .sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity))
  const style = project.subtitleStyle
  const setStyle = (patch: Partial<SubtitleStyle>) =>
    editCoalesced('style', ops.setSubtitleStyle, patch)

  return (
    <div className="panel">
      <p className="hint">{ja.stepHints.subtitles}</p>

      <section className="box">
        <h3>文字起こし</h3>
        <label>
          {ja.subs.model}
          <select value={model} onChange={(e) => setModel(e.target.value as AsrModelKey)}>
            {(Object.keys(ASR_MODELS) as AsrModelKey[]).map((k) => (
              <option key={k} value={k} disabled={ASR_MODELS[k].needsGpu && gpu === false}>
                {ASR_MODELS[k].label}・約{ASR_MODELS[k].sizeMb}MB
                {ASR_MODELS[k].needsGpu ? '・GPU 必須' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          {ja.subs.scope}
          <select value={scope} onChange={(e) => setScope(e.target.value as 'kept' | 'all')}>
            <option value="kept">{ja.subs.scopeKept}</option>
            <option value="all">{ja.subs.scopeAll}</option>
          </select>
        </label>
        {gpu === false && <p className="warn small">{ja.subs.noGpu}</p>}
        <button
          type="button"
          className="primary"
          onClick={start}
          disabled={!!job || project.videoTrack.length === 0}
        >
          {ja.subs.transcribe}
        </button>
      </section>

      <section className="box">
        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => generateSubtitles(dropPeriod)}
            disabled={segs.length === 0}
          >
            {ja.subs.generate}
          </button>
          <label className="small">
            <input
              type="checkbox"
              checked={dropPeriod}
              onChange={(e) => setDropPeriod(e.target.checked)}
            />
            {ja.subs.dropPeriod}
          </label>
        </div>
        {segs.length === 0 ? (
          <p className="muted small">{ja.subs.transcriptEmpty}</p>
        ) : (
          <ul className="transcript">
            {segs.map(({ assetId, i, s }) => {
              const ranges = sourceRangeToTimeline(project.videoTrack, assetId, s.start, s.end)
              const cut = ranges.length === 0
              const at = ranges[0]?.start
              const active =
                at != null && playhead >= at && playhead < (ranges[ranges.length - 1]?.end ?? at)
              return (
                <li
                  key={`${assetId}-${i}`}
                  className={`${cut ? 'is-cut' : ''}${active ? ' is-active' : ''}`}
                >
                  <button
                    type="button"
                    className="link small"
                    disabled={at == null}
                    onClick={() => at != null && seek(at)}
                  >
                    {at != null ? fmtTime(at) : 'カット済み'}
                  </button>
                  <input
                    value={s.text}
                    aria-label="文字起こしのテキスト"
                    onChange={(e) => {
                      const list = [...(useSession.getState().transcripts[assetId] ?? [])]
                      list[i] = { ...list[i]!, text: e.target.value }
                      useSession.setState({
                        transcripts: { ...useSession.getState().transcripts, [assetId]: list },
                      })
                    }}
                  />
                  {!cut && (
                    <button
                      type="button"
                      className="small"
                      onClick={() => edit(ops.cutSourceRange, assetId, s.start, s.end)}
                    >
                      {ja.subs.cutThis}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="box">
        <h3>{ja.subs.list}</h3>
        <div className="row">
          <button
            type="button"
            className="small"
            onClick={() => {
              const hit = timelineToSource(project, useSession.getState().playhead)
              if (!hit) return
              edit(ops.addSubtitle, {
                assetId: hit.assetId,
                sourceStart: hit.sourceTime,
                sourceEnd: Math.min(hit.clip.sourceOut, hit.sourceTime + 2),
                text: '字幕',
              })
            }}
          >
            {ja.subs.add}
          </button>
        </div>
        <ul className="sublist">
          {subs.map(({ s, t }) => {
            const fast = charsPerSecond(s) > MAX_CHARS_PER_SEC
            return (
              <li
                key={s.id}
                className={`${t == null ? 'is-cut' : ''}${s.id === selectedSub ? ' is-selected' : ''}`}
              >
                <button
                  type="button"
                  className="link small"
                  disabled={t == null}
                  onClick={() => {
                    useSession.setState({ selectedSubtitle: s.id })
                    if (t != null) seek(t)
                  }}
                >
                  {t != null ? fmtTime(t) : 'カット済み'}
                </button>
                <textarea
                  rows={Math.min(3, s.text.split('\n').length)}
                  value={s.text}
                  aria-label="字幕のテキスト"
                  onChange={(e) =>
                    editCoalesced(`sub-${s.id}`, ops.updateSubtitle, s.id, { text: e.target.value })
                  }
                />
                {fast && (
                  <span className="warn" title={ja.subs.fast}>
                    ⚠
                  </span>
                )}
                <span className="sub-actions">
                  <button
                    type="button"
                    className="small"
                    title={ja.subs.split}
                    onClick={() => {
                      const hit = timelineToSource(project, useSession.getState().playhead)
                      if (hit?.assetId === s.assetId) edit(ops.splitSubtitle, s.id, hit.sourceTime)
                    }}
                  >
                    分
                  </button>
                  <button
                    type="button"
                    className="small"
                    title={ja.subs.merge}
                    onClick={() => edit(ops.mergeSubtitleWithNext, s.id)}
                  >
                    結
                  </button>
                  <button
                    type="button"
                    className="small"
                    title={ja.subs.delete}
                    onClick={() => edit(ops.deleteSubtitle, s.id)}
                  >
                    ✕
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="box">
        <h3>{ja.subs.style}</h3>
        <div className="row">
          {STYLE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="small"
              onClick={() => edit(ops.setSubtitleStyle, p.style)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid2">
          <label>
            太さ
            <select
              value={style.fontWeight}
              onChange={(e) => setStyle({ fontWeight: Number(e.target.value) as 400 | 700 | 900 })}
            >
              <option value={400}>標準</option>
              <option value={700}>太字</option>
              <option value={900}>極太</option>
            </select>
          </label>
          <label>
            位置
            <select
              value={style.position}
              onChange={(e) => setStyle({ position: e.target.value as 'top' | 'bottom' })}
            >
              <option value="bottom">下</option>
              <option value="top">上</option>
            </select>
          </label>
          <label>
            大きさ
            <input
              type="range"
              min={0.03}
              max={0.1}
              step={0.005}
              value={style.sizeRatio}
              onChange={(e) => setStyle({ sizeRatio: Number(e.target.value) })}
            />
          </label>
          <label>
            縁取り
            <input
              type="range"
              min={0}
              max={0.25}
              step={0.01}
              value={style.outlineRatio}
              onChange={(e) => setStyle({ outlineRatio: Number(e.target.value) })}
            />
          </label>
          <label>
            文字の色
            <input
              type="color"
              value={style.color}
              onChange={(e) => setStyle({ color: e.target.value })}
            />
          </label>
          <label>
            縁の色
            <input
              type="color"
              value={style.outlineColor}
              onChange={(e) => setStyle({ outlineColor: e.target.value })}
            />
          </label>
          <label>
            1行の文字数
            <input
              type="number"
              min={8}
              max={40}
              value={style.maxCharsPerLine}
              onChange={(e) =>
                setStyle({ maxCharsPerLine: Math.max(8, Math.min(40, Number(e.target.value))) })
              }
            />
          </label>
          <label>
            最大行数
            <select
              value={style.maxLines}
              onChange={(e) => setStyle({ maxLines: Number(e.target.value) as 1 | 2 })}
            >
              <option value={1}>1行</option>
              <option value={2}>2行</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={style.box}
              onChange={(e) => setStyle({ box: e.target.checked })}
            />
            半透明の帯
          </label>
        </div>
      </section>
    </div>
  )
}
