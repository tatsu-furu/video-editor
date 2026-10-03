/**
 * 重い処理の起動と進捗（設計書 4章・12.5・12.6）。UI はここの関数を呼ぶだけで、Worker を直接触らない。
 *
 * - 音声解析は編集中もバックグラウンドで順番に実行する。
 * - 文字起こしと書き出しは同時に実行しない（session.job が埋まっていれば断る）。
 */
import * as Comlink from 'comlink'
import { createProject } from '../core/project/create'
import * as ops from '../core/project/ops'
import type { Asset, Id, Project } from '../core/project/types'
import {
  HIGHLIGHT_DEFAULTS,
  SILENCE_DEFAULTS,
  highlightCandidates,
  silenceCandidates,
} from '../core/cut/candidates'
import { asrTargets } from '../core/subtitles/asrWindows'
import { buildSubtitles, SPLIT_DEFAULTS } from '../core/subtitles/split'
import { toSrt } from '../core/subtitles/srt'
import { filterHallucinations } from '../core/subtitles/transcript'
import { keptSourceRanges, totalDuration } from '../core/time/time'
import type { AsrModelKey } from '../config'
import { probeFile, UnsupportedFileError } from '../media/probe'
import { loadHandle, loadProject, saveHandle } from '../storage/db'
import { matchesAsset } from '../storage/fingerprint'
import { cacheKey } from '../storage/opfs'
import type { AnalysisApi } from '../workers/analysis.worker'
import type { AsrApi } from '../workers/asr.worker'
import { isCancelled } from '../workers/common'
import type { ExportApi, ExportJob, ExportQuality } from '../workers/export.worker'
import { cues, duckCurve, gains } from './derived'
import { edit, editSilently, openProject, saveNow, useProject } from './project'
import { resetSession, setFile, toast, useSession, type JobState } from './session'

/* ---------- Worker ---------- */

/** Worker を起動する。クラッシュ（メモリ不足など）したら処理を中断して知らせる（設計書 12.3） */
function spawn<T>(
  make: () => Worker,
  onCrash: () => void,
): { api: Comlink.Remote<T>; worker: Worker } {
  const worker = make()
  worker.addEventListener('error', (e) => {
    e.preventDefault()
    worker.terminate()
    onCrash()
    useSession.setState({ job: null })
    toast(
      '処理が途中で止まりました（メモリ不足の可能性があります）。プロジェクトは自動保存された状態のままです。',
      'error',
    )
  })
  return { api: Comlink.wrap<T>(worker), worker }
}

/** 保存領域の不足などを分かりやすい言葉にする */
function describe(e: unknown): string {
  if (e instanceof DOMException && e.name === 'QuotaExceededError')
    return 'ブラウザ内の保存領域が足りません。「⑤書き出し」の「キャッシュを削除する」で解析キャッシュを消してから、もう一度試してください。'
  const msg = e instanceof Error ? e.message : String(e)
  return /quota/i.test(msg)
    ? 'ブラウザ内の保存領域が足りません。「⑤書き出し」の「キャッシュを削除する」で解析キャッシュを消してから、もう一度試してください。'
    : msg
}

let analysisW: { api: Comlink.Remote<AnalysisApi>; worker: Worker } | null = null
const analysis = () =>
  (analysisW ??= spawn<AnalysisApi>(
    () =>
      new Worker(new URL('../workers/analysis.worker.ts', import.meta.url), {
        type: 'module',
        name: 'analysis',
      }),
    () => {
      analysisW = null
      analysisQueue = Promise.resolve()
    },
  )).api

/* ---------- 自動カットのパラメータ ---------- */

export interface CutParams {
  minSilence: number
  thresholdDb: number
  /** 目標の長さ（分）。0 なら指定なし */
  targetMinutes: number
}

export const cutParams: CutParams = {
  minSilence: SILENCE_DEFAULTS.minSilence,
  thresholdDb: HIGHLIGHT_DEFAULTS.thresholdDb,
  targetMinutes: 0,
}

/** 解析結果から候補を作り直す（pending のものだけ置き換わる） */
export function recomputeSuggestions(assetId?: Id): void {
  const p = useProject.getState().project
  if (!p) return
  const ids = assetId
    ? [assetId]
    : Object.keys(p.assets).filter((id) => p.assets[id]!.kind === 'video')
  for (const id of ids) {
    const a = p.assets[id]
    const r = useSession.getState().analysis[id]?.result
    if (!a || !r) continue
    const cands =
      p.mode === 'talk'
        ? silenceCandidates(r.speech, r.envelope, a.duration, {
            ...SILENCE_DEFAULTS,
            minSilence: cutParams.minSilence,
          })
        : highlightCandidates(r.envelope, r.speech, a.duration, {
            thresholdDb: cutParams.thresholdDb,
            targetLength:
              cutParams.targetMinutes > 0
                ? (cutParams.targetMinutes * 60 * a.duration) / totalAssetDuration(p)
                : undefined,
            micTrack: a.audioTracks.length > 1 && a.analysisAudioTrack > 0,
          })
    editSilently(ops.replaceSuggestions, id, cands)
  }
}

