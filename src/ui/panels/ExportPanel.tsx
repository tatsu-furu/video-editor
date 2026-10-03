/**
 * ⑤書き出し：出力設定（設計書 10.1）、MP4・SRT の書き出し、プロジェクト JSON、キャッシュ。
 */
import { useEffect, useState } from 'react'
import { totalDuration } from '../../core/time/time'
import { ja } from '../../i18n/ja'
import {
  DEFAULT_EXPORT,
  download,
  exportSrt,
  exportVideo,
  outputSize,
  type ExportSettings,
} from '../../store/jobs'
import { useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { cacheUsage, clearCache } from '../../storage/opfs'
import { fmtTime } from '../timeline/draw'

export function ExportPanel() {
  const project = useProject((s) => s.project)!
  const job = useSession((s) => s.job)
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT)
  const [usage, setUsage] = useState<number | null>(null)
  const total = totalDuration(project.videoTrack)
  const size = outputSize(project, settings)
  const set = (patch: Partial<ExportSettings>) => setSettings({ ...settings, ...patch })

  useEffect(() => {
    void cacheUsage().then(setUsage)
  }, [])

  return (
    <div className="panel">
      <p className="hint">{ja.stepHints.export}</p>
      <div className="grid2">
        <label>
          {ja.exp.resolution}
          <select
            value={settings.resolution}
            onChange={(e) => set({ resolution: e.target.value as ExportSettings['resolution'] })}
          >
            <option value="source">
              {ja.exp.source}（{project.output.width}×{project.output.height}）
            </option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
          </select>
        </label>
        <label>
          {ja.exp.fps}
          <select
            value={String(settings.fps)}
            onChange={(e) =>
              set({
                fps: e.target.value === 'source' ? 'source' : (Number(e.target.value) as 30 | 60),
              })
            }
          >
            <option value="source">
              {ja.exp.source}（{project.output.fps}）
            </option>
            <option value="60">60</option>
            <option value="30">30</option>
          </select>
        </label>
        <label>
          {ja.exp.quality}
          <select
            value={settings.quality}
            onChange={(e) => set({ quality: e.target.value as ExportSettings['quality'] })}
          >
            <option value="high">{ja.exp.high}</option>
            <option value="standard">{ja.exp.standard}</option>
            <option value="light">{ja.exp.light}</option>
          </select>
        </label>
        <label>
          {ja.exp.subtitles}
          <select
            value={settings.burnSubtitles ? 'on' : 'off'}
            onChange={(e) => set({ burnSubtitles: e.target.value === 'on' })}
          >
            <option value="on">{ja.exp.burn}</option>
            <option value="off">{ja.exp.noBurn}</option>
          </select>
        </label>
      </div>
      <p className="muted small">
        {size.width}×{size.height}・{size.fps}fps・H.264 / AAC・長さ {fmtTime(total)}
      </p>
      <button
        type="button"
        className="primary big"
        disabled={!!job || total <= 0}
        onClick={() => exportVideo(settings)}
      >
        MP4 を{ja.exportButton}
      </button>
      {job?.kind === 'export' && <p className="warn">{ja.exp.keepTab}</p>}
      <button type="button" onClick={exportSrt} disabled={project.subtitles.length === 0}>
        {ja.exp.srt}
      </button>

      <section className="box">
        <h3>プロジェクト</h3>
        <button
          type="button"
          className="small"
          onClick={() =>
            download(
              new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' }),
              `${project.name}.json`,
            )
          }
        >
          {ja.exp.projectJson}
        </button>
        <p className="muted small">
          素材のファイルは含まれません。読み込んだあとで素材を選び直してください。
        </p>
      </section>

      <section className="box">
        <h3>{ja.exp.cache}</h3>
        <p className="muted small">
          解析結果と文字起こしの途中経過を、ブラウザ内に保存しています。
          {usage != null && `使用量：${(usage / 1e6).toFixed(1)} MB`}
        </p>
        <button
          type="button"
          className="small"
          disabled={!!job}
          onClick={async () => {
            if (!confirm('解析キャッシュを削除しますか？ 次に開いたときに解析し直します。')) return
            await clearCache()
            setUsage(await cacheUsage())
          }}
        >
          {ja.exp.clearCache}
        </button>
      </section>
    </div>
  )
}
