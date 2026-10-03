/**
 * 音量エンベロープと、そこから導く量（設計書 7.1）。
 *
 * - エンベロープ：20ms ごとの RMS（窓 40ms）を dBFS で。
 * - 短期ラウドネス：窓 400ms の平均エネルギー（dB）。
 * - ベースライン：短期ラウドネスの 30 秒移動中央値。
 */

export const ANALYSIS_RATE = 16000
/** エンベロープ1コマの間隔（秒） */
export const HOP = 0.02
/** RMS の窓（秒） */
export const WIN = 0.04
export const FLOOR_DB = -100

export const toDb = (rms: number): number =>
  rms > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(rms)) : FLOOR_DB
const fromDb = (db: number): number => Math.pow(10, db / 10) // dB → エネルギー

/** PCM（16kHz モノラル）からエンベロープを作る */
export function computeEnvelope(pcm: Float32Array, rate = ANALYSIS_RATE): Float32Array {
  const hop = Math.round(rate * HOP)
  const win = Math.round(rate * WIN)
  const n = Math.ceil(pcm.length / hop)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const center = i * hop + hop / 2
    const from = Math.max(0, Math.round(center - win / 2))
    const to = Math.min(pcm.length, Math.round(center + win / 2))
    let sum = 0
    for (let j = from; j < to; j++) sum += pcm[j]! * pcm[j]!
    out[i] = toDb(Math.sqrt(sum / Math.max(1, to - from)))
  }
  return out
}

/** 窓 400ms の短期ラウドネス（dB）。エンベロープのエネルギー平均 */
export function shortTermLoudness(env: Float32Array, windowSec = 0.4): Float32Array {
  const r = Math.max(1, Math.round(windowSec / HOP / 2))
  const e = Float64Array.from(env, fromDb)
  const out = new Float32Array(env.length)
  let sum = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < env.length; i++) {
    while (hi < Math.min(env.length - 1, i + r)) sum += e[++hi]!
    while (lo < i - r) sum -= e[lo++]!
    out[i] = 10 * Math.log10(Math.max(1e-10, sum / (hi - lo + 1)))
  }
  return out
}

export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return FLOOR_DB
  const a = Float64Array.from(values as ArrayLike<number>).sort()
  return a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))]!
}

/**
 * 移動中央値（窓 windowSec）。計算量を抑えるため 0.5 秒ごとに間引いて中央値を取り、線形補間で戻す。
 */
export function movingMedian(series: Float32Array, windowSec = 30, stepSec = 0.5): Float32Array {
  const step = Math.max(1, Math.round(stepSec / HOP))
  const coarse: number[] = []
  for (let i = 0; i < series.length; i += step) coarse.push(series[i]!)
  const half = Math.max(1, Math.round(windowSec / stepSec / 2))
  const med = coarse.map((_, i) =>
    percentile(coarse.slice(Math.max(0, i - half), i + half + 1), 0.5),
  )
  const out = new Float32Array(series.length)
  for (let i = 0; i < series.length; i++) {
    const x = i / step
    const a = Math.floor(x)
    const b = Math.min(med.length - 1, a + 1)
    const f = x - a
    out[i] = med[a]! + (med[b]! - med[a]!) * f
  }
  return out
}

/**
 * [lo, hi]（既定は t±0.3 秒）でエンベロープが最小になる時刻（境界の吸着用）。
 * t の位置より 3dB 以上低い谷がなければ動かさない（無音の中では動かさない）。
 */
export function snapToMinimum(env: Float32Array, t: number, lo = t - 0.3, hi = t + 0.3): number {
  const from = Math.max(0, Math.ceil(lo / HOP - 0.5))
  const to = Math.min(env.length - 1, Math.floor(hi / HOP - 0.5))
  const here = env[Math.min(env.length - 1, Math.max(0, Math.floor(t / HOP)))] ?? FLOOR_DB
  let best = t
  let bestDb = here - 3
  for (let i = from; i <= to; i++) {
    const v = env[i]!
    if (v < bestDb) {
      bestDb = v
      best = i * HOP + HOP / 2
    }
  }
  return best
}