/** 目標の長さを複数素材に按分するための合計 */
function totalAssetDuration(p: Project): number {
  return Object.values(p.assets)
    .filter((a) => a.kind === 'video')
    .reduce((s, a) => s + a.duration, 0)
}

/* ---------- 解析 ---------- */

let analysisQueue: Promise<void> = Promise.resolve()

export function analyzeAsset(assetId: Id): void {
  const set = (
    patch: Partial<NonNullable<ReturnType<typeof useSession.getState>['analysis'][Id]>>,
  ) => {
    const cur = useSession.getState().analysis[assetId] ?? {
      status: 'waiting' as const,
      progress: 0,
    }
    useSession.setState({
      analysis: { ...useSession.getState().analysis, [assetId]: { ...cur, ...patch } },
    })
  }
  set({ status: 'waiting', progress: 0, error: undefined })
  analysisQueue = analysisQueue.then(async () => {
    const p = useProject.getState().project
    const asset = p?.assets[assetId]
    const file = useSession.getState().files[assetId]
    if (!asset || !file) return
    set({ status: 'running' })
    try {
      const result = await analysis().analyze(
        file,
        asset.analysisAudioTrack,
        cacheKey(asset, asset.analysisAudioTrack),
        Comlink.proxy((progress: number, label?: string) => set({ progress, label })),
      )
      set({ status: 'done', progress: 1, result })
      const now = useProject.getState().project
      const hasPending = now?.suggestions.some((s) => s.assetId === assetId)
      if (!hasPending) recomputeSuggestions(assetId)
      // 初回体験：解析が終わったらカットのステップへ（設計書 11.2）
      if (useSession.getState().step === 'import') useSession.setState({ step: 'cut' })
      void makeThumbs(assetId)
    } catch (e) {
      if (isCancelled(e)) set({ status: 'waiting', progress: 0 })
      else set({ status: 'error', error: describe(e) })
    }
  })
}

async function makeThumbs(assetId: Id) {
  const p = useProject.getState().project
  const a = p?.assets[assetId]
  const file = useSession.getState().files[assetId]
  if (!a || !file || useSession.getState().thumbs[assetId]) return
  const count = Math.min(120, Math.max(2, Math.ceil(a.duration / 10)))
  const times = Array.from({ length: count }, (_, i) => (a.duration * (i + 0.5)) / count)
  try {
    const thumbs = await analysis().thumbnails(file, times, 48)
    useSession.setState({ thumbs: { ...useSession.getState().thumbs, [assetId]: thumbs } })
  } catch {
    /* サムネイルは無くても編集できる */
  }
}

/* ---------- 読み込み ---------- */

export async function newProject(mode: Project['mode']): Promise<void> {
  resetSession()
  const p = createProject()
  p.mode = mode
  openProject(p)
  await saveNow()
}

/** 動画ファイルを読み込んで末尾に足す（設計書 6.1） */
export async function importVideos(
  items: { file: File; handle?: FileSystemFileHandle }[],
): Promise<void> {
  for (const { file, handle } of items) {
    try {
      const asset = await probeFile(file, 'video')
      if (handle) {
        asset.handleKey = asset.id
        await saveHandle(asset.id, handle).catch(() => (asset.handleKey = undefined))
      }
      setFile(asset.id, file)
      edit(ops.addVideoAsset, asset)
      analyzeAsset(asset.id)
    } catch (e) {
      toast(
        e instanceof UnsupportedFileError
          ? e.message
          : `${file.name} を読み込めませんでした：${e instanceof Error ? e.message : e}`,
        'error',
      )
    }
  }
}

/** BGM を読み込む（全体をデコードして AudioBuffer で持つ・設計書 9.1） */
export async function importBgm(file: File, handle?: FileSystemFileHandle): Promise<void> {
  try {
    const asset = await probeFile(file, 'audio')
    if (handle) {
      asset.handleKey = asset.id
      await saveHandle(asset.id, handle).catch(() => (asset.handleKey = undefined))
    }
    setFile(asset.id, file)
    await decodeBgm(asset.id, file)
    edit(ops.addBgm, asset)
  } catch (e) {
    toast(
      e instanceof UnsupportedFileError
        ? e.message
        : `${file.name} を BGM として読み込めませんでした：${e instanceof Error ? e.message : e}`,
      'error',
    )
  }
}

