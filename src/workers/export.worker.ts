/**
 * 書き出し Worker（設計書 10章）。
 *
 * 1回目：音声だけをミックスして全体のラウドネス（LUFS）を測る。
 * 2回目：映像（OffscreenCanvas に描いて字幕を合成）と、正規化＋リミッターを通した音声を
 *        タイムライン時刻で交互にエンコードし、MP4 にまとめる。
 * 背圧は Mediabunny の add() を await することで取る（エンコーダが詰まっていれば待たされる）。
 */
import * as Comlink from 'comlink'
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  StreamTarget,
  canEncodeAudio,
  canEncodeVideo,
  type InputVideoTrack,
  type StreamTargetChunk,
} from 'mediabunny'
import { bgmTaps, dbToGain, evalCurve, fadeGain, type GainPoint } from '../core/audio/ducking'
import { Limiter } from '../core/audio/limiter'
import { LoudnessMeter } from '../core/audio/loudness'
import { normalizeGainDb } from '../core/audio/mix'
import type { AudioMix, BgmClip, Project, SubtitleStyle } from '../core/project/types'
import type { TimelineCue } from '../core/subtitles/split'
import { placeClips, totalDuration, type PlacedClip } from '../core/time/time'
import { MultiTrackPcm } from '../media/pcm'
import { loadGlyphs, registerFonts } from '../render/fonts'
import { fitRect } from '../render/letterbox'
import { cueText, renderSubtitles } from '../render/subtitles'
import { CancelledError, type Progress } from './common'

const RATE = 48000

export type ExportQuality = 'high' | 'standard' | 'light'

export interface ExportJob {
  project: Pick<Project, 'videoTrack' | 'bgmTrack' | 'assets'>
  width: number
  height: number
  fps: number
  quality: ExportQuality
  burnSubtitles: boolean
  style: SubtitleStyle
  cues: TimelineCue[]
  mix: AudioMix
  duck: GainPoint[]
  /** 元音声に掛けるゲイン（dB） */
  voiceGainDb: number
  /** BGM ごとのゲイン（dB） */
  bgmGainDb: Record<string, number>
  files: Record<string, File>
  /** デコード済みの BGM（48kHz・2ch） */
  bgmPcm: Record<string, Float32Array[]>
  /** 保存先。無ければメモリ上に作って Blob で返す */
  handle?: FileSystemFileHandle
}

export interface ExportResult {
  blob?: Blob
  videoCodec: string
  audioCodec: string | null
  lufs: number
}

const QUALITY = { high: QUALITY_HIGH, standard: QUALITY_MEDIUM, light: QUALITY_LOW }

let cancelled = false
const check = () => {
  if (cancelled) throw new CancelledError()
}

class Inputs {
  private readonly map = new Map<string, Input>()
  private readonly files: Record<string, File>
  constructor(files: Record<string, File>) {
    this.files = files
  }
  get(assetId: string): Input {
    let i = this.map.get(assetId)
    if (!i) {
      const f = this.files[assetId]
      if (!f)
        throw new Error(
          '素材のファイルが見つかりません。プロジェクトを開き直して、素材を選び直してください。',
        )
      i = new Input({ source: new BlobSource(f), formats: ALL_FORMATS })
      this.map.set(assetId, i)
    }
    return i
  }
  dispose() {
    for (const i of this.map.values()) i.dispose()
    this.map.clear()
  }
}

/** タイムラインの頭から順に、ミックス済みのステレオ音声を返す */
class Mixer {
  private readonly placed: PlacedClip[]
  private clipIdx = -1
  private clipStream: MultiTrackPcm | null = null
  private clipEndFrame = 0
  private clipGain = 1
  private pos = 0
  private readonly job: ExportJob
  private readonly inputs: Inputs
  private readonly voiceGain: number

  constructor(job: ExportJob, inputs: Inputs) {
    this.job = job
    this.inputs = inputs
    this.placed = placeClips(job.project.videoTrack)
    this.voiceGain = dbToGain(job.voiceGainDb)
  }

  async read(n: number): Promise<Float32Array[]> {
    const out = [new Float32Array(n), new Float32Array(n)]
    let filled = 0
    while (filled < n) {
      if (this.pos + filled >= this.clipEndFrame) {
        await this.nextClip()
        continue
      }
      const take = Math.min(n - filled, this.clipEndFrame - (this.pos + filled))
      if (this.clipStream) {
        const pcm = await this.clipStream.read(take)
        const g = this.clipGain
        for (let ch = 0; ch < 2; ch++) {
          const o = out[ch]!
          const s = pcm[ch]!
          for (let i = 0; i < take; i++) o[filled + i] = s[i]! * g
        }
      }
      filled += take
    }
    this.addBgm(out)
    this.pos += n
    return out
  }

