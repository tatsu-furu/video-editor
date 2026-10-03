/**
 * プロジェクトの生成と既定値（設計書 5章）。
 */
import type { AudioMix, Project, SubtitleStyle } from './types'

export function newId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: 'Noto Sans JP',
  fontWeight: 700,
  sizeRatio: 0.055,
  color: '#ffffff',
  outlineColor: '#000000',
  outlineRatio: 0.12,
  position: 'bottom',
  marginRatio: 0.06,
  box: false,
  maxCharsPerLine: 18,
  maxLines: 2,
}

/** 音声ミックスのプリセット（設計書 9.3）。BGM の基準は元音声のラウドネスに対する差（LU） */
export const AUDIO_PRESETS: Record<AudioMix['preset'], { bgmRelativeLu: number }> = {
  talk: { bgmRelativeLu: -20 },
  gameCommentary: { bgmRelativeLu: -15 },
  bgmForward: { bgmRelativeLu: -6 },
}

export function defaultAudioMix(preset: AudioMix['preset'] = 'talk'): AudioMix {
  return {
    preset,
    bgmOffsetDb: 0,
    ducking: { enabled: true, amountDb: 12, attackMs: 150, holdMs: 300, releaseMs: 500 },
    targetLufs: -14,
    truePeakDb: -1,
  }
}

export function createProject(name = '無題のプロジェクト', now = new Date()): Project {
  const iso = now.toISOString()
  return {
    version: 1,
    id: newId(),
    name,
    createdAt: iso,
    updatedAt: iso,
    mode: 'talk',
    output: { width: 1920, height: 1080, fps: 30, sampleRate: 48000 },
    assets: {},
    videoTrack: [],
    bgmTrack: [],
    subtitles: [],
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    audioMix: defaultAudioMix(),
    suggestions: [],
  }
}

/** 読み込んだ JSON が Project として使えるか最低限確認する */
export function isProject(v: unknown): v is Project {
  if (!v || typeof v !== 'object') return false
  const p = v as Partial<Project>
  return (
    p.version === 1 &&
    typeof p.id === 'string' &&
    Array.isArray(p.videoTrack) &&
    Array.isArray(p.bgmTrack) &&
    Array.isArray(p.subtitles) &&
    typeof p.assets === 'object'
  )
}
