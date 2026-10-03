/**
 * ITU-R BS.1770 のラウドネス計算（設計書 9.3）。K 特性フィルタ＋ゲーティングの自前実装。
 *
 * 100ms ごとの「K 特性をかけた二乗平均（チャンネル合計）」＝ブロックを作っておき、
 * 統合ラウドネスはそのブロック列から計算する。ブロックを残しておけば、
 * 「カット後に残っている区間だけのラウドネス」も後から求められる。
 */

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** 任意のサンプルレートでの K 特性フィルタ係数（1段目：高域シェルフ、2段目：ハイパス） */
export function kWeighting(fs: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533
  const G = 3.999843853973347
  let Q = 0.7071752369554196
  let K = Math.tan((Math.PI * f0) / fs)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  let a0 = 1 + K / Q + K * K
  const shelf: Biquad = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  f0 = 38.13547087602444
  Q = 0.5003270373238773
  K = Math.tan((Math.PI * f0) / fs)
  a0 = 1 + K / Q + K * K
  const hp: Biquad = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  }
  return [shelf, hp]
}

const lufsOf = (ms: number) => -0.691 + 10 * Math.log10(ms)

/** 流しながら 100ms ブロックを作るメーター */
export class LoudnessMeter {
  readonly blocks: number[] = []
  peak = 0
  private readonly f: [Biquad, Biquad]
  private readonly z: Float64Array
  private acc = 0
  private accN = 0
  private readonly blockSize: number

  constructor(sampleRate: number, channels = 2) {
    this.f = kWeighting(sampleRate)
    this.z = new Float64Array(channels * 4)
    this.blockSize = Math.round(sampleRate / 10)
  }

  push(channels: readonly Float32Array[]): void {
    const n = channels[0]?.length ?? 0
    const [s1, s2] = this.f
    const z = this.z
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let ch = 0; ch < channels.length; ch++) {
        const x = channels[ch]![i]!
        const ax = x < 0 ? -x : x
        if (ax > this.peak) this.peak = ax
        const o = ch * 4
        const y1 = s1.b0 * x + z[o]!
        z[o] = s1.b1 * x - s1.a1 * y1 + z[o + 1]!
        z[o + 1] = s1.b2 * x - s1.a2 * y1
        const y2 = s2.b0 * y1 + z[o + 2]!
        z[o + 2] = s2.b1 * y1 - s2.a1 * y2 + z[o + 3]!
        z[o + 3] = s2.b2 * y1 - s2.a2 * y2
        sum += y2 * y2
      }
      this.acc += sum
      if (++this.accN >= this.blockSize) {
        this.blocks.push(this.acc / this.accN)
        this.acc = 0
        this.accN = 0
      }
    }
  }

  integrated(): number {
    return integratedLoudness(this.blocks)
  }
}

/**
 * 100ms ブロック列から統合ラウドネス（LUFS）を計算する。
 * include を渡すと、その 400ms 窓（先頭ブロックの番号）だけを使う。音が無ければ -Infinity。
 */
export function integratedLoudness(
  blocks: ArrayLike<number>,
  include?: (blockIndex: number) => boolean,
): number {
  const gates: number[] = []
  for (let i = 0; i + 4 <= blocks.length; i++) {
    if (include && !include(i)) continue
    gates.push((blocks[i]! + blocks[i + 1]! + blocks[i + 2]! + blocks[i + 3]!) / 4)
  }
  const abs = gates.filter((ms) => ms > 0 && lufsOf(ms) > -70)
  if (abs.length === 0) return -Infinity
  const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10
  const fin = abs.filter((ms) => lufsOf(ms) > rel)
  return fin.length ? lufsOf(fin.reduce((a, b) => a + b, 0) / fin.length) : -Infinity
}
