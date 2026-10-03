/**
 * 字幕の描画（設計書 4章・10.2）。プレビューと export.worker で同じ関数を使い、見た目を一致させる。
 */
import type { Sec, SubtitleStyle } from '../core/project/types'
import { cueAt, type TimelineCue } from '../core/subtitles/split'
import { FONT_FAMILY } from './fonts'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/** フォントの読み込みが間に合わないときの予備（見た目がずれるので、書き出しでは読み込みを待つ） */
export const FONT_STACK = `"${FONT_FAMILY}", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif`

/** 字幕スタイルのプリセット（設計書 8.5） */
export const STYLE_PRESETS: { id: string; label: string; style: Partial<SubtitleStyle> }[] = [
  {
    id: 'white',
    label: '白文字＋黒縁',
    style: { color: '#ffffff', outlineColor: '#000000', box: false },
  },
  {
    id: 'yellow',
    label: '黄文字＋黒縁',
    style: { color: '#ffe14d', outlineColor: '#000000', box: false },
  },
  {
    id: 'band',
    label: '白文字＋半透明帯',
    style: { color: '#ffffff', outlineColor: '#000000', box: true, outlineRatio: 0 },
  },
]

export function drawLines(
  ctx: Ctx,
  lines: readonly string[],
  style: SubtitleStyle,
  width: number,
  height: number,
): void {
  if (lines.length === 0) return
  const size = Math.max(8, Math.round(height * style.sizeRatio))
  const lineH = Math.round(size * 1.35)
  const margin = Math.round(height * style.marginRatio)
  const outline = size * style.outlineRatio
  ctx.save()
  ctx.font = `${style.fontWeight} ${size}px ${FONT_STACK}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2
  const blockH = lineH * lines.length
  const top = style.position === 'bottom' ? height - margin - blockH : margin
  const cx = width / 2
  if (style.box) {
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(
      Math.round(cx - w / 2),
      Math.round(top - size * 0.15),
      Math.round(w),
      Math.round(blockH + size * 0.3),
    )
  }
  lines.forEach((line, i) => {
    const y = top + lineH * i + lineH / 2
    if (outline > 0) {
      ctx.strokeStyle = style.outlineColor
      ctx.lineWidth = outline * 2
      ctx.strokeText(line, cx, y)
    }
    ctx.fillStyle = style.color
    ctx.fillText(line, cx, y)
  })
  ctx.restore()
}

/** タイムライン時刻 t の字幕を描く */
export function renderSubtitles(
  ctx: Ctx,
  cues: readonly TimelineCue[],
  t: Sec,
  style: SubtitleStyle,
  width: number,
  height: number,
): void {
  const cue = cueAt(cues, t)
  if (cue) drawLines(ctx, cue.lines, style, width, height)
}

/** 字幕で使うすべての文字（フォントの事前読み込み用） */
export function cueText(cues: readonly TimelineCue[]): string {
  const set = new Set<string>()
  for (const c of cues) for (const l of c.lines) for (const ch of l) set.add(ch)
  return [...set].join('')
}
