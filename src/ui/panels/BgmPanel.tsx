/**
 * ④BGM：BGM の追加・ループ・フェード、音量プリセット、BGM の大きさ、ダッキング（設計書 9章）。
 */
import * as ops from '../../core/project/ops'
import type { AudioMix } from '../../core/project/types'
import { ja } from '../../i18n/ja'
import { gains } from '../../store/derived'
import { importBgm } from '../../store/jobs'
import { edit, editCoalesced, useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { fmtTime } from '../timeline/draw'
import { pickFiles } from './files'

export function BgmPanel() {
  const project = useProject((s) => s.project)!
  const analysis = useSession((s) => s.analysis)
  const bgm = useSession((s) => s.bgm)
  const mix = project.audioMix
  const g = gains(project, { analysis, bgm })
  const setMix = (patch: Parameters<typeof ops.setAudioMix>[1]) =>
    editCoalesced('mix', ops.setAudioMix, patch)

  return (
    <div className="panel">
      <p className="hint">{ja.stepHints.bgm}</p>
      <button
        type="button"
        className="primary"
        onClick={async () => {
          const [f] = await pickFiles('audio', false)
          if (f) await importBgm(f.file, f.handle)
        }}
      >
        {ja.addBgm}
      </button>
      <p className="muted small">MP3・WAV・M4A・OGG。曲が短ければ自動でループします。</p>

      {project.bgmTrack.length === 0 && <p className="muted">{ja.bgm.none}</p>}
      {project.bgmTrack.map((b) => (
        <section key={b.id} className="box">
          <div className="asset-name">{project.assets[b.assetId]?.name}</div>
          <div className="muted small">
            {fmtTime(b.timelineStart)}〜{fmtTime(b.timelineEnd)}
            {bgm[b.assetId] && Number.isFinite(bgm[b.assetId]!.lufs)
              ? ` ・ 曲の音量 ${bgm[b.assetId]!.lufs.toFixed(1)} LUFS`
              : ''}
          </div>
          <div className="grid2">
            <label>
              <input
                type="checkbox"
                checked={b.loop}
                onChange={(e) => edit(ops.updateBgm, b.id, { loop: e.target.checked })}
              />
              {ja.bgm.loop}
            </label>
            <span />
            <label>
              {ja.bgm.fadeIn}
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={b.fadeIn}
                onChange={(e) =>
                  editCoalesced(`fade-${b.id}`, ops.updateBgm, b.id, {
                    fadeIn: Math.max(0, Number(e.target.value)),
                  })
                }
              />
            </label>
            <label>
              {ja.bgm.fadeOut}
              <input
                type="number"
                min={0}
                max={10}
                step={0.5}
                value={b.fadeOut}
                onChange={(e) =>
                  editCoalesced(`fade-${b.id}`, ops.updateBgm, b.id, {
                    fadeOut: Math.max(0, Number(e.target.value)),
                  })
                }
              />
            </label>
          </div>
          <button type="button" className="small" onClick={() => edit(ops.removeBgm, b.id)}>
            {ja.bgm.remove}
          </button>
        </section>
      ))}

      <section className="box">
        <label className="slider">
          {ja.bgm.volume}：
          <b>
            {mix.bgmOffsetDb > 0 ? '+' : ''}
            {mix.bgmOffsetDb} dB
          </b>
          <input
            type="range"
            min={-10}
            max={10}
            step={1}
            value={mix.bgmOffsetDb}
            onChange={(e) => setMix({ bgmOffsetDb: Number(e.target.value) })}
          />
        </label>
        <label>
          {ja.bgm.preset}
          <select
            value={mix.preset}
            onChange={(e) =>
              edit(ops.setAudioMix, { preset: e.target.value as AudioMix['preset'] })
            }
          >
            {(Object.keys(ja.bgm.presets) as AudioMix['preset'][]).map((k) => (
              <option key={k} value={k}>
                {ja.bgm.presets[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={mix.ducking.enabled}
            onChange={(e) => edit(ops.setAudioMix, { ducking: { enabled: e.target.checked } })}
          />
          {ja.bgm.ducking}
        </label>
        {mix.ducking.enabled && (
          <label className="slider">
            {ja.bgm.duckAmount}：<b>{mix.ducking.amountDb} dB</b>
            <input
              type="range"
              min={3}
              max={24}
              step={1}
              value={mix.ducking.amountDb}
              onChange={(e) => setMix({ ducking: { amountDb: Number(e.target.value) } })}
            />
          </label>
        )}
        <p className="muted small">
          元の音声：
          {Number.isFinite(g.voiceLufs)
            ? `${g.voiceLufs.toFixed(1)} LUFS → ${g.voiceDb >= 0 ? '+' : ''}${g.voiceDb.toFixed(1)} dB で調整`
            : '解析が終わると自動で調整します'}
          ・書き出し時は全体を {mix.targetLufs} LUFS にそろえます
        </p>
      </section>
    </div>
  )
}
