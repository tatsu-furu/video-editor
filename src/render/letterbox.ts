/**
 * レターボックス計算（設計書 6.1・10.2）：縦横比を保って出力枠に収め、余白は黒。
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export function fitRect(srcW: number, srcH: number, dstW: number, dstH: number): Rect {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, w: dstW, h: dstH }
  const s = Math.min(dstW / srcW, dstH / srcH)
  const w = Math.round(srcW * s)
  const h = Math.round(srcH * s)
  return { x: Math.round((dstW - w) / 2), y: Math.round((dstH - h) / 2), w, h }
}
