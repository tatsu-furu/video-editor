/**
 * タイムラインの Canvas 描画（設計書 6.3）。見えている範囲だけを描く。
 */
import { evalCurve, type GainPoint } from '../../core/audio/ducking'
import { HOP } from '../../core/cut/envelope'
import type { Id, Project, Sec } from '../../core/project/types'
import type { TimelineCue } from '../../core/subtitles/split'
import { placeClips, sourceRangeToTimeline, totalDuration } from '../../core/time/time'
import type { Thumb } from '../../store/session'

export const LAYOUT = {
  gutter: 64,
  ruler: 24,
  subs: 30,
  video: 72,
  bgm: 44,
  gap: 4,
}

export const trackTop = {
  subs: LAYOUT.ruler + LAYOUT.gap,
  video: LAYOUT.ruler + LAYOUT.gap + LAYOUT.subs + LAYOUT.gap,
  bgm: LAYOUT.ruler + LAYOUT.gap + LAYOUT.subs + LAYOUT.gap + LAYOUT.video + LAYOUT.gap,
}
export const TOTAL_HEIGHT = trackTop.bgm + LAYOUT.bgm + LAYOUT.gap

export interface View {
  /** px / 秒 */
  zoom: number
  /** 左端のタイムライン時刻 */
  scroll: Sec
  width: number
}

export const xOf = (v: View, t: Sec) => LAYOUT.gutter + (t - v.scroll) * v.zoom
export const tOf = (v: View, x: number) => v.scroll + (x - LAYOUT.gutter) / v.zoom

export interface DrawInput {
  project: Project
  cues: TimelineCue[]
  duck: GainPoint[]
  envelopes: Record<Id, Float32Array | undefined>
  thumbs: Record<Id, Thumb[] | undefined>
  playhead: Sec
  inPoint: Sec | null
  outPoint: Sec | null
  selectedClip: Id | null
  checkedClips: readonly Id[]
  markers: readonly { id: Id; t: Sec; label: string }[]
  selectedMarker: Id | null
  selectedSubtitle: Id | null
  selectedSuggestion: Id | null
  /** 並べ替え中の挿入位置（タイムライン時刻） */
  dropAt: Sec | null
  colors: Record<string, string>
}

function niceStep(zoom: number): number {
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]
  for (const s of steps) if (s * zoom >= 70) return s
  return 3600
}

