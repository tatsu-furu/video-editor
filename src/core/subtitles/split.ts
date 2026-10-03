/**
 * ワンボタン字幕の分割ルール（設計書 8.4）。
 */
import type { Sec, SubtitleItem, SubtitleStyle, VideoClip } from '../project/types'
import { sourceRangeToTimeline } from '../time/time'
import type { TranscriptSegment } from './transcript'

export interface SplitOptions {
  maxCharsPerLine: number
  maxLines: number
  /** 末尾の句点を表示しない */
  dropTrailingPeriod: boolean
  minDuration: Sec
  maxDuration: Sec
  /** 次の字幕までの隙間がこれ未満なら詰める */
  closeGap: Sec
}

export const SPLIT_DEFAULTS: SplitOptions = {
  maxCharsPerLine: 18,
  maxLines: 2,
  dropTrailingPeriod: true,
  minDuration: 0.8,
  maxDuration: 6,
  closeGap: 0.2,
}

/** 1秒あたりこの文字数を超えると読みにくい（警告） */
export const MAX_CHARS_PER_SEC = 8

const len = (s: string) => Array.from(s).length

/** 区切り文字の直後で分ける（区切り文字は前に残す） */
function splitAfter(text: string, chars: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of text) {
    cur += ch
    if (chars.includes(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** 長さ max 以下に、なるべく均等に分ける（空白があればそこを優先する） */
function splitByLength(text: string, max: number): string[] {
  const words = text.split(/(?<=\s)/)
  if (words.length > 1 && words.every((w) => len(w) <= max)) {
    const out: string[] = []
    let cur = ''
    for (const w of words) {
      if (len(cur + w) > max && cur) {
        out.push(cur.trim())
        cur = ''
      }
      cur += w
    }
    if (cur.trim()) out.push(cur.trim())
    return out
  }
  const chars = Array.from(text)
  const parts = Math.ceil(chars.length / max)
  const size = Math.ceil(chars.length / parts)
  const out: string[] = []
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''))
  return out
}

/** 1つの文を、1画面（maxChars × maxLines）に収まる塊に分ける */
export function splitSentence(
  text: string,
  opts: Pick<SplitOptions, 'maxCharsPerLine' | 'maxLines'>,
): string[] {
  const cap = opts.maxCharsPerLine * opts.maxLines
  if (len(text) <= cap) return [text]
  // 読点で区切り、収まる範囲でまとめ直す
  const out: string[] = []
  let cur = ''
  for (const piece of splitAfter(text, '、，,')) {
    const pieces = len(piece) > cap ? splitByLength(piece, cap) : [piece]
    for (const p of pieces) {
      if (cur && len(cur + p) > cap) {
        out.push(cur)
        cur = ''
      }
      cur += p
    }
  }
  if (cur) out.push(cur)
  return out
}

/** 1行の文字数で折り返す（読点の直後を優先） */
export function wrapLines(text: string, maxChars: number): string[] {
  if (len(text) <= maxChars) return [text]
  const out: string[] = []
  let rest = Array.from(text)
  while (rest.length > maxChars) {
    let cut = maxChars
    for (let i = maxChars; i > Math.floor(maxChars / 2); i--) {
      if ('、，, '.includes(rest[i - 1]!)) {
        cut = i
        break
      }
    }
    // 残りが短すぎるなら均等に分ける
    if (rest.length - cut > 0 && rest.length <= maxChars * 2 && rest.length - cut < maxChars / 3)
      cut = Math.ceil(rest.length / 2)
    out.push(rest.slice(0, cut).join('').trim())
    rest = rest.slice(cut)
  }
  if (rest.length) out.push(rest.join('').trim())
  return out.filter(Boolean)
}

/**
 * 文字起こしのセグメント列から字幕アイテム（ソース時刻）を作る。
 * 時刻は単語のタイムスタンプがあればそれを、なければ文字数で按分して決める。
 */
export function buildSubtitles(
  segments: readonly TranscriptSegment[],
  opts: SplitOptions = SPLIT_DEFAULTS,
): Omit<SubtitleItem, 'id' | 'assetId'>[] {
  const items: Omit<SubtitleItem, 'id' | 'assetId'>[] = []
  for (const seg of segments) {
    const text = seg.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const pieces = splitAfter(text, '。！？!?').flatMap((s) => splitSentence(s, opts))
    const total = pieces.reduce((s, p) => s + len(p), 0) || 1
    let t = seg.start
    let consumed = 0
    for (const p of pieces) {
      consumed += len(p)
      const end = timeAt(seg, consumed / total)
      let display = p
      if (opts.dropTrailingPeriod) display = display.replace(/[。．.]$/, '')
      items.push({
        sourceStart: t,
        sourceEnd: end,
        text: wrapLines(display, opts.maxCharsPerLine).join('\n'),
      })
      t = end
    }
  }
  return adjustTiming(items, opts)
}

/** セグメント内の割合 r（文字数比）に対応する時刻。単語タイムスタンプがあればそちらを使う */
function timeAt(seg: TranscriptSegment, r: number): Sec {
  if (seg.words && seg.words.length) {
    const total = seg.words.reduce((s, w) => s + len(w.text), 0) || 1
    let acc = 0
    for (const w of seg.words) {
      acc += len(w.text)
      if (acc / total >= r - 1e-9) return w.end
    }
  }
  return seg.start + (seg.end - seg.start) * r
}

/** 表示時間を 0.8〜6 秒に収め、0.2 秒未満の隙間を詰める */
export function adjustTiming<T extends { sourceStart: Sec; sourceEnd: Sec }>(
  items: T[],
  opts: SplitOptions = SPLIT_DEFAULTS,
): T[] {
  const out = items.map((i) => ({ ...i })).sort((a, b) => a.sourceStart - b.sourceStart)
  for (let i = 0; i < out.length; i++) {
    const it = out[i]!
    const next = out[i + 1]
    let end = Math.min(it.sourceEnd, it.sourceStart + opts.maxDuration)
    if (end - it.sourceStart < opts.minDuration) end = it.sourceStart + opts.minDuration
    if (next) {
      if (next.sourceStart - end < opts.closeGap) end = next.sourceStart
      end = Math.min(end, next.sourceStart)
    }
    it.sourceEnd = Math.max(end, it.sourceStart + 0.1)
  }
  return out
}

/** 読む速さ（文字/秒） */
export function charsPerSecond(
  item: Pick<SubtitleItem, 'sourceStart' | 'sourceEnd' | 'text'>,
): number {
  const d = item.sourceEnd - item.sourceStart
  return d > 0 ? len(item.text.replace(/\n/g, '')) / d : Infinity
}

export interface TimelineCue {
  id: string
  start: Sec
  end: Sec
  lines: string[]
}

/** 字幕をタイムライン上の表示単位にする。カットされた部分は消え、一部だけ残れば切り詰める */
export function timelineCues(
  subtitles: readonly SubtitleItem[],
  track: readonly VideoClip[],
  style: Pick<SubtitleStyle, 'maxCharsPerLine' | 'maxLines'>,
): TimelineCue[] {
  const out: TimelineCue[] = []
  for (const s of subtitles) {
    const lines = s.text
      .split('\n')
      .flatMap((l) => wrapLines(l, style.maxCharsPerLine))
      .slice(0, Math.max(style.maxLines, s.text.split('\n').length))
    for (const r of sourceRangeToTimeline(track, s.assetId, s.sourceStart, s.sourceEnd)) {
      if (r.end - r.start < 0.04) continue
      out.push({ id: s.id, start: r.start, end: r.end, lines })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/** t に表示する字幕。cues は開始時刻順であること */
export function cueAt(cues: readonly TimelineCue[], t: Sec): TimelineCue | null {
  // start <= t となる最後の位置を二分探索し、そこから少し前まで含むものを探す
  let lo = 0
  let hi = cues.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid]!.start <= t) lo = mid + 1
    else hi = mid
  }
  for (let i = lo - 1; i >= 0 && i >= lo - 8; i--) {
    const c = cues[i]!
    if (t < c.end) return c
  }
  return null
}
