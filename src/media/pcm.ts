/**
 * 音声トラックを「必要な分だけ順に読む」ストリーム（設計書 12.5）。
 *
 * 全体をメモリに載せず、Mediabunny で少しずつデコード → チャンネル変換 → リサンプルする。
 * デコードした AudioSample は try/finally で必ず close() する。Worker からだけ使う。
 */
import { AudioSampleSink, type AudioSample, type InputAudioTrack } from 'mediabunny'
import { Resampler, remix } from '../core/audio/mix'

export class PcmStream {
  private queue: Float32Array[][] = []
  private queued = 0
  private iter: AsyncGenerator<AudioSample, void, unknown> | null = null
  private resampler: Resampler | null = null
  /** 入力側で次に来るはずのソース時刻（欠けた部分は無音で埋める） */
  private expected: number
  private done = false
  private readonly sink: AudioSampleSink
  private readonly start: number
  private readonly end: number
  readonly outRate: number
  readonly channels: number

  constructor(
    track: InputAudioTrack,
    start: number,
    end: number,
    outRate: number,
    channels: number,
  ) {
    this.sink = new AudioSampleSink(track)
    this.start = start
    this.end = end
    this.outRate = outRate
    this.channels = channels
    this.expected = start
  }

  /** ちょうど n フレームを返す。終わりの先は無音で埋める */
  async read(n: number): Promise<Float32Array[]> {
    while (this.queued < n && !this.done) await this.pull()
    const out = Array.from({ length: this.channels }, () => new Float32Array(n))
    let filled = 0
    while (filled < n && this.queue.length) {
      const head = this.queue[0]!
      const take = Math.min(n - filled, head[0]!.length)
      for (let ch = 0; ch < this.channels; ch++) out[ch]!.set(head[ch]!.subarray(0, take), filled)
      filled += take
      if (take === head[0]!.length) this.queue.shift()
      else this.queue[0] = head.map((c) => c.subarray(take))
    }
    this.queued -= filled
    return out
  }

  async close(): Promise<void> {
    this.done = true
    const it = this.iter
    this.iter = null
    this.queue = []
    await it?.return(undefined)
  }

  private push(planar: Float32Array[], rate: number) {
    if (!this.resampler || this.resampler.inRate !== rate)
      this.resampler = new Resampler(rate, this.outRate, this.channels)
    const out = this.resampler.push(remix(planar, this.channels))
    if (out[0]!.length) {
      this.queue.push(out)
      this.queued += out[0]!.length
    }
  }

  private async pull(): Promise<void> {
    this.iter ??= this.sink.samples(this.start, this.end)
    const r = await this.iter.next()
    if (r.done) {
      this.done = true
      return
    }
    const s = r.value
    try {
      const rate = s.sampleRate
      let from = 0
      let to = s.numberOfFrames
      if (s.timestamp < this.start)
        from = Math.min(to, Math.round((this.start - s.timestamp) * rate))
      const sEnd = s.timestamp + s.duration
      if (sEnd > this.end) to = Math.max(from, to - Math.round((sEnd - this.end) * rate))
      const gap = s.timestamp + from / rate - this.expected
      if (gap > 0.002) {
        const g = Math.round(gap * rate)
        this.push(
          Array.from({ length: s.numberOfChannels }, () => new Float32Array(g)),
          rate,
        )
      }
      if (to > from) {
        const planar: Float32Array[] = []
        for (let ch = 0; ch < s.numberOfChannels; ch++) {
          const buf = new Float32Array(s.numberOfFrames)
          s.copyTo(buf, { planeIndex: ch, format: 'f32-planar' })
          planar.push(buf.subarray(from, to))
        }
        this.push(planar, rate)
      }
      this.expected = Math.max(this.expected, s.timestamp + to / rate)
    } finally {
      s.close()
    }
  }
}

/** 素材のすべての音声トラックを足し合わせて読む（書き出し用・設計書 6.1） */
export class MultiTrackPcm {
  private readonly streams: PcmStream[]
  readonly channels: number

  constructor(
    tracks: InputAudioTrack[],
    start: number,
    end: number,
    outRate: number,
    channels: number,
  ) {
    this.streams = tracks.map((t) => new PcmStream(t, start, end, outRate, channels))
    this.channels = channels
  }

  async read(n: number): Promise<Float32Array[]> {
    const out = Array.from({ length: this.channels }, () => new Float32Array(n))
    for (const s of this.streams) {
      const pcm = await s.read(n)
      for (let ch = 0; ch < this.channels; ch++) {
        const o = out[ch]!
        const p = pcm[ch]!
        for (let i = 0; i < n; i++) o[i]! += p[i]!
      }
    }
    return out
  }

  async close(): Promise<void> {
    await Promise.all(this.streams.map((s) => s.close()))
  }
}