async function decodeBgm(assetId: Id, file: File) {
  const ctx = new OfflineAudioContext(2, 1, 48000)
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer())
  const channels = [0, 1].map((c) =>
    buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)).slice(),
  )
  const lufs = await analysis().measureLoudness(
    Comlink.transfer(
      channels,
      channels.map((c) => c.buffer),
    ),
    48000,
  )
  useSession.setState({ bgm: { ...useSession.getState().bgm, [assetId]: { buffer, lufs } } })
}

/** 解析トラックを変えたら解析し直す */
export function changeAnalysisTrack(assetId: Id, index: number): void {
  edit(ops.setAnalysisTrack, assetId, index)
  analyzeAsset(assetId)
}

/* ---------- 保存したプロジェクトを開く（設計書 12.2） ---------- */

export async function openSaved(id: string): Promise<void> {
  const p = await loadProject(id)
  if (!p) {
    toast('プロジェクトが見つかりません', 'error')
    return
  }
  resetSession()
  openProject(p)
  const missing: Id[] = []
  for (const a of Object.values(p.assets)) {
    const file = await fileFromHandle(a, false)
    if (file) await attachFile(a, file)
    else missing.push(a.id)
  }
  useSession.setState({ missing, step: Object.keys(p.assets).length ? 'cut' : 'import' })
}

async function fileFromHandle(a: Asset, ask: boolean): Promise<File | null> {
  if (!a.handleKey) return null
  try {
    const h = (await loadHandle(a.handleKey)) as
      | (FileSystemFileHandle & {
          queryPermission?: (o: { mode: 'read' }) => Promise<PermissionState>
          requestPermission?: (o: { mode: 'read' }) => Promise<PermissionState>
        })
      | undefined
    if (!h) return null
    let perm = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted'
    if (perm === 'prompt' && ask) perm = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied'
    if (perm !== 'granted') return null
    const f = await h.getFile()
    return (await matchesAsset(f, a)) ? f : null
  } catch {
    return null
  }
}

async function attachFile(a: Asset, file: File) {
  setFile(a.id, file)
  if (a.kind === 'video') analyzeAsset(a.id)
  else
    await decodeBgm(a.id, file).catch(() =>
      toast(`${a.name} を BGM として読み込めませんでした`, 'error'),
    )
}

/** 「素材へのアクセスを許可する」：ユーザー操作の中で権限を求め直す */
export async function requestMissingPermissions(): Promise<void> {
  const p = useProject.getState().project
  if (!p) return
  const still: Id[] = []
  for (const id of useSession.getState().missing) {
    const a = p.assets[id]
    if (!a) continue
    const f = await fileFromHandle(a, true)
    if (f) await attachFile(a, f)
    else still.push(id)
  }
  useSession.setState({ missing: still })
}

/** 選び直したファイルを素材に結びつける。中身が違えば警告して使わない */
export async function relinkAsset(assetId: Id, file: File): Promise<boolean> {
  const a = useProject.getState().project?.assets[assetId]
  if (!a) return false
  if (!(await matchesAsset(file, a))) {
    toast(
      `${file.name} は元の素材（${a.name}）と中身が違います。同じファイルを選んでください。`,
      'error',
    )
    return false
  }
  await attachFile(a, file)
  return true
}

/* ---------- 文字起こし（設計書 8.1） ---------- */

let asrW: { api: Comlink.Remote<AsrApi>; worker: Worker } | null = null
const asr = () =>
  (asrW ??= spawn<AsrApi>(
    () =>
      new Worker(new URL('../workers/asr.worker.ts', import.meta.url), {
        type: 'module',
        name: 'asr',
      }),
    () => (asrW = null),
  )).api

export async function webGpuAvailable(): Promise<boolean> {
  return asr().webGpuAvailable()
}

