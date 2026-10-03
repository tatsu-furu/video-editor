/**
 * プロジェクトと解析結果から毎回導出する値（字幕のキュー、ダッキングカーブ、ゲイン）。
 * 同じ入力なら前回の結果を返す（再描画のたびに計算しない）。
 */
import { duckingCurve, speechOnTimeline, type GainPoint } from '../core/audio/ducking'
import { integratedLoudness } from '../core/audio/loudness'
import { bgmGainDb, voiceGainDb } from '../core/audio/mix'
import { excitement } from '../core/cut/candidates'
import { HOP } from '../core/cut/envelope'
import type { Id, Project } from '../core/project/types'
import { timelineCues, type TimelineCue } from '../core/subtitles/split'
import { keptSourceRanges, mergeRanges, type Range } from '../core/time/time'
import type { SessionState } from './session'

function memo<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  let last: A | null = null
  let value: R
  return (...a: A) => {
    if (last && last.length === a.length && last.every((v, i) => v === a[i])) return value
    last = a
    value = fn(...a)
    return value
  }
}

export const cuesOf = memo(
  (
    subtitles: Project['subtitles'],
    track: Project['videoTrack'],
    style: Project['subtitleStyle'],
  ): TimelineCue[] => timelineCues(subtitles, track, style),
)

export const cues = (p: Project) => cuesOf(p.subtitles, p.videoTrack, p.subtitleStyle)

/**
 * ダッキングに使う発話区間（素材ごと・ソース時刻）。
 * VAD で声が見つからない素材は、短期ラウドネスがベースライン +3dB を超える区間で代用する（設計書 9.2）。
 */
export const speechByAsset = memo((analysis: SessionState['analysis']): Record<Id, Range[]> => {
  const out: Record<Id, Range[]> = {}
  for (const [id, a] of Object.entries(analysis)) {
    const r = a.result
    if (!r) continue
    if (r.speech.length > 0) out[id] = r.speech
    else {
      const e = excitement(r.envelope)
      const ranges: Range[] = []
      let start = -1
      for (let i = 0; i <= e.length; i++) {
        const on = i < e.length && e[i]! > 3
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          ranges.push({ start: start * HOP, end: i * HOP })
          start = -1
        }
      }
      out[id] = mergeRanges(ranges, 0.3)
    }
  }
  return out
})

export const duckCurveOf = memo(
  (
    track: Project['videoTrack'],
    ducking: Project['audioMix']['ducking'],
    analysis: SessionState['analysis'],
  ): GainPoint[] =>
    duckingCurve(speechOnTimeline({ videoTrack: track }, speechByAsset(analysis)), ducking),
)

export const duckCurve = (p: Project, analysis: SessionState['analysis']) =>
  duckCurveOf(p.videoTrack, p.audioMix.ducking, analysis)

/**
 * 残っている区間の元音声のラウドネス（LUFS）。
 * 解析は 16kHz モノラルなので、ステレオ相当に +3 LU する。
 */
export const voiceLufsOf = memo(
  (track: Project['videoTrack'], analysis: SessionState['analysis']): number => {
    const values: number[] = []
    const assets = new Set(track.map((c) => c.assetId))
    for (const id of assets) {
      const blocks = analysis[id]?.result?.blocks
      if (!blocks) continue
      for (const r of keptSourceRanges(track, id)) {
        const a = Math.max(0, Math.floor(r.start * 10))
        const b = Math.min(blocks.length, Math.floor(r.end * 10))
        for (let i = a; i < b; i++) values.push(blocks[i]!)
      }
    }
    const l = integratedLoudness(values)
    return Number.isFinite(l) ? l + 3 : l
  },
)

export function gains(
  p: Project,
  s: Pick<SessionState, 'analysis' | 'bgm'>,
): { voiceDb: number; bgmDb: Record<Id, number>; voiceLufs: number } {
  const voiceLufs = voiceLufsOf(p.videoTrack, s.analysis)
  const bgmDb: Record<Id, number> = {}
  for (const b of p.bgmTrack) {
    const info = s.bgm[b.assetId]
    if (info) bgmDb[b.assetId] = bgmGainDb(info.lufs, p.audioMix)
  }
  return { voiceDb: voiceGainDb(voiceLufs, p.audioMix), bgmDb, voiceLufs }
}