  private async nextClip(): Promise<void> {
    await this.clipStream?.close()
    this.clipStream = null
    const p = this.placed[++this.clipIdx]
    if (!p) {
      this.clipEndFrame = Infinity
      return
    }
    this.clipEndFrame = Math.round(p.end * RATE)
    this.clipGain = p.clip.muted ? 0 : dbToGain(p.clip.gainDb) * this.voiceGain
    const tracks = await this.inputs.get(p.clip.assetId).getAudioTracks()
    if (tracks.length)
      this.clipStream = new MultiTrackPcm(tracks, p.clip.sourceIn, p.clip.sourceOut, RATE, 2)
  }

  private addBgm(out: Float32Array[]) {
    const n = out[0]!.length
    for (const clip of this.job.project.bgmTrack as BgmClip[]) {
      const pcm = this.job.bgmPcm[clip.assetId]
      if (!pcm) continue
      const len = pcm[0]!.length
      const duration = len / RATE
      const base = dbToGain(this.job.bgmGainDb[clip.assetId] ?? 0)
      const t0 = this.pos / RATE
      const t1 = (this.pos + n) / RATE
      if (t1 <= clip.timelineStart || t0 >= clip.timelineEnd) continue
      for (let i = 0; i < n; i++) {
        const t = (this.pos + i) / RATE
        const taps = bgmTaps(clip, t, duration)
        if (taps.length === 0) continue
        // ゲインの計算は 64 サンプルに1回で十分
        const g = base * dbToGain(evalCurve(this.job.duck, t)) * fadeGain(clip, t)
        for (const tap of taps) {
          const k = Math.min(len - 1, Math.floor(tap.pos * RATE))
          const w = g * tap.weight
          out[0]![i]! += pcm[0]![k]! * w
          out[1]![i]! += (pcm[1] ?? pcm[0]!)[k]! * w
        }
      }
    }
  }

  async close() {
    await this.clipStream?.close()
    this.clipStream = null
  }
}

function fmt(t: number): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

