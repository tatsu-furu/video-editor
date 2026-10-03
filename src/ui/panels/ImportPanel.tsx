/**
 * ①読み込み：素材一覧、追加、解析の状態、解析に使う音声トラック、素材の選び直し。
 */
import { useState } from 'react'
import * as ops from '../../core/project/ops'
import { ja } from '../../i18n/ja'
import {
  analyzeAsset,
  changeAnalysisTrack,
  recomputeSuggestions,
  importVideos,
  relinkAsset,
  requestMissingPermissions,
} from '../../store/jobs'
import { edit, useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { fmtTime } from '../timeline/draw'
import { droppedFiles, pickFiles } from './files'

export function DropZone({ big = false }: { big?: boolean }) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`dropzone${over ? ' is-over' : ''}${big ? ' is-big' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setOver(false)
        const files = await droppedFiles(e.dataTransfer)
        await importVideos(files.filter((f) => !f.file.type.startsWith('audio/')))
      }}
    >
      <p>{ja.dropHere}</p>
      <p className="muted">{ja.dropOr}</p>
      <button
        type="button"
        className="primary"
        onClick={async () => importVideos(await pickFiles('video', true))}
      >
        {ja.addVideo}
      </button>
      <p className="muted small">MP4・MOV・MKV・WebM（OBS の録画をそのまま入れられます）</p>
    </div>
  )
}

export function ImportPanel() {
  const project = useProject((s) => s.project)!
  const analysis = useSession((s) => s.analysis)
  const missing = useSession((s) => s.missing)
  const videos = Object.values(project.assets).filter((a) => a.kind === 'video')

  return (
    <div className="panel">
      <p className="hint">{ja.stepHints.import}</p>
      <fieldset className="mode">
        <legend>自動カットのモード</legend>
        {(['game', 'talk'] as const).map((m) => (
          <label key={m}>
            <input
              type="radio"
              name="mode"
              checked={project.mode === m}
              onChange={() => {
                edit(ops.setMode, m)
                recomputeSuggestions()
              }}
            />
            <b>{ja.modes[m].label}</b> <span className="muted small">{ja.modes[m].desc}</span>
          </label>
        ))}
      </fieldset>
      {missing.length > 0 && (
        <div className="notice">
          <p>{ja.missingNote}</p>
          <button type="button" onClick={requestMissingPermissions}>
            {ja.allowAccess}
          </button>
        </div>
      )}
      <ul className="assets">
        {videos.map((a) => {
          const st = analysis[a.id]
          const isMissing = missing.includes(a.id)
          return (
            <li key={a.id} className="asset">
              <div className="asset-name" title={a.name}>
                {a.name}
              </div>
              <div className="muted small">
                {fmtTime(a.duration)} ・ {a.video?.width}×{a.video?.height} ・{' '}
                {Math.round(a.video?.fps ?? 0)}fps ・ {a.video?.codec}
              </div>
              {isMissing ? (
                <button
                  type="button"
                  onClick={async () => {
                    const [f] = await pickFiles('video', false)
                    if (f) await relinkAsset(a.id, f.file)
                  }}
                >
                  {ja.relink}
                </button>
              ) : (
                <div className="small">
                  {st?.status === 'running' && (
                    <>
                      {st.label ?? ja.analysis.running} <progress value={st.progress} max={1} />
                    </>
                  )}
                  {st?.status === 'waiting' && ja.analysis.waiting}
                  {st?.status === 'done' && (
                    <>
                      {ja.analysis.done}
                      {st.result?.vadSource === 'energy' && (
                        <span className="muted">（声の検出は音量で代用）</span>
                      )}
                    </>
                  )}
                  {st?.status === 'error' && (
                    <span className="error">
                      {ja.analysis.error}：{st.error}{' '}
                      <button type="button" onClick={() => analyzeAsset(a.id)}>
                        {ja.analysis.retry}
                      </button>
                    </span>
                  )}
                </div>
              )}
              {a.audioTracks.length > 1 && (
                <label className="small">
                  {ja.analysis.track}
                  <select
                    value={a.analysisAudioTrack}
                    onChange={(e) => changeAnalysisTrack(a.id, Number(e.target.value))}
                  >
                    {a.audioTracks.map((t) => (
                      <option key={t.index} value={t.index}>
                        {t.label}（{t.channels}ch）
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </li>
          )
        })}
      </ul>
      {Object.values(project.assets)
        .filter((a) => a.kind === 'audio' && missing.includes(a.id))
        .map((a) => (
          <div key={a.id} className="asset">
            <div className="asset-name">BGM：{a.name}</div>
            <button
              type="button"
              onClick={async () => {
                const [f] = await pickFiles('audio', false)
                if (f) await relinkAsset(a.id, f.file)
              }}
            >
              {ja.relink}
            </button>
          </div>
        ))}
      <DropZone />
    </div>
  )
}
