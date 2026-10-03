/**
 * SRT の書き出し（設計書 10.4）。UTF-8（BOM なし）で保存すること。
 */
import type { TimelineCue } from './split'

export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor((ms % 3600000) / 60000))}:${pad(Math.floor((ms % 60000) / 1000))},${pad(ms % 1000, 3)}`
}

export function toSrt(cues: readonly TimelineCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.lines.join('\n')}\n`)
    .join('\n')
}
