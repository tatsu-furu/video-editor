/**
 * プロジェクトのデータモデル（設計書 5章）。
 *
 * - 映像トラックはマグネティック：クリップは隙間なく並び、タイムライン上の位置は保存しない。
 * - 字幕と文字起こしは元動画の時刻（ソース時刻）で保持する。
 * - ダッキングの音量カーブは保存せず、発話区間から毎回導出する。
 *
 * 型の変更は docs/DECISIONS.md に記録すること。
 */

export type Id = string
/** 秒（浮動小数） */
export type Sec = number
/** デシベル */
export type Db = number

export interface Project {
  version: 1
  id: Id
  name: string
  /** ISO 8601 */
  createdAt: string
  updatedAt: string
  /** 自動カットの既定モード */
  mode: 'game' | 'talk'
  output: { width: number; height: number; fps: number; sampleRate: 48000 }
  assets: Record<Id, Asset>
  /** 並び順 = 再生順 */
  videoTrack: VideoClip[]
  /** 重なりなし、timelineStart 昇順 */
  bgmTrack: BgmClip[]
  subtitles: SubtitleItem[]
  subtitleStyle: SubtitleStyle
  audioMix: AudioMix
  /** 自動カット候補 */
  suggestions: Suggestion[]
  /** タイムラインのピン（目印）。古い保存データには無い */
  markers?: Marker[]
}

/** ピン。字幕と同じくソース時刻で持つので、カットしても同じ場面に付いたまま動く */
export interface Marker {
  id: Id
  assetId: Id
  sourceTime: Sec
  /** 空でもよい */
  label: string
}

export interface Asset {
  id: Id
  kind: 'video' | 'audio'
  name: string
  duration: Sec
  /** headHash は先頭1MBの SHA-256 */
  fingerprint: { name: string; size: number; lastModified: number; headHash: string }
  /** IndexedDB に保存した FileSystemFileHandle のキー */
  handleKey?: string
  video?: { width: number; height: number; fps: number; codec: string }
  audioTracks: { index: number; label: string; channels: number; sampleRate: number }[]
  /** 解析に使う音声トラック（OBS のマイク別録り用） */
  analysisAudioTrack: number
}

export interface VideoClip {
  id: Id
  assetId: Id
  sourceIn: Sec
  sourceOut: Sec
  /** 元音声の音量（既定 0） */
  gainDb: Db
  muted: boolean
}

export interface BgmClip {
  id: Id
  assetId: Id
  timelineStart: Sec
  timelineEnd: Sec
  /** BGM ファイル内の再生開始位置 */
  sourceOffset: Sec
  loop: boolean
  /** 既定 1.0 */
  fadeIn: Sec
  /** 既定 2.0 */
  fadeOut: Sec
}

export interface SubtitleItem {
  id: Id
  /** どの動画の音声に対応するか */
  assetId: Id
  sourceStart: Sec
  sourceEnd: Sec
  /** 改行は \n */
  text: string
}

export interface SubtitleStyle {
  fontFamily: 'Noto Sans JP'
  fontWeight: 400 | 700 | 900
  /** 出力の高さに対する文字の大きさ（既定 0.055） */
  sizeRatio: number
  color: string
  outlineColor: string
  /** 文字サイズに対する縁取り幅（既定 0.12） */
  outlineRatio: number
  position: 'bottom' | 'top'
  /** 端からの余白（既定 0.06） */
  marginRatio: number
  /** 半透明の背景帯 */
  box: boolean
  /** 既定 18 */
  maxCharsPerLine: number
  /** 既定 2 */
  maxLines: 1 | 2
}

export interface AudioMix {
  preset: 'talk' | 'gameCommentary' | 'bgmForward'
  /** UI の「BGMの大きさ」スライダー（-10〜+10） */
  bgmOffsetDb: Db
  ducking: { enabled: boolean; amountDb: Db; attackMs: number; holdMs: number; releaseMs: number }
  /** 既定 -14 */
  targetLufs: number
  /** 既定 -1 */
  truePeakDb: Db
}

export interface Suggestion {
  id: Id
  kind: 'silence' | 'lowActivity' | 'highlight'
  assetId: Id
  sourceStart: Sec
  sourceEnd: Sec
  /** 0〜1 */
  score: number
  status: 'pending' | 'accepted' | 'rejected'
}
