/**
 * 文字起こし Worker（設計書 8.1）。Whisper（Transformers.js）。WebGPU を優先し、無ければ WASM。
 *
 * pcm16k は OPFS から窓ごとに読む。処理済みの窓は transcript-<モデル>.json にキャッシュし、
 * キャンセルしても次回はそこから再開する。
 */
import * as Comlink from 'comlink'
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { ANALYSIS_RATE } from '../core/cut/envelope'
import { asrWindows, windowKey } from '../core/subtitles/asrWindows'
import { chunksToSegments, type TranscriptSegment } from '../core/subtitles/transcript'
import type { Range } from '../core/time/time'
import { ASR_MODELS, MODEL_HOST, type AsrModelKey } from '../config'
// onnxruntime-web の WASM は CDN ではなく自前で配信する（COEP のため・設計書 3章）
import ortMjs from '/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from '/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url'
import { cacheDir, readJson, writeBytes } from '../storage/opfs'
import { CancelledError, type Progress } from './common'

env.allowLocalModels = false
env.useBrowserCache = true
env.remoteHost = MODEL_HOST
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown } }
if (onnx.wasm) onnx.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }

type WindowCache = Record<string, TranscriptSegment[]>

let cancelled = false
let asr: AutomaticSpeechRecognitionPipeline | null = null
let loadedModel: string | null = null

async function webGpuAvailable(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
  if (!gpu) return false
  try {
    return (await gpu.requestAdapter()) != null
  } catch {
    return false
  }
}

async function release() {
  if (asr) await asr.dispose().catch(() => {})
  asr = null
  loadedModel = null
}

/** ダウンロードに失敗したときに、途中までキャッシュされたモデルを捨てる */
async function discardModelCache(modelId: string) {
  try {
    const c = await caches.open('transformers-cache')
    for (const req of await c.keys()) if (req.url.includes(modelId)) await c.delete(req)
  } catch {
    /* Cache Storage が使えない */
  }
}

async function load(modelKey: AsrModelKey, onProgress: Progress): Promise<'webgpu' | 'wasm'> {
  const model = ASR_MODELS[modelKey]
  const gpu = await webGpuAvailable()
  if (model.needsGpu && !gpu)
    throw new Error(`${model.label} は GPU（WebGPU）が必要です。別のモデルを選んでください。`)
  const device = gpu ? 'webgpu' : 'wasm'
  if (asr && loadedModel === model.id) return device
  // 別のモデルを読み込む前に、古いものを解放する（設計書 12.5）
  await release()
  const files = new Map<string, { loaded: number; total: number }>()
  try {
    asr = (await pipeline('automatic-speech-recognition', model.id, {
      device,
      dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: (p: {
        status: string
        file?: string
        loaded?: number
        total?: number
      }) => {
        if (p.status !== 'progress' || !p.file) return
        files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        if (total > 0)
          onProgress(
            0,
            `モデルをダウンロードしています（${Math.round(loaded / 1e6)} / ${Math.round(total / 1e6)} MB）`,
          )
      },
    })) as AutomaticSpeechRecognitionPipeline
  } catch (e) {
    await discardModelCache(model.id)
    throw new Error(
      `モデルのダウンロードに失敗しました。通信状態を確認して、もう一度試してください。（${e instanceof Error ? e.message : e}）`,
    )
  }
  loadedModel = model.id
  return device
}

async function transcribe(
  key: string,
  ranges: Range[],
  envelope: Float32Array,
  modelKey: AsrModelKey,
  onProgress: Progress,
): Promise<{ segments: TranscriptSegment[]; device: 'webgpu' | 'wasm' }> {
  cancelled = false
  const dir = await cacheDir(key, false)
  if (!dir) throw new Error('解析が終わっていません。解析が終わってから文字起こししてください。')
  const cacheName = `transcript-${modelKey}.json`
  const cache: WindowCache = (await readJson<WindowCache>(dir, cacheName)) ?? {}
  const windows = asrWindows(envelope, ranges)
  const todo = windows.filter((w) => !cache[windowKey(w)])
  const device = todo.length ? await load(modelKey, onProgress) : 'wasm'

  const fh = await dir.getFileHandle('pcm16k.i16')
  const handle = await fh.createSyncAccessHandle()
  try {
    const totalLen = windows.reduce((s, w) => s + (w.end - w.start), 0) || 1
    let done = windows.filter((w) => cache[windowKey(w)]).reduce((s, w) => s + (w.end - w.start), 0)
    let sinceSave = 0
    for (const w of todo) {
      if (cancelled) throw new CancelledError()
      const a = Math.floor(w.start * ANALYSIS_RATE)
      const b = Math.ceil(w.end * ANALYSIS_RATE)
      const i16 = new Int16Array(b - a)
      handle.read(i16, { at: a * 2 })
      const audio = Float32Array.from(i16, (v) => v / 32767)
      const out = (await asr!(audio, {
        language: 'japanese',
        task: 'transcribe',
        return_timestamps: true,
        chunk_length_s: 30,
        stride_length_s: 5,
      })) as { text: string; chunks?: { text: string; timestamp: [number, number | null] }[] }
      const chunks = out.chunks?.length
        ? out.chunks
        : [{ text: out.text, timestamp: [0, w.end - w.start] as [number, number] }]
      cache[windowKey(w)] = chunksToSegments(chunks, w.start, w.end)
      done += w.end - w.start
      onProgress(done / totalLen, '文字起こししています')
      // 処理済みの窓はこまめに保存する（キャンセル・クラッシュしても再利用できる）
      if (++sinceSave >= 5) {
        await writeBytes(dir, cacheName, JSON.stringify(cache))
        sinceSave = 0
      }
    }
  } finally {
    handle.close()
    await writeBytes(dir, cacheName, JSON.stringify(cache)).catch(() => {})
  }
  const segments = windows.flatMap((w) => cache[windowKey(w)] ?? [])
  return { segments, device }
}

const api = {
  transcribe,
  webGpuAvailable,
  release,
  cancel() {
    cancelled = true
  },
}

export type AsrApi = typeof api
Comlink.expose(api)
