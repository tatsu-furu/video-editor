/**
 * 音声解析 Worker（設計書 7.1・7.2）。
 *
 * 1. 解析対象の音声トラックをチャンク単位でデコードし、16kHz モノラル Int16 を OPFS に書く（pcm16k）。
 * 2. その PCM を読み直しながら、エンベロープ（20ms）、ラウドネスのブロック（100ms）、VAD を計算する。
 * 3. 結果をキャッシュに保存する。同じファイル（fingerprint）なら次回は再解析しない。
 */
import * as Comlink from 'comlink'
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny'
import * as ort from 'onnxruntime-web/wasm'
import { ANALYSIS_RATE, HOP, WIN, toDb } from '../core/cut/envelope'
import { VAD_FRAME, energyVadProbs, speechSegments } from '../core/cut/vad'
import { LoudnessMeter } from '../core/audio/loudness'
import type { Range } from '../core/time/time'
import { SILERO_VAD_URL } from '../config'
import { PcmStream } from '../media/pcm'
import { cacheDir, readBytes, readJson, removeEntry, writeBytes } from '../storage/opfs'
import { CancelledError, type Progress } from './common'

export interface AnalysisResult {
  /** 20ms ごとの dBFS */
  envelope: Float32Array
  /** 100ms ごとの K 特性二乗平均（16kHz モノラル）。残っている区間のラウドネス計算に使う */
  blocks: Float32Array
  /** 発話区間（ソース時刻） */
  speech: Range[]
  vadSource: 'silero' | 'energy'
  duration: number
}

const CACHE_VERSION = 2
const CHUNK = ANALYSIS_RATE * 10

let cancelled = false
const check = () => {
  if (cancelled) throw new CancelledError()
}

ort.env.wasm.numThreads = self.crossOriginIsolated
  ? Math.min(4, navigator.hardwareConcurrency || 1)
  : 1

async function loadSilero(): Promise<ort.InferenceSession | null> {
  try {
    const res = await fetch(SILERO_VAD_URL, { cache: 'force-cache' })
    if (!res.ok) return null
    return await ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), {
      executionProviders: ['wasm'],
    })
  } catch {
    return null
  }
}

/** Silero VAD（v5）を 512 サンプルずつ流す。前の 64 サンプルを文脈として付ける */
class SileroRunner {
  private state: ort.Tensor = new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  private readonly sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), [])
  private context = new Float32Array(64)
  private readonly session: ort.InferenceSession
  constructor(session: ort.InferenceSession) {
    this.session = session
  }
  async prob(frame: Float32Array): Promise<number> {
    const x = new Float32Array(64 + 512)
    x.set(this.context)
    x.set(frame, 64)
    this.context = frame.slice(512 - 64)
    const [inName, stateName, srName] = this.session.inputNames
    const out = await this.session.run({
      [inName!]: new ort.Tensor('float32', x, [1, x.length]),
      [stateName!]: this.state,
      [srName!]: this.sr,
    })
    const [probName, stateOut] = this.session.outputNames
    this.state = out[stateOut!] as ort.Tensor
    return (out[probName!]!.data as Float32Array)[0]!
  }
}

