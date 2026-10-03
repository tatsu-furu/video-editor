/**
 * ルックアヘッド付きリミッター（設計書 9.3：ルックアヘッド 5ms、トゥルーピーク -1 dBTP 以下）。
 *
 * サンプル p に必要な倍率 req[p] に対し、
 *   m[k] = min(req[k-L .. k])、target[k] = 平均(m[k-L .. k])
 * とすると target[p+L] ≤ req[p] になる。そこで入力を L サンプル遅らせて target を掛ければ、
 * ピークの手前から倍率が滑らかに下がり、ピーク時点で必ず上限以下になる。
 * ステレオはリンク（左右で同じ倍率）。
 */

export class Limiter {
  readonly latency: number
  private readonly ceiling: number
  private readonly release: number
  private readonly channels: number
  /** 入力の遅延線（リングバッファ、チャンネルごと） */
  private readonly delay: Float32Array[]
  private readonly box: Float64Array
  private boxSum = 0
  /** 先読み最小値の単調キュー（インデックスと値のリング） */
  private readonly qi: Float64Array
  private readonly qv: Float64Array
  private qHead = 0
  private qTail = 0
  private n = 0
  private g = 1

  constructor(
    sampleRate: number,
    ceilingDb: number,
    channels = 2,
    lookaheadMs = 5,
    releaseMs = 80,
  ) {
    const L = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000))
    this.latency = L
    this.channels = channels
    this.ceiling = Math.pow(10, ceilingDb / 20)
    this.release = 1 - Math.exp(-1 / ((sampleRate * releaseMs) / 1000))
    this.delay = Array.from({ length: channels }, () => new Float32Array(L + 1))
    this.box = new Float64Array(L + 1).fill(1)
    this.boxSum = L + 1
    this.qi = new Float64Array(L + 2)
    this.qv = new Float64Array(L + 2)
  }

  push(input: readonly Float32Array[]): Float32Array[] {
    const n = input[0]?.length ?? 0
    const L = this.latency
    // 最初の L サンプルは遅延線を埋めるだけで出力しない
    const skip = Math.max(0, Math.min(n, L - this.n))
    const outs = Array.from({ length: this.channels }, () => new Float32Array(n - skip))
    for (let i = 0; i < n; i++) {
      let peak = 0
      for (let ch = 0; ch < this.channels; ch++) {
        const x = (input[ch] ?? input[0]!)[i]!
        const a = x < 0 ? -x : x
        if (a > peak) peak = a
      }
      this.process(peak > this.ceiling ? this.ceiling / peak : 1, input, i, outs, i - skip)
    }
    return outs
  }

  /** 遅延線に残った L サンプルを吐き出す */
  flush(): Float32Array[] {
    const L = Math.min(this.latency, this.n)
    const zeros = Array.from({ length: this.channels }, () => new Float32Array(1))
    const outs = Array.from({ length: this.channels }, () => new Float32Array(L))
    for (let i = 0; i < L; i++) this.process(1, zeros, 0, outs, i)
    return outs
  }

  private process(
    required: number,
    input: readonly Float32Array[],
    i: number,
    outs: Float32Array[],
    o: number,
  ) {
    const L = this.latency
    const idx = this.n++
    const size = L + 2
    // 単調キュー：窓 [idx-L, idx] の最小値
    while (this.qTail !== this.qHead && this.qv[(this.qTail - 1 + size) % size]! >= required)
      this.qTail = (this.qTail - 1 + size) % size
    this.qi[this.qTail] = idx
    this.qv[this.qTail] = required
    this.qTail = (this.qTail + 1) % size
    while (this.qi[this.qHead]! < idx - L) this.qHead = (this.qHead + 1) % size
    const m = this.qv[this.qHead]!
    // 移動平均（長さ L+1）
    const bi = idx % (L + 1)
    this.boxSum += m - this.box[bi]!
    this.box[bi] = m
    const target = this.boxSum / (L + 1)
    this.g = target < this.g ? target : this.g + (target - this.g) * this.release
    // 遅延線：L サンプル前の入力を取り出し、今回の入力を書き込む
    const di = idx % (L + 1)
    for (let ch = 0; ch < this.channels; ch++) {
      const line = this.delay[ch]!
      const old = line[(idx + 1) % (L + 1)]!
      line[di] = (input[ch] ?? input[0]!)[i]!
      if (idx >= L) {
        let y = old * this.g
        if (y > this.ceiling) y = this.ceiling
        else if (y < -this.ceiling) y = -this.ceiling
        outs[ch]![o] = y
      }
    }
  }
}