export async function transcribe(modelKey: AsrModelKey, scope: 'kept' | 'all'): Promise<void> {
  const p = useProject.getState().project
  if (!p) return
  if (useSession.getState().job) {
    toast('ほかの処理が終わるまで待ってください', 'error')
    return
  }
  const assets = [...new Set(p.videoTrack.map((c) => c.assetId))]
  const s = useSession.getState()
  const pending = assets.filter((id) => s.analysis[id]?.status !== 'done')
  if (pending.length) {
    toast('音声の解析が終わってから文字起こししてください', 'error')
    return
  }
  useSession.setState({
    job: {
      kind: 'transcribe',
      progress: 0,
      label: '文字起こしを準備しています',
      startedAt: Date.now(),
    },
  })
  let device: 'webgpu' | 'wasm' = 'wasm'
  try {
    for (const [i, id] of assets.entries()) {
      const a = p.assets[id]!
      const r = useSession.getState().analysis[id]!.result!
      const targets =
        scope === 'kept' ? keptSourceRanges(p.videoTrack, id) : [{ start: 0, end: a.duration }]
      const ranges = asrTargets(targets, r.speech.length ? r.speech : null)
      const res = await asr().transcribe(
        cacheKey(a, a.analysisAudioTrack),
        ranges,
        r.envelope,
        modelKey,
        Comlink.proxy((progress: number, label?: string) => {
          const job = useSession.getState().job
          if (job)
            useSession.setState({
              job: withRemain({
                ...job,
                progress: (i + progress) / assets.length,
                label: label ?? job.label,
              }),
            })
        }),
      )
      device = res.device
      const segments = filterHallucinations(res.segments, r.speech.length ? r.speech : null)
      useSession.setState({ transcripts: { ...useSession.getState().transcripts, [id]: segments } })
    }
    toast(
      device === 'wasm'
        ? '文字起こしが終わりました（GPU が使えないため CPU で処理しました）'
        : '文字起こしが終わりました',
    )
    useSession.setState({ step: 'subtitles' })
  } catch (e) {
    if (isCancelled(e)) toast('文字起こしをキャンセルしました')
    else toast(describe(e), 'error')
  } finally {
    useSession.setState({ job: null })
    void asrW?.api.release()
  }
}

/** 進捗から残り時間の目安を出す */
function withRemain(job: JobState): JobState {
  const elapsed = (Date.now() - job.startedAt) / 1000
  return {
    ...job,
    remain:
      job.progress > 0.02 && elapsed > 3
        ? (elapsed / job.progress) * (1 - job.progress)
        : undefined,
  }
}

export function cancelJob(): void {
  const job = useSession.getState().job
  if (job?.kind === 'transcribe') void asrW?.api.cancel()
  if (job?.kind === 'export') void exportW?.api.cancel()
}

/** ワンボタン字幕（設計書 8.4） */
export function generateSubtitles(dropTrailingPeriod = true): void {
  const p = useProject.getState().project
  if (!p) return
  const ts = useSession.getState().transcripts
  let n = 0
  for (const [assetId, segments] of Object.entries(ts)) {
    const items = buildSubtitles(segments, {
      ...SPLIT_DEFAULTS,
      maxCharsPerLine: p.subtitleStyle.maxCharsPerLine,
      maxLines: p.subtitleStyle.maxLines,
      dropTrailingPeriod,
    })
    edit(ops.generateSubtitles, assetId, items)
    n += items.length
  }
  toast(
    n ? `字幕を ${n} 件入れました` : '文字起こしの結果がありません。先に文字起こしをしてください。',
    n ? 'info' : 'error',
  )
}

/* ---------- 書き出し（設計書 10章） ---------- */

let exportW: { api: Comlink.Remote<ExportApi>; worker: Worker } | null = null

export interface ExportSettings {
  resolution: 'source' | '1080' | '720'
  fps: 'source' | 60 | 30
  quality: ExportQuality
  burnSubtitles: boolean
}

export const DEFAULT_EXPORT: ExportSettings = {
  resolution: '1080',
  fps: 'source',
  quality: 'standard',
  burnSubtitles: true,
}

export function outputSize(
  p: Project,
  s: ExportSettings,
): { width: number; height: number; fps: number } {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const { width: srcW, height: srcH } = p.output
  let width = srcW
  let height = srcH
  if (s.resolution !== 'source') {
    // 短辺を 1080 / 720 に合わせる（縦長の素材にも対応）
    const short = Number(s.resolution)
    if (srcW >= srcH) {
      height = short
      width = even((srcW * short) / srcH)
    } else {
      width = short
      height = even((srcH * short) / srcW)
    }
  }
  return {
    width: even(width),
    height: even(height),
    fps: s.fps === 'source' ? p.output.fps : s.fps,
  }
}