async function analyze(
  file: File,
  trackIndex: number,
  key: string,
  onProgress: Progress,
): Promise<AnalysisResult> {
  cancelled = false
  const dir = await cacheDir(key)
  if (!dir) throw new Error('ブラウザ内ストレージ（OPFS）が使えません。')

  // キャッシュがあれば使う
  const meta = await readJson<{
    v: number
    duration: number
    speech: Range[]
    vadSource: AnalysisResult['vadSource']
  }>(dir, 'meta.json')
  if (meta?.v === CACHE_VERSION) {
    const env = await readBytes(dir, 'envelope.f32')
    const blocks = await readBytes(dir, 'blocks.f32')
    const pcmOk = await dir.getFileHandle('pcm16k.i16').then(
      () => true,
      () => false,
    )
    if (env && blocks && pcmOk) {
      onProgress(1, 'キャッシュを使いました')
      return {
        envelope: new Float32Array(env),
        blocks: new Float32Array(blocks),
        speech: meta.speech,
        vadSource: meta.vadSource,
        duration: meta.duration,
      }
    }
  }
  await removeEntry(dir, 'meta.json')

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  let handle: FileSystemSyncAccessHandle | null = null
  let complete = false
  try {
    const tracks = await input.getAudioTracks()
    const track = tracks[trackIndex] ?? tracks[0]
    const duration = await input.computeDuration()
    const total = Math.ceil(duration * ANALYSIS_RATE)
    const fh = await dir.getFileHandle('pcm16k.i16', { create: true })
    handle = await fh.createSyncAccessHandle()
    handle.truncate(0)

    // 1. デコードして Int16 で書き出す
    const stream = track ? new PcmStream(track, 0, duration, ANALYSIS_RATE, 1) : null
    try {
      for (let pos = 0; pos < total; pos += CHUNK) {
        check()
        const n = Math.min(CHUNK, total - pos)
        const mono = stream ? (await stream.read(n))[0]! : new Float32Array(n)
        const i16 = new Int16Array(n)
        for (let i = 0; i < n; i++)
          i16[i] = Math.max(-32768, Math.min(32767, Math.round(mono[i]! * 32767)))
        handle.write(i16, { at: pos * 2 })
        onProgress((0.6 * (pos + n)) / total, '音声を読み込んでいます')
      }
    } finally {
      await stream?.close()
    }
    handle.flush()

    // 2. 読み直しながら解析する
    const hop = Math.round(ANALYSIS_RATE * HOP)
    const half = Math.round((ANALYSIS_RATE * WIN) / 2)
    const envelope = new Float32Array(Math.ceil(total / hop))
    const meter = new LoudnessMeter(ANALYSIS_RATE, 1)
    const session = await loadSilero()
    const silero = session ? new SileroRunner(session) : null
    const probs: number[] = []
    const vadBuf = new Float32Array(512)
    let vadFill = 0
    const readF32 = (from: number, to: number): Float32Array => {
      const a = Math.max(0, from)
      const b = Math.min(total, to)
      const i16 = new Int16Array(Math.max(0, b - a))
      handle!.read(i16, { at: a * 2 })
      const out = new Float32Array(to - from)
      for (let i = 0; i < i16.length; i++) out[a - from + i] = i16[i]! / 32767
      return out
    }
    for (let pos = 0; pos < total; pos += CHUNK) {
      check()
      const n = Math.min(CHUNK, total - pos)
      // 窓が前後のチャンクにはみ出すので、余分に読む
      const buf = readF32(pos - half, pos + n + half)
      const firstFrame = Math.ceil(pos / hop)
      const lastFrame = Math.ceil((pos + n) / hop)
      for (let f = firstFrame; f < lastFrame; f++) {
        const center = f * hop + hop / 2
        const a = Math.max(0, Math.round(center - half))
        const b = Math.min(total, Math.round(center + half))
        let sum = 0
        for (let j = a; j < b; j++) {
          const v = buf[j - (pos - half)]!
          sum += v * v
        }
        envelope[f] = toDb(Math.sqrt(sum / Math.max(1, b - a)))
      }
      const body = buf.subarray(half, half + n)
      meter.push([body])
      if (silero) {
        for (let i = 0; i < n; i++) {
          vadBuf[vadFill++] = body[i]!
          if (vadFill === 512) {
            probs.push(await silero.prob(vadBuf))
            vadFill = 0
          }
        }
      }
      onProgress(
        0.6 + (0.4 * (pos + n)) / total,
        silero ? '話し声を探しています' : '音量を解析しています',
      )
    }
    await session?.release()

    let speech: Range[]
    let vadSource: AnalysisResult['vadSource']
    if (silero) {
      speech = speechSegments(probs, VAD_FRAME)
      vadSource = 'silero'
    } else {
      const e = energyVadProbs(envelope)
      speech = speechSegments(e.probs, e.frame)
      vadSource = 'energy'
    }
    const blocks = Float32Array.from(meter.blocks)
    await writeBytes(dir, 'envelope.f32', envelope)
    await writeBytes(dir, 'blocks.f32', blocks)
    await writeBytes(
      dir,
      'meta.json',
      JSON.stringify({ v: CACHE_VERSION, duration, speech, vadSource }),
    )
    complete = true
    return Comlink.transfer({ envelope, blocks, speech, vadSource, duration }, [
      envelope.buffer,
      blocks.buffer,
    ])
  } finally {
    handle?.close()
    input.dispose()
    if (!complete) await removeEntry(dir, 'pcm16k.i16')
  }
}

/** BGM のラウドネス（48kHz ステレオで測る） */
async function measureLoudness(channels: Float32Array[], sampleRate: number): Promise<number> {
  const m = new LoudnessMeter(sampleRate, channels.length)
  const step = sampleRate
  const n = channels[0]?.length ?? 0
  for (let i = 0; i < n; i += step)
    m.push(channels.map((c) => c.subarray(i, Math.min(n, i + step))))
  return m.integrated()
}

/** タイムライン用のサムネイル（間引き）。times はソース時刻 */
async function thumbnails(
  file: File,
  times: number[],
  height: number,
): Promise<{ t: number; bitmap: ImageBitmap }[]> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const out: { t: number; bitmap: ImageBitmap }[] = []
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return []
    const sink = new CanvasSink(track, { height, poolSize: 1 })
    let i = 0
    for await (const c of sink.canvasesAtTimestamps(times)) {
      const t = times[i++]!
      if (!c) continue
      out.push({ t, bitmap: await createImageBitmap(c.canvas) })
    }
  } finally {
    input.dispose()
  }
  return Comlink.transfer(
    out,
    out.map((o) => o.bitmap),
  )
}

const api = {
  analyze,
  thumbnails,
  measureLoudness,
  cancel() {
    cancelled = true
  },
}

export type AnalysisApi = typeof api
Comlink.expose(api)
