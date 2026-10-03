/**
 * プレビュー（設計書 6.2・11.1）。
 */
import { useEffect, useMemo, useRef } from 'react'
import { totalDuration } from '../../core/time/time'
import { mountPlayer, pause, play, seek, unmountPlayer, getPlayer } from '../../playback/controller'
import { cues, duckCurve, gains } from '../../store/derived'
import { useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { ja } from '../../i18n/ja'
import { fmtTime } from '../timeline/draw'

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const project = useProject((s) => s.project)
  const urls = useSession((s) => s.urls)
  const analysis = useSession((s) => s.analysis)
  const bgm = useSession((s) => s.bgm)
  const playing = useSession((s) => s.playing)
  const playhead = useSession((s) => s.playhead)
  const previewRes = useSession((s) => s.previewRes)
  const reduced = useSession((s) => s.previewReduced)
  const exporting = useSession((s) => s.job?.kind === 'export')

  useEffect(() => {
    if (!canvasRef.current) return
    mountPlayer(canvasRef.current)
    return () => unmountPlayer()
  }, [])

  const bgmBuffers = useMemo(
    () => Object.fromEntries(Object.entries(bgm).map(([k, v]) => [k, v.buffer])),
    [bgm],
  )
  const scale = previewRes === 'half' || (previewRes === 'auto' && reduced) ? 0.5 : 1

  useEffect(() => {
    const pl = getPlayer()
    if (!pl || !project) return
    const g = gains(project, { analysis, bgm })
    pl.update({
      project,
      urls,
      cues: cues(project),
      duck: duckCurve(project, analysis),
      voiceDb: g.voiceDb,
      bgmDb: g.bgmDb,
      bgmBuffers,
      scale,
    })
  }, [project, urls, analysis, bgm, bgmBuffers, scale])

  // 書き出し中はプレビューを止める（設計書 10.3）
  useEffect(() => {
    if (exporting && playing) pause()
  }, [exporting, playing])

  if (!project) return null
  const total = totalDuration(project.videoTrack)

  return (
    <section className="preview" aria-label="プレビュー">
      <div className="preview-stage">
        <canvas
          ref={canvasRef}
          className="preview-canvas"
          style={{ aspectRatio: `${project.output.width} / ${project.output.height}` }}
        />
        {exporting && <div className="preview-cover">{ja.exp.keepTab}</div>}
      </div>
      <div className="preview-bar">
        <button
          type="button"
          className="play"
          onClick={() => (playing ? pause() : play(1))}
          disabled={total <= 0 || exporting}
          title="Space"
        >
          {playing ? `❚❚ ${ja.preview.pause}` : `▶ ${ja.preview.play}`}
        </button>
        <span className="timecode">
          {fmtTime(playhead, true)} / {fmtTime(total, true)}
        </span>
        <input
          className="seekbar"
          type="range"
          min={0}
          max={Math.max(0.01, total)}
          step={0.01}
          value={Math.min(playhead, total)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="再生位置"
        />
        <label className="res">
          {ja.preview.res}
          <select
            value={previewRes}
            onChange={(e) =>
              useSession.setState({ previewRes: e.target.value as 'auto' | 'full' | 'half' })
            }
          >
            <option value="auto">
              {ja.preview.auto}
              {reduced ? '（1/2）' : ''}
            </option>
            <option value="full">{ja.preview.full}</option>
            <option value="half">{ja.preview.half}</option>
          </select>
        </label>
      </div>
    </section>
  )
}