type SavePicker = (o: {
  suggestedName: string
  types: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle>

export async function exportVideo(settings: ExportSettings): Promise<void> {
  const p = useProject.getState().project
  if (!p || totalDuration(p.videoTrack) <= 0) return
  const s = useSession.getState()
  if (s.job) {
    toast('ほかの処理が終わるまで待ってください', 'error')
    return
  }
  const missing = p.videoTrack.map((c) => c.assetId).filter((id) => !s.files[id])
  if (missing.length) {
    toast('素材のファイルが見つかりません。素材を選び直してください。', 'error')
    return
  }
  // 保存先を先に選ぶ（設計書 10.2）
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  let handle: FileSystemFileHandle | undefined
  if (picker) {
    try {
      handle = await picker({
        suggestedName: `${p.name}.mp4`,
        types: [{ description: 'MP4 動画', accept: { 'video/mp4': ['.mp4'] } }],
      })
    } catch {
      return // キャンセル
    }
  } else if (
    !confirm(
      'このブラウザではファイルに直接書き込めないため、メモリ上で作ってからダウンロードします。2GB を超える動画は失敗することがあります。続けますか？',
    )
  )
    return

  const { width, height, fps } = outputSize(p, settings)
  const g = gains(p, s)
  const bgmPcm: Record<string, Float32Array[]> = {}
  for (const b of p.bgmTrack) {
    const info = s.bgm[b.assetId]
    if (info)
      bgmPcm[b.assetId] = [0, 1].map((c) =>
        info.buffer.getChannelData(Math.min(c, info.buffer.numberOfChannels - 1)),
      )
  }
  const job: ExportJob = {
    project: { videoTrack: p.videoTrack, bgmTrack: p.bgmTrack, assets: p.assets },
    width,
    height,
    fps,
    quality: settings.quality,
    burnSubtitles: settings.burnSubtitles,
    style: p.subtitleStyle,
    cues: cues(p),
    mix: p.audioMix,
    duck: duckCurve(p, s.analysis),
    voiceGainDb: g.voiceDb,
    bgmGainDb: g.bgmDb,
    files: s.files,
    bgmPcm,
    handle,
  }

  // 書き出し中はプレビューを止め、画面の消灯とタブを閉じる操作を防ぐ（設計書 10.3）
  useSession.setState({
    playing: false,
    job: { kind: 'export', progress: 0, label: '書き出しを準備しています', startedAt: Date.now() },
  })
  const beforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault()
  }
  window.addEventListener('beforeunload', beforeUnload)
  let wake: { release(): Promise<void> } | null = null
  try {
    wake =
      (await (
        navigator as Navigator & {
          wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> }
        }
      ).wakeLock
        ?.request('screen')
        .catch(() => null)) ?? null
  } catch {
    wake = null
  }
  exportW = spawn<ExportApi>(
    () =>
      new Worker(new URL('../workers/export.worker.ts', import.meta.url), {
        type: 'module',
        name: 'export',
      }),
    () => (exportW = null),
  )
  try {
    const res = await exportW.api.run(
      job,
      Comlink.proxy((progress: number, label?: string) => {
        const j = useSession.getState().job
        if (j) useSession.setState({ job: withRemain({ ...j, progress, label: label ?? j.label }) })
      }),
    )
    if (res.blob) download(res.blob, `${p.name}.mp4`)
    const notes: string[] = []
    if (res.videoCodec !== 'avc')
      notes.push(`H.264 が使えないため映像は ${res.videoCodec.toUpperCase()} です`)
    if (res.audioCodec === 'opus') notes.push('AAC が使えないため音声は Opus です')
    toast(
      notes.length
        ? `書き出しました（${notes.join('、')}。再生できない環境があります）`
        : '書き出しました',
    )
  } catch (e) {
    if (isCancelled(e)) toast('書き出しをキャンセルしました')
    else toast(describe(e), 'error')
  } finally {
    window.removeEventListener('beforeunload', beforeUnload)
    await wake?.release().catch(() => {})
    exportW?.worker.terminate()
    exportW = null
    useSession.setState({ job: null })
  }
}

export async function exportSrt(): Promise<void> {
  const p = useProject.getState().project
  if (!p) return
  const text = toSrt(cues(p))
  const blob = new Blob([new TextEncoder().encode(text)], { type: 'application/x-subrip' })
  const picker = (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker
  if (picker) {
    try {
      const h = await picker({
        suggestedName: `${p.name}.srt`,
        types: [{ description: 'SRT 字幕', accept: { 'application/x-subrip': ['.srt'] } }],
      })
      const w = await h.createWritable()
      await w.write(blob)
      await w.close()
      toast('SRT を保存しました')
    } catch {
      /* キャンセル */
    }
  } else download(blob, `${p.name}.srt`)
}

export function download(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}
