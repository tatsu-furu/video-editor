/**
 * 文字起こし結果の整理（設計書 8.1・8.2）。
 */
import type { Sec } from '../project/types'
import type { Range } from '../time/time'
import { speechRatio } from '../cut/vad'
import { HALLUCINATION_PHRASES } from './hallucinations'

export interface TranscriptWord {
  start: Sec
  end: Sec
  text: string
  prob: number
}

/** ソース時刻で持つ文字起こしの1区切り */
export interface TranscriptSegment {
  start: Sec
  end: Sec
  text: string
  words?: TranscriptWord[]
}

export interface Transcript {
  model: string
  language: 'ja'
  segments: TranscriptSegment[]
}

const normalize = (s: string) => s.replace(/[\s、。，．,.!！?？・…「」『』（）()]/g, '')

/**
 * 誤認識（ハルシネーション）を除く。
 * - 発話の割合が 10% 未満のセグメント
 * - 同じフレーズが 3 回以上続くセグメント（全部）
 * - 定型句リストに一致するもの
 */
export function filterHallucinations(
  segments: readonly TranscriptSegment[],
  speech: readonly Range[] | null,
  phrases: readonly string[] = HALLUCINATION_PHRASES,
): TranscriptSegment[] {
  const black = new Set(phrases.map(normalize))
  const cleaned = segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => normalize(s.text).length > 0)
  // 3回以上の連続を探す
  const drop = new Set<number>()
  for (let i = 0; i < cleaned.length;) {
    let j = i + 1
    const key = normalize(cleaned[i]!.text)
    while (j < cleaned.length && normalize(cleaned[j]!.text) === key) j++
    if (j - i >= 3) for (let k = i; k < j; k++) drop.add(k)
    i = j
  }
  return cleaned.filter((s, i) => {
    if (drop.has(i)) return false
    if (black.has(normalize(s.text))) return false
    if (speech && speechRatio(speech, s.start, s.end) < 0.1) return false
    return true
  })
}

/** Whisper の出力（窓ごとの相対時刻）をソース時刻のセグメントにする */
export function chunksToSegments(
  chunks: readonly { text: string; timestamp: [number, number | null] }[],
  windowStart: Sec,
  windowEnd: Sec,
): TranscriptSegment[] {
  const out: TranscriptSegment[] = []
  for (const c of chunks) {
    const s = windowStart + Math.max(0, c.timestamp[0] ?? 0)
    let e = c.timestamp[1] == null ? Math.min(windowEnd, s + 3) : windowStart + c.timestamp[1]
    e = Math.min(windowEnd, Math.max(e, s + 0.2))
    if (s >= windowEnd) continue
    out.push({ start: s, end: e, text: c.text })
  }
  return out
}