export function fmtTime(t: Sec, withFrac = false): string {
  const sign = t < 0 ? '-' : ''
  t = Math.abs(t)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const base =
    h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`
  return sign + (withFrac ? `${base}.${String(Math.floor((t % 1) * 100)).padStart(2, '0')}` : base)
}

let hatch: CanvasPattern | null = null
function hatchPattern(c: CanvasRenderingContext2D, color: string): CanvasPattern | null {
  if (hatch) return hatch
  const p = document.createElement('canvas')
  p.width = p.height = 8
  const g = p.getContext('2d')!
  g.strokeStyle = color
  g.lineWidth = 2
  g.beginPath()
  g.moveTo(-2, 10)
  g.lineTo(10, -2)
  g.stroke()
  hatch = c.createPattern(p, 'repeat')
  return hatch
}

export function drawTimeline(c: CanvasRenderingContext2D, v: View, d: DrawInput): void {
  const W = v.width
  const C = d.colors
  const p = d.project
  const total = totalDuration(p.videoTrack)
  const t0 = v.scroll
  const t1 = tOf(v, W)
  c.clearRect(0, 0, W, TOTAL_HEIGHT)
  c.fillStyle = C.bg!
  c.fillRect(0, 0, W, TOTAL_HEIGHT)

  // 目盛り
  c.fillStyle = C.ruler!
  c.fillRect(0, 0, W, LAYOUT.ruler)
  const step = niceStep(v.zoom)
  c.font = '11px system-ui, sans-serif'
  c.textBaseline = 'middle'
  c.fillStyle = C.muted!
  c.strokeStyle = C.line!
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(xOf(v, t)) + 0.5
    if (x < LAYOUT.gutter) continue
    c.beginPath()
    c.moveTo(x, LAYOUT.ruler - 7)
    c.lineTo(x, LAYOUT.ruler)
    c.stroke()
    c.fillText(fmtTime(t, step < 1), x + 3, LAYOUT.ruler / 2 - 1)
  }
  // I/O 範囲
  if (d.inPoint != null || d.outPoint != null) {
    const a = xOf(v, d.inPoint ?? 0)
    const b = xOf(v, d.outPoint ?? total)
    c.fillStyle = C.range!
    c.fillRect(
      Math.max(LAYOUT.gutter, a),
      0,
      Math.max(0, b - Math.max(LAYOUT.gutter, a)),
      TOTAL_HEIGHT,
    )
  }

  // トラック名
  c.fillStyle = C.gutter!
  c.fillRect(0, LAYOUT.ruler, LAYOUT.gutter, TOTAL_HEIGHT - LAYOUT.ruler)
  c.fillStyle = C.muted!
  c.font = '12px system-ui, sans-serif'
  c.fillText('字幕', 10, trackTop.subs + LAYOUT.subs / 2)
  c.fillText('映像', 10, trackTop.video + LAYOUT.video / 2)
  c.fillText('BGM', 10, trackTop.bgm + LAYOUT.bgm / 2)

  c.save()
  c.beginPath()
  c.rect(LAYOUT.gutter, 0, W - LAYOUT.gutter, TOTAL_HEIGHT)
  c.clip()

  // 字幕
  c.font = '12px system-ui, sans-serif'
  for (const cue of d.cues) {
    if (cue.end < t0 || cue.start > t1) continue
    const x = xOf(v, cue.start)
    const w = Math.max(2, (cue.end - cue.start) * v.zoom)
    c.fillStyle = cue.id === d.selectedSubtitle ? C.subSel! : C.sub!
    c.fillRect(x, trackTop.subs + 2, w - 1, LAYOUT.subs - 4)
    if (w > 24) {
      c.save()
      c.beginPath()
      c.rect(x, trackTop.subs, w - 3, LAYOUT.subs)
      c.clip()
      c.fillStyle = C.subText!
      c.fillText(cue.lines.join(' '), x + 4, trackTop.subs + LAYOUT.subs / 2)
      c.restore()
    }
  }

  // 映像クリップ
  const vt = trackTop.video
  const vh = LAYOUT.video
  for (const pc of placeClips(p.videoTrack)) {
    if (pc.end < t0 || pc.start > t1) continue
    const x = xOf(v, pc.start)
    const w = (pc.end - pc.start) * v.zoom
    c.fillStyle = pc.index % 2 ? C.clipB! : C.clipA!
    c.fillRect(x, vt, w, vh)
    c.save()
    c.beginPath()
    c.rect(x, vt, w, vh)
    c.clip()
    // サムネイル（間引き）
    const thumbs = d.thumbs[pc.clip.assetId]
    if (thumbs?.length && w > 30) {
      const tw = (thumbs[0]!.bitmap.width / thumbs[0]!.bitmap.height) * 40
      for (let xx = Math.max(x, LAYOUT.gutter - tw); xx < Math.min(x + w, W); xx += tw + 2) {
        const src = pc.clip.sourceIn + (xx - x) / v.zoom
        let best = thumbs[0]!
        for (const th of thumbs) if (Math.abs(th.t - src) < Math.abs(best.t - src)) best = th
        c.globalAlpha = 0.55
        c.drawImage(best.bitmap, xx, vt + 2, tw, 40)
        c.globalAlpha = 1
      }
    }
    // 波形（解析済みエンベロープ）
    const env = d.envelopes[pc.clip.assetId]
    if (env) {
      c.fillStyle = C.wave!
      const base = vt + vh - 2
      const xa = Math.max(x, LAYOUT.gutter)
      const xb = Math.min(x + w, W)
      for (let px = Math.floor(xa); px < xb; px++) {
        const sa = pc.clip.sourceIn + (px - x) / v.zoom
        const sb = sa + 1 / v.zoom
        let m = -100
        for (let i = Math.floor(sa / HOP); i <= Math.floor(sb / HOP) && i < env.length; i++)
          if (env[i]! > m) m = env[i]!
        const hgt = Math.max(0, Math.min(1, (m + 60) / 60)) * 28
        c.fillRect(px, base - hgt, 1, hgt)
      }
    }
    c.restore()
    const checked = d.checkedClips.includes(pc.clip.id)
    if (checked) {
      c.fillStyle = C.checkFill!
      c.fillRect(x, vt, w, vh)
    }
    c.strokeStyle = checked || pc.clip.id === d.selectedClip ? C.accent! : C.clipEdge!
    c.lineWidth = checked ? 3 : pc.clip.id === d.selectedClip ? 2 : 1
    c.strokeRect(x + 0.5, vt + 0.5, w - 1, vh - 1)
    // チェックボックス（クリックでチェック → まとめて削除）
    if (w > 22) {
      const bx = Math.max(x + 4, Math.min(LAYOUT.gutter + 4, x + w - 18))
      c.fillStyle = checked ? C.accent! : C.bg!
      c.fillRect(bx, vt + 4, 14, 14)
      c.strokeStyle = checked ? C.accent! : C.clipEdge!
      c.lineWidth = 1
      c.strokeRect(bx + 0.5, vt + 4.5, 13, 13)
      if (checked) {
        c.strokeStyle = '#fff'
        c.lineWidth = 2
        c.beginPath()
        c.moveTo(bx + 3, vt + 11)
        c.lineTo(bx + 6, vt + 14)
        c.lineTo(bx + 11, vt + 7)
        c.stroke()
      }
    }
    if (pc.clip.muted) {
      c.fillStyle = C.muted!
      c.fillText('ミュート', x + 4, vt + 12)
    }
  }

  // 自動カット候補（削除候補は赤の斜線、ハイライトは緑）
  for (const s of p.suggestions) {
    if (s.status !== 'pending') continue
    for (const r of sourceRangeToTimeline(p.videoTrack, s.assetId, s.sourceStart, s.sourceEnd)) {
      if (r.end < t0 || r.start > t1) continue
      const x = xOf(v, r.start)
      const w = Math.max(2, (r.end - r.start) * v.zoom)
      if (s.kind === 'highlight') {
        c.fillStyle = C.highlight!
        c.fillRect(x, vt, w, 6)
        c.fillStyle = C.highlightFill!
        c.fillRect(x, vt + 6, w, vh - 6)
      } else {
        c.fillStyle = C.cutFill!
        c.fillRect(x, vt, w, vh)
        const pat = hatchPattern(c, C.cut!)
        if (pat) {
          c.fillStyle = pat
          c.fillRect(x, vt, w, vh)
        }
      }
      if (s.id === d.selectedSuggestion) {
        c.strokeStyle = C.text!
        c.lineWidth = 2
        c.strokeRect(x + 1, vt + 1, w - 2, vh - 2)
      }
    }
  }

  // BGM とダッキングカーブ
  const bt = trackTop.bgm
  const bh = LAYOUT.bgm
  for (const b of p.bgmTrack) {
    if (b.timelineEnd < t0 || b.timelineStart > t1) continue
    const x = xOf(v, b.timelineStart)
    const w = (b.timelineEnd - b.timelineStart) * v.zoom
    c.fillStyle = C.bgm!
    c.fillRect(x, bt, w, bh)
    c.fillStyle = C.subText!
    c.fillText(p.assets[b.assetId]?.name ?? 'BGM', x + 4, bt + 10)
    c.strokeStyle = C.duck!
    c.lineWidth = 1.5
    c.beginPath()
    const xa = Math.max(x, LAYOUT.gutter)
    const xb = Math.min(x + w, W)
    for (let px = xa; px <= xb; px += 2) {
      const t = tOf(v, px)
      const db = evalCurve(d.duck, t)
      const y = bt + 14 + (Math.min(24, -db) / 24) * (bh - 18)
      if (px === xa) c.moveTo(px, y)
      else c.lineTo(px, y)
    }
    c.stroke()
  }

  // 並べ替えの挿入位置
  if (d.dropAt != null) {
    const x = xOf(v, d.dropAt)
    c.fillStyle = C.accent!
    c.fillRect(x - 2, vt - 4, 4, vh + 8)
  }

  // ピン（目印）：目盛りに旗、全トラックに点線
  for (const m of d.markers) {
    if (m.t < t0 || m.t > t1) continue
    const x = Math.round(xOf(v, m.t)) + 0.5
    const sel = m.id === d.selectedMarker
    c.strokeStyle = C.pin!
    c.lineWidth = sel ? 2 : 1
    c.setLineDash([4, 3])
    c.beginPath()
    c.moveTo(x, LAYOUT.ruler)
    c.lineTo(x, TOTAL_HEIGHT)
    c.stroke()
    c.setLineDash([])
    c.fillStyle = C.pin!
    c.beginPath()
    c.moveTo(x, 2)
    c.lineTo(x + 10, 6)
    c.lineTo(x, 10)
    c.closePath()
    c.fill()
    c.fillRect(x - 1, 2, 2, LAYOUT.ruler - 2)
    if (sel) {
      c.strokeStyle = C.text!
      c.lineWidth = 1
      c.strokeRect(x - 3, 1, 15, LAYOUT.ruler - 2)
    }
    if (m.label) {
      c.fillStyle = C.pin!
      c.font = 'bold 11px system-ui, sans-serif'
      c.fillText(m.label, x + 12, 12)
    }
  }

  // 再生ヘッド
  const px = Math.round(xOf(v, d.playhead)) + 0.5
  c.strokeStyle = C.playhead!
  c.lineWidth = 2
  c.beginPath()
  c.moveTo(px, 0)
  c.lineTo(px, TOTAL_HEIGHT)
  c.stroke()
  c.fillStyle = C.playhead!
  c.beginPath()
  c.moveTo(px - 6, 0)
  c.lineTo(px + 6, 0)
  c.lineTo(px, 8)
  c.fill()
  c.restore()
}
