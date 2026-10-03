/**
 * 文字起こしの対象区間と窓（設計書 8.1）。
 */
import type { Range } from '../time/time'
import { mergeRanges } from '../time/time'
import { HOP } from '../cut/envelope'

/** 対象区間のうち発話のあるところだけ（前後に少し余白を付け、近いものはつなぐ） */
export function asrTargets(
  targets: readonly Range[],
  speech: readonly Range[] | null,
  pad = 0.3,
): Range[] {
  if (!speech) return mergeRanges(targets)
  const padded = mergeRanges(
    speech.map((s) => ({ start: Math.max(0, s.start - pad), end: s.end + pad })),
    1,
  )
  const out: Range[] = []
  for (const t of mergeRanges(targets))
    for (const s of padded) {
      const a = Math.max(t.start, s.start)
      const b = Math.min(t.end, s.end)
      if (b - a > 0.2) out.push({ start: a, end: b })
    }
  return out
}

/**
 * 30 秒未満の窓に分ける。言葉の途中で切らないよう、窓の終わり 6 秒以内で
 * いちばん静かな位置を区切りにする。
 */
export function asrWindows(
  envelope: ArrayLike<number>,
  ranges: readonly Range[],
  maxLen = 28,
  search = 6,
): Range[] {
  const out: Range[] = []
  for (const r of ranges) {
    let s = r.start
    while (r.end - s > maxLen) {
      let best = s + maxLen
      let bestDb = Infinity
      const from = Math.floor((s + maxLen - search) / HOP)
      const to = Math.floor((s + maxLen) / HOP)
      for (let i = from; i < to && i < envelope.length; i++) {
        if (envelope[i]! < bestDb) {
          bestDb = envelope[i]!
          best = i * HOP + HOP / 2
        }
      }
      out.push({ start: s, end: best })
      s = best
    }
    if (r.end - s > 0.2) out.push({ start: s, end: r.end })
  }
  return out
}

export const windowKey = (r: Range): string => `${r.start.toFixed(2)}-${r.end.toFixed(2)}`
