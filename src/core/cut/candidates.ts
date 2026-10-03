/**
 * 自動カット候補の生成（設計書 7.3・7.4）。結果は Suggestion の材料（id・status なし）。
 */
import type { Sec, Suggestion } from '../project/types'
import { subtractRanges, type Range } from '../time/time'
import { HOP, movingMedian, percentile, shortTermLoudness, snapToMinimum } from './envelope'

export type Candidate = Omit<Suggestion, 'id' | 'assetId' | 'status'>

export interface SilenceOptions {
  /** これ以上続く無音を候補にする（「詰め具合」スライダー 0.3〜2.0） */
  minSilence: Sec
  /** 発話の前後に残す余白 */
  padding: Sec
}

export const SILENCE_DEFAULTS: SilenceOptions = { minSilence: 0.6, padding: 0.15 }

/** トークモード：発話のない区間を削除候補にする */
export function silenceCandidates(
  speech: readonly Range[],
  env: Float32Array,
  duration: Sec,
  opts: SilenceOptions = SILENCE_DEFAULTS,
): Candidate[] {
  const gaps = subtractRanges([{ start: 0, end: duration }], speech)
  const out: Candidate[] = []
  for (const g of gaps) {
    if (g.end - g.start < opts.minSilence) continue
    let start = g.start <= 0 ? 0 : g.start + opts.padding
    let end = g.end >= duration ? duration : g.end - opts.padding
    // 音の途中で切らないよう、0.3 秒以内の音量の谷に吸着させる。
    // 余白を削らないよう、無音区間の内側（中央まで）にだけ動かす
    const mid = (g.start + g.end) / 2
    if (start > 0) start = snapToMinimum(env, start, start, Math.min(mid, start + 0.3))
    if (end < duration) end = snapToMinimum(env, end, Math.max(mid, end - 0.3), end)
    if (end - start < 0.1) continue
    out.push({
      kind: 'silence',
      sourceStart: start,
      sourceEnd: end,
      score: Math.min(1, (end - start) / 5),
    })
  }
  return out
}

export interface HighlightOptions {
  /** 「感度」：ベースラインからの差の閾値（+3〜+12 dB） */
  thresholdDb: number
  /** 目標の長さ（秒）。指定するとスコアの高い順にこの長さまで採用する */
  targetLength?: Sec
  /** 解析トラックがマイクのとき、叫び・笑いも拾う */
  micTrack?: boolean
}

export const HIGHLIGHT_DEFAULTS: HighlightOptions = { thresholdDb: 6 }

const PRE = 8
const POST = 4
const MIN_PEAK_GAP = 5
const MERGE_GAP = 3
const MAX_LEN = 60

/** 興奮度 e(t) = 短期ラウドネス − 30秒移動中央値 */
export function excitement(env: Float32Array): Float32Array {
  const st = shortTermLoudness(env)
  const base = movingMedian(st)
  return Float32Array.from(st, (v, i) => v - base[i]!)
}

/** ゲームモード：盛り上がりをハイライト候補に、それ以外を lowActivity（削除候補）にする */
export function highlightCandidates(
  env: Float32Array,
  speech: readonly Range[],
  duration: Sec,
  opts: HighlightOptions = HIGHLIGHT_DEFAULTS,
): Candidate[] {
  const e = excitement(env)
  // 極大点を大きい順に、5秒以上離して拾う
  const peaks: { t: Sec; v: number }[] = []
  for (let i = 1; i < e.length - 1; i++) {
    const v = e[i]!
    if (v >= opts.thresholdDb && v >= e[i - 1]! && v >= e[i + 1]!)
      peaks.push({ t: i * HOP + HOP / 2, v })
  }
  peaks.sort((a, b) => b.v - a.v)
  const chosen: { t: Sec; v: number }[] = []
  for (const p of peaks)
    if (chosen.every((c) => Math.abs(c.t - p.t) >= MIN_PEAK_GAP)) chosen.push(p)

  const regions: (Range & { score: number })[] = chosen.map((p) => ({
    start: Math.max(0, p.t - PRE),
    end: Math.min(duration, p.t + POST),
    score: Math.min(1, p.v / 18),
  }))

  // マイク音声：発話中で、声の大きさが中央値 +6dB 以上の区間（叫び・笑い）
  if (opts.micTrack) {
    const med = percentile(
      env.filter((v) => v > -90),
      0.5,
    )
    for (const s of speech) {
      let loud = 0
      for (let i = Math.floor(s.start / HOP); i < Math.min(env.length, s.end / HOP); i++)
        loud = Math.max(loud, env[i]! - med)
      if (loud >= 6)
        regions.push({
          start: Math.max(0, s.start - 2),
          end: Math.min(duration, s.end + 2),
          score: Math.min(1, 0.6 + loud / 30),
        })
    }
  }

  // 3秒未満の隙間は結合、1区間は最長 60 秒
  regions.sort((a, b) => a.start - b.start)
  const merged: (Range & { score: number })[] = []
  for (const r of regions) {
    const last = merged[merged.length - 1]
    if (
      last &&
      r.start - last.end < MERGE_GAP &&
      Math.max(last.end, r.end) - last.start <= MAX_LEN
    ) {
      last.end = Math.max(last.end, r.end)
      last.score = Math.max(last.score, r.score)
    } else merged.push({ ...r, end: Math.min(r.end, r.start + MAX_LEN) })
  }

  let picked = merged
  if (opts.targetLength && opts.targetLength > 0) picked = pickToLength(merged, opts.targetLength)

  const highlights: Candidate[] = picked.map((r) => ({
    kind: 'highlight',
    sourceStart: r.start,
    sourceEnd: r.end,
    score: r.score,
  }))
  const rest = subtractRanges([{ start: 0, end: duration }], picked).filter(
    (r) => r.end - r.start >= 0.5,
  )
  const low: Candidate[] = rest.map((r) => ({
    kind: 'lowActivity',
    sourceStart: r.start,
    sourceEnd: r.end,
    score: 0.5,
  }))
  return [...highlights, ...low].sort((a, b) => a.sourceStart - b.sourceStart)
}

/** スコアの高い区間から合計が target になるまで採用する。最後の区間は長さを合わせて切り詰める */
export function pickToLength<T extends Range & { score: number }>(
  regions: readonly T[],
  target: Sec,
): T[] {
  const byScore = [...regions].sort((a, b) => b.score - a.score)
  const out: T[] = []
  let sum = 0
  for (const r of byScore) {
    if (sum >= target) break
    const len = r.end - r.start
    if (sum + len <= target) {
      out.push(r)
      sum += len
    } else {
      const need = target - sum
      if (need >= 1) {
        // ピーク（前 8 秒・後 4 秒の境目）を中心に残す
        const peak = Math.min(r.end, r.start + PRE)
        const start = Math.max(r.start, Math.min(peak - need * (PRE / (PRE + POST)), r.end - need))
        out.push({ ...r, start, end: start + need })
        sum += need
      }
    }
  }
  return out.sort((a, b) => a.start - b.start)
}
