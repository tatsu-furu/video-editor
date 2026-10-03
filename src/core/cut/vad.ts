/**
 * 発話区間の確定（設計書 7.2）。
 *
 * Silero VAD の発話確率（32ms ごと）をヒステリシスで二値化し、
 * 0.3 秒未満の切れ目を埋め、0.25 秒未満の孤立した発話を捨てる。
 */
import type { Range } from '../time/time'
import { HOP, percentile } from './envelope'

export const VAD_FRAME = 512 / 16000 // 0.032 秒

export interface VadOptions {
  on: number
  off: number
  minGap: number
  minSpeech: number
}

export const VAD_DEFAULTS: VadOptions = { on: 0.5, off: 0.35, minGap: 0.3, minSpeech: 0.25 }

export function speechSegments(
  probs: ArrayLike<number>,
  frame = VAD_FRAME,
  opts: VadOptions = VAD_DEFAULTS,
): Range[] {
  const raw: Range[] = []
  let start = -1
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!
    if (start < 0 && p >= opts.on) start = i
    else if (start >= 0 && p < opts.off) {
      raw.push({ start: start * frame, end: i * frame })
      start = -1
    }
  }
  if (start >= 0) raw.push({ start: start * frame, end: probs.length * frame })
  // 短い切れ目を埋める
  const filled: Range[] = []
  for (const r of raw) {
    const last = filled[filled.length - 1]
    if (last && r.start - last.end < opts.minGap) last.end = r.end
    else filled.push({ ...r })
  }
  return filled.filter((r) => r.end - r.start >= opts.minSpeech)
}

/**
 * Silero VAD が使えないときの代わり：エンベロープから発話確率に相当する値を作る。
 * 雑音レベル（静かなコマの 10% 点）より 10dB 上で 0.5 になるシグモイド。
 * 戻り値は VAD_FRAME ではなく HOP（20ms）刻み。
 */
export function energyVadProbs(env: Float32Array): { probs: Float32Array; frame: number } {
  const audible = Array.from(env).filter((v) => v > -99)
  const noise = audible.length ? percentile(audible, 0.1) : -100
  const center = Math.min(-30, noise + 10)
  const probs = Float32Array.from(env, (v) => 1 / (1 + Math.exp(-(v - center) / 2)))
  return { probs, frame: HOP }
}

/** 区間内で発話が占める割合（0〜1） */
export function speechRatio(speech: readonly Range[], start: number, end: number): number {
  if (end <= start) return 0
  let s = 0
  for (const r of speech) s += Math.max(0, Math.min(end, r.end) - Math.max(start, r.start))
  return s / (end - start)
}
