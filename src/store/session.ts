/**
 * 保存しない画面の状態（素材ファイル、解析結果、再生位置、選択など）。
 */
import { create } from 'zustand'
import type { Id, Sec } from '../core/project/types'
import type { TranscriptSegment } from '../core/subtitles/transcript'
import type { AnalysisResult } from '../workers/analysis.worker'

export type Step = 'import' | 'cut' | 'subtitles' | 'bgm' | 'export'

export interface AnalysisState {
  status: 'waiting' | 'running' | 'done' | 'error'
  progress: number
  label?: string
  error?: string
  result?: AnalysisResult
}

export interface JobState {
  kind: 'transcribe' | 'export'
  progress: number
  label: string
  startedAt: number
  /** 残り時間の目安（秒） */
  remain?: number
}

export interface Thumb {
  t: Sec
  bitmap: ImageBitmap
}

export interface SessionState {
  files: Record<Id, File>
  /** 素材の object URL（プレビュー用） */
  urls: Record<Id, string>
  analysis: Record<Id, AnalysisState>
  transcripts: Record<Id, TranscriptSegment[]>
  thumbs: Record<Id, Thumb[]>
  bgm: Record<Id, { buffer: AudioBuffer; lufs: number }>
  job: JobState | null
  step: Step
  playhead: Sec
  playing: boolean
  selectedClip: Id | null
  /** クリックでチェックしたクリップ（まとめて削除する） */
  checkedClips: Id[]
  selectedMarker: Id | null
  selectedSubtitle: Id | null
  selectedSuggestion: Id | null
  inPoint: Sec | null
  outPoint: Sec | null
  /** タイムラインの拡大率（px / 秒）。null は全体表示 */
  zoom: number | null
  snap: boolean
  previewRes: 'auto' | 'full' | 'half'
  /** 自動で 1/2 に下げている */
  previewReduced: boolean
  /** 素材の選び直しが必要なもの */
  missing: Id[]
  toast: { text: string; kind: 'info' | 'error' } | null
  helpOpen: boolean
  guideOpen: boolean
}

export const initialSession = (): SessionState => ({
  files: {},
  urls: {},
  analysis: {},
  transcripts: {},
  thumbs: {},
  bgm: {},
  job: null,
  step: 'import',
  playhead: 0,
  playing: false,
  selectedClip: null,
  checkedClips: [],
  selectedMarker: null,
  selectedSubtitle: null,
  selectedSuggestion: null,
  inPoint: null,
  outPoint: null,
  zoom: null,
  snap: true,
  previewRes: 'auto',
  previewReduced: false,
  missing: [],
  toast: null,
  helpOpen: false,
  guideOpen: false,
})

export const useSession = create<SessionState>(() => initialSession())

export function resetSession(): void {
  const s = useSession.getState()
  for (const u of Object.values(s.urls)) URL.revokeObjectURL(u)
  for (const list of Object.values(s.thumbs)) for (const t of list) t.bitmap.close()
  useSession.setState(initialSession())
}

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  useSession.setState({ toast: { text, kind } })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(
    () => useSession.setState({ toast: null }),
    kind === 'error' ? 8000 : 3500,
  )
}

export function setFile(assetId: Id, file: File): void {
  const s = useSession.getState()
  if (s.urls[assetId]) URL.revokeObjectURL(s.urls[assetId])
  useSession.setState({
    files: { ...s.files, [assetId]: file },
    urls: { ...s.urls, [assetId]: URL.createObjectURL(file) },
    missing: s.missing.filter((m) => m !== assetId),
  })
}
