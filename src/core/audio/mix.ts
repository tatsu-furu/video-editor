/**
 * 音量バランスの計算とリサンプル（設計書 9.3）。
 */
import { AUDIO_PRESETS } from '../project/create'
import type { AudioMix, Db } from '../project/types'

const clampDb = (v: Db) => Math.max(-30, Math.min(30, v))

/** 元音声に掛けるゲイン：残っている区間のラウドネスを目標値に合わせる */
export function voiceGainDb(voiceLufs: number, mix: AudioMix): Db {
  return Number.isFinite(voiceLufs) ? clampDb(mix.targetLufs - voiceLufs) : 0
}

/** BGM に掛けるゲイン：（調整後の）元音声に対してプリセットの差＋スライダー */
export function bgmGainDb(bgmLufs: number, mix: AudioMix): Db {
  if (!Number.isFinite(bgmLufs)) return 0
  const want = mix.targetLufs + AUDIO_PRESETS[mix.preset].bgmRelativeLu + mix.bgmOffsetDb
  return clampDb(want - bgmLufs)
}

/** 最終ミックスを目標ラウドネスに合わせるゲイン（ピークはリミッターで抑える） */
export function normalizeGainDb(mixLufs: number, mix: AudioMix): Db {
  return Number.isFinite(mixLufs) ? Math.max(-20, Math.min(20, mix.targetLufs - mixLufs)) : 0
}

/** planar を指定チャンネル数にする（モノ↔ステレオ、多チャンネルは平均） */
export function remix(input: readonly Float32Array[], channels: number): Float32Array[] {
  if (input.length === channels) return [...input]
  const n = input[0]?.length ?? 0
  if (channels === 1) {
    const m = new Float32Array(n)
    for (const c of input) for (let i = 0; i < n; i++) m[i]! += c[i]! / input.length
    return [m]
  }
  if (input.length === 1) return Array.from({ length: channels }, () => input[0]!)
  return Array.from({ length: channels }, (_, ch) => input[ch % input.length]!)
}

/**
 * 線形補間のストリーミング・リサンプラー。分割して push しても結果は同じ。
 */
export class Resampler {
  readonly inRate: number
  readonly outRate: number
  readonly channels: number
  private pos = 0
  private readonly prev: Float64Array
  private readonly step: number

  constructor(inRate: number, outRate: number, channels: number) {
    this.inRate = inRate
    this.outRate = outRate
    this.channels = channels
    this.step = inRate / outRate
    this.prev = new Float64Array(channels)
  }

  push(input: readonly Float32Array[]): Float32Array[] {
    const n = input[0]?.length ?? 0
    if (this.inRate === this.outRate) return input.map((c) => c.slice())
    // pos が負のとき（-1〜0）は前回の最後のサンプルとの間を補間する
    const count = n === 0 ? 0 : Math.max(0, Math.floor((n - 1 - this.pos) / this.step) + 1)
    const out = Array.from({ length: this.channels }, () => new Float32Array(count))
    for (let ch = 0; ch < this.channels; ch++) {
      const src = input[ch] ?? input[0]!
      const o = out[ch]!
      let p = this.pos
      for (let i = 0; i < count; i++) {
        const i0 = Math.floor(p)
        const f = p - i0
        const a = i0 < 0 ? this.prev[ch]! : src[i0]!
        const b = src[Math.min(n - 1, i0 + 1)]!
        o[i] = a + (b - a) * f
        p += this.step
      }
      if (n > 0) this.prev[ch] = src[n - 1]!
    }
    this.pos = this.pos + count * this.step - n
    return out
  }
}