async function run(job: ExportJob, onProgress: Progress): Promise<ExportResult> {
  cancelled = false
  const inputs = new Inputs(job.files)
  let output: Output | null = null
  let writable: FileSystemWritableFileStream | null = null
  let finished = false
  let currentTime = 0
  try {
    const { width, height, fps } = job
    const duration = totalDuration(job.project.videoTrack)
    if (duration <= 0) throw new Error('タイムラインが空です。')
    const totalAudio = Math.ceil(duration * RATE)

    // コーデックの確認（設計書 10.1）
    const bitrate = QUALITY[job.quality]
    // H.264 を優先し、使えない環境（Linux 版 Chromium など）では VP9 → AV1 で書き出す
    let videoCodec: 'avc' | 'vp9' | 'av1' | null = null
    for (const c of ['avc', 'vp9', 'av1'] as const)
      if (await canEncodeVideo(c, { width, height, bitrate })) {
        videoCodec = c
        break
      }
    if (!videoCodec)
      throw new Error(
        `このブラウザでは ${width}×${height} の映像を書き出せません。解像度を下げるか、最新版の Chrome / Edge を使ってください。`,
      )
    const audioCodec = (await canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: RATE }))
      ? 'aac'
      : (await canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: RATE }))
        ? 'opus'
        : null

    // 字幕フォントを読み込んでから始める（プレビューと見た目を合わせる）
    if (job.burnSubtitles && job.cues.length) {
      const fonts = (self as unknown as { fonts: FontFaceSet }).fonts
      registerFonts(fonts)
      await loadGlyphs(fonts, job.style.fontWeight, cueText(job.cues))
    }

    // 1回目：ラウドネスを測る
    const meter = new LoudnessMeter(RATE, 2)
    const m1 = new Mixer(job, inputs)
    try {
      for (let p = 0; p < totalAudio; p += RATE) {
        check()
        meter.push(await m1.read(Math.min(RATE, totalAudio - p)))
        onProgress((0.1 * p) / totalAudio, '音量を測っています')
      }
    } finally {
      await m1.close()
    }
    const lufs = meter.integrated()
    const norm = dbToGain(normalizeGainDb(lufs, job.mix))

    // 2回目：エンコード
    let target: BufferTarget | StreamTarget
    if (job.handle) {
      writable = await job.handle.createWritable()
      target = new StreamTarget(writable as unknown as WritableStream<StreamTargetChunk>, {
        chunked: true,
      })
    } else target = new BufferTarget()
    output = new Output({
      format: new Mp4OutputFormat({ fastStart: job.handle ? false : 'in-memory' }),
      target,
    })
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false })!
    const videoSource = new CanvasSource(canvas, {
      codec: videoCodec,
      bitrate,
      keyFrameInterval: 2,
    })
    output.addVideoTrack(videoSource, { frameRate: fps })
    const audioSource = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate }) : null
    if (audioSource) output.addAudioTrack(audioSource)
    await output.start()

    const mixer = new Mixer(job, inputs)
    const limiter = new Limiter(RATE, job.mix.truePeakDb - 0.5)
    let audioIn = 0
    let audioOut = 0
    const addAudio = async (l: Float32Array, r: Float32Array) => {
      const n = l.length
      if (!audioSource || n === 0) return
      const data = new Float32Array(n * 2)
      data.set(l)
      data.set(r, n)
      const sample = new AudioSample({
        data,
        format: 'f32-planar',
        numberOfChannels: 2,
        sampleRate: RATE,
        timestamp: audioOut / RATE,
      })
      try {
        await audioSource.add(sample)
      } finally {
        sample.close()
      }
      audioOut += n
    }
    /** タイムライン時刻 until までの音声をエンコードする（リミッターの遅延分は先に読む） */
    const pumpAudio = async (until: number) => {
      if (!audioSource) return
      const want = Math.min(totalAudio, Math.ceil(until * RATE))
      while (audioIn < want) {
        const n = Math.min(RATE / 2, totalAudio - audioIn)
        const [l, r] = await mixer.read(n)
        for (let i = 0; i < n; i++) {
          l![i]! *= norm
          r![i]! *= norm
        }
        const [ol, or] = limiter.push([l!, r!])
        await addAudio(ol!, or!)
        audioIn += n
        if (audioIn >= totalAudio) {
          const [fl, fr] = limiter.flush()
          await addAudio(fl!, fr!)
        }
      }
    }

    const totalFrames = Math.max(1, Math.round(duration * fps))
    const started = Date.now()
    try {
      for (const p of placeClips(job.project.videoTrack)) {
        const vTrack: InputVideoTrack | null = await inputs
          .get(p.clip.assetId)
          .getPrimaryVideoTrack()
        const rect = vTrack
          ? fitRect(vTrack.displayWidth, vTrack.displayHeight, width, height)
          : null
        const sink =
          vTrack && rect
            ? new CanvasSink(vTrack, { width: rect.w, height: rect.h, fit: 'fill', poolSize: 2 })
            : null
        // フレーム番号はタイムライン時刻から計算する（クリップ境界ごとに再計算して A/V ずれを防ぐ）
        const first = Math.round(p.start * fps)
        const last = Math.min(totalFrames, Math.round(p.end * fps))
        const times = function* () {
          for (let k = first; k < last; k++) yield p.clip.sourceIn + Math.max(0, k / fps - p.start)
        }
        const iter = sink ? sink.canvasesAtTimestamps(times()) : null
        try {
          for (let k = first; k < last; k++) {
            check()
            const t = k / fps
            currentTime = t
            const wrapped = iter ? (await iter.next()).value : null
            ctx.fillStyle = '#000'
            ctx.fillRect(0, 0, width, height)
            if (wrapped && rect) ctx.drawImage(wrapped.canvas, rect.x, rect.y, rect.w, rect.h)
            if (job.burnSubtitles)
              renderSubtitles(ctx, job.cues, t + 0.5 / fps, job.style, width, height)
            await videoSource.add(t, 1 / fps)
            await pumpAudio(t + 1)
            if (k % 10 === 0) {
              const r = 0.1 + (0.9 * k) / totalFrames
              const elapsed = (Date.now() - started) / 1000
              const remain = k > first + 30 ? (elapsed / (k + 1)) * (totalFrames - k) : null
              onProgress(
                r,
                remain != null ? `書き出しています（残り 約${fmt(remain)}）` : '書き出しています',
              )
            }
          }
        } finally {
          await iter?.return(undefined)
        }
      }
      await pumpAudio(duration + 1)
    } finally {
      await mixer.close()
    }
    videoSource.close()
    audioSource?.close()
    await output.finalize()
    finished = true
    const blob =
      target instanceof BufferTarget && target.buffer
        ? new Blob([target.buffer], { type: 'video/mp4' })
        : undefined
    onProgress(1, '書き出しました')
    return { blob, videoCodec, audioCodec, lufs }
  } catch (e) {
    if (e instanceof CancelledError) throw e
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${fmt(currentTime)} 付近で書き出しに失敗しました：${msg}`)
  } finally {
    inputs.dispose()
    if (!finished) {
      // 書きかけのファイルを残さない（設計書 12.6）
      await output?.cancel().catch(() => {})
      await writable?.abort().catch(() => {})
      const h = job.handle as (FileSystemFileHandle & { remove?: () => Promise<void> }) | undefined
      await h?.remove?.().catch(() => {})
    }
  }
}

const api = {
  run,
  cancel() {
    cancelled = true
  },
}

export type ExportApi = typeof api
Comlink.expose(api)
