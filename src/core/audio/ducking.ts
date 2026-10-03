/**
 * ダッキング（設計書 9.2）。BGM の音量カーブは保存せず、発話区間から毎回導出する。
 * プレビュー（AudioParam のスケジュール）と書き出し（サンプルごとの計算）で同じ折れ線を使う。
 */
import type { AudioMix, BgmClip, Db, Project, Sec } from '../project/types'
import { mergeRanges, sourceRangeToTimeline, type Range } from '../time/time'

export interface GainPoint {
  t: Sec
  db: Db
}

export const dbToGain = (db: Db): number => (db <= -120 ? 0 : Math.pow(10, db / 20))
export const gainToDb = (g: number): Db => (g <= 0 ? -120 : 20 * Math.log10(g))

/** 素材ごとの発話区間（ソース時刻）をタイムライン時刻へ。0.5秒未満の隙間は結合する */
export function speechOnTimeline(
  project: Pick<Project, 'videoTrack'>,
  speechByAsset: Record<string, readonly Range[] | undefined>,
): Range[] {
  const out: Range[] = []
  for (const [assetId, ranges] of Object.entries(speechByAsset)) {
    for (const r of ranges ?? [])
      out.push(...sourceRangeToTimeline(project.videoTrack, assetId, r.start, r.end))
  }
  return mergeRanges(out, 0.5)
}

/**
 * 発話区間からダッキングの折れ線（dB）を作る。
 * 発話の attack 前から下げ始め、終わってから hold 待って release で戻す。
 */
export function duckingCurve(speech: readonly Range[], ducking: AudioMix['ducking']): GainPoint[] {
  if (!ducking.enabled || speech.length === 0 || ducking.amountDb <= 0) return []
  const a = ducking.attackMs / 1000
  const h = ducking.holdMs / 1000
  const r = ducking.releaseMs / 1000
  const merged = mergeRanges(
    speech.map((s) => ({ start: s.start, end: s.end + h })),
    a + r,
  )
  const pts: GainPoint[] = []
  for (const m of merged) {
    pts.push({ t: Math.max(0, m.start - a), db: 0 })
    pts.push({ t: m.start, db: -ducking.amountDb })
    pts.push({ t: m.end, db: -ducking.amountDb })
    pts.push({ t: m.end + r, db: 0 })
  }
  return pts
}

/** 折れ線の値（dB）。点の外側は 0 dB */
export function evalCurve(points: readonly GainPoint[], t: Sec): Db {
  const n = points.length
  if (n === 0 || t <= points[0]!.t || t >= points[n - 1]!.t) return 0
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (points[mid]!.t <= t) lo = mid
    else hi = mid
  }
  const p = points[lo]!
  const q = points[hi]!
  return q.t - p.t < 1e-9 ? q.db : p.db + ((q.db - p.db) * (t - p.t)) / (q.t - p.t)
}

/** フェードイン・アウトの倍率（0〜1） */
export function fadeGain(clip: BgmClip, t: Sec): number {
  if (t < clip.timelineStart || t > clip.timelineEnd) return 0
  let g = 1
  if (clip.fadeIn > 0) g = Math.min(g, (t - clip.timelineStart) / clip.fadeIn)
  if (clip.fadeOut > 0) g = Math.min(g, (clip.timelineEnd - t) / clip.fadeOut)
  return Math.max(0, Math.min(1, g))
}

/** ループのつなぎ目のクロスフェード長（設計書 9.1） */
export const LOOP_XFADE: Sec = 0.05

/**
 * タイムライン時刻 t で鳴らす BGM ファイル内の位置と重み。ループしないで終わっていれば空。
 * ループ時は1周を duration - LOOP_XFADE とし、2周目以降の頭 LOOP_XFADE 秒は
 * 前の周の末尾と直線でクロスフェードする。
 */
export function bgmTaps(clip: BgmClip, t: Sec, duration: Sec): { pos: Sec; weight: number }[] {
  if (t < clip.timelineStart || t >= clip.timelineEnd) return []
  const pos = clip.sourceOffset + (t - clip.timelineStart)
  if (!clip.loop) return pos < duration ? [{ pos, weight: 1 }] : []
  const period = Math.max(0.1, duration - LOOP_XFADE)
  const k = Math.floor(pos / period)
  const u = pos - k * period
  if (k === 0 || u >= LOOP_XFADE) return [{ pos: u, weight: 1 }]
  const w = u / LOOP_XFADE
  return [
    { pos: u, weight: w },
    { pos: u + period, weight: 1 - w },
  ]
}
