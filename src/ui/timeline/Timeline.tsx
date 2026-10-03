/**
 * タイムライン（設計書 6.3）。上から「字幕」「映像（波形付き）」「BGM（ダッキングカーブ付き）」。
 *
 * 操作：クリックで再生ヘッド移動とクリップ選択、端のドラッグでトリム、クリップのドラッグで並べ替え、
 * 目盛りのドラッグで範囲選択（I/O）。字幕はドラッグで移動・端で長さ変更・ダブルクリックで編集。
 * スナップは再生ヘッド・クリップ境界・字幕境界に吸着する（Shift で無効）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as ops from '../../core/project/ops'
import type { Sec } from '../../core/project/types'
import { clipBoundaries, placeClips, timelineToSource, totalDuration } from '../../core/time/time'
import { seek } from '../../playback/controller'
import { cues as cuesOf, duckCurve } from '../../store/derived'
import { beginGesture, edit, endGesture, previewGesture, useProject } from '../../store/project'
import { useSession } from '../../store/session'
import { ja } from '../../i18n/ja'
import { LAYOUT, TOTAL_HEIGHT, drawTimeline, tOf, trackTop, xOf, type View } from './draw'

type Drag =
  | { kind: 'scrub' }
  | { kind: 'range'; from: Sec; moved: boolean; x0: number }
  | { kind: 'trim'; clipId: string; edge: 'in' | 'out'; x0: number; src0: number }
  | { kind: 'reorder'; clipId: string; x0: number; moved: boolean }
  | {
      kind: 'sub'
      subId: string
      mode: 'move' | 'start' | 'end'
      x0: number
      s0: number
      e0: number
      moved: boolean
    }
  | { kind: 'pan'; x0: number; scroll0: number }

const EDGE = 6
const SNAP_PX = 8

function cssColors(el: HTMLElement): Record<string, string> {
  const s = getComputedStyle(el)
  const get = (n: string) => s.getPropertyValue(`--tl-${n}`).trim() || '#888'
  const names = [
    'bg',
    'ruler',
    'line',
    'muted',
    'gutter',
    'range',
    'sub',
    'subSel',
    'subText',
    'clipA',
    'clipB',
    'clipEdge',
    'wave',
    'accent',
    'highlight',
    'highlightFill',
    'cut',
    'cutFill',
    'bgm',
    'duck',
    'playhead',
    'text',
  ]
  return Object.fromEntries(names.map((n) => [n, get(n)]))
}

export function Timeline() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(800)
  const [scroll, setScroll] = useState(0)
  const [dropAt, setDropAt] = useState<Sec | null>(null)
  const [editing, setEditing] = useState<{ id: string; x: number; w: number; text: string } | null>(
    null,
  )
  const drag = useRef<Drag | null>(null)

  const project = useProject((s) => s.project)
  const session = useSession()
  const total = project ? totalDuration(project.videoTrack) : 0
  const fit = Math.max(0.5, (width - LAYOUT.gutter - 12) / Math.max(1, total))
  const zoom = session.zoom ?? fit
  const maxScroll = Math.max(0, total - (width - LAYOUT.gutter - 12) / zoom)
  const view: View = { zoom, scroll: session.zoom == null ? 0 : Math.min(scroll, maxScroll), width }

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // 再生中は再生ヘッドが見えるようにスクロールする
  useEffect(() => {
    if (session.zoom == null || !session.playing) return
    const x = xOf(view, session.playhead)
    if (x > width - 40 || x < LAYOUT.gutter) setScroll(Math.max(0, session.playhead - 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.playhead])

  // 描画
  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !project) return
    const dpr = window.devicePixelRatio || 1
    if (cv.width !== Math.round(width * dpr) || cv.height !== Math.round(TOTAL_HEIGHT * dpr)) {
      cv.width = Math.round(width * dpr)
      cv.height = Math.round(TOTAL_HEIGHT * dpr)
    }
    const c = cv.getContext('2d')!
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    const envelopes: Record<string, Float32Array | undefined> = {}
    for (const [id, a] of Object.entries(session.analysis)) envelopes[id] = a.result?.envelope
    drawTimeline(c, view, {
      project,
      cues: cuesOf(project),
      duck: duckCurve(project, session.analysis),
      envelopes,
      thumbs: session.thumbs,
      playhead: session.playhead,
      inPoint: session.inPoint,
      outPoint: session.outPoint,
      selectedClip: session.selectedClip,
      selectedSubtitle: session.selectedSubtitle,
      selectedSuggestion: session.selectedSuggestion,
      dropAt,
      colors: cssColors(cv),
    })
  })

  /** スナップ先の候補（再生ヘッド・クリップ境界・字幕境界） */
  const snap = useCallback(
    (t: Sec, shift: boolean): Sec => {
      if (!project || shift || !useSession.getState().snap) return t
      const pts = [useSession.getState().playhead, ...clipBoundaries(project.videoTrack)]
      for (const c of cuesOf(project)) pts.push(c.start, c.end)
      let best = t
      let bestD = SNAP_PX / zoom
      for (const p of pts) {
        const d = Math.abs(p - t)
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      return best
    },
    [project, zoom],
  )

  if (!project) return null

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const inTrack = (y: number, top: number, h: number) => y >= top && y < top + h

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = pos(e)
    if (x < LAYOUT.gutter) return
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const t = tOf(view, x)
    if (e.button === 1) {
      drag.current = { kind: 'pan', x0: x, scroll0: view.scroll }
      return
    }
    if (y < LAYOUT.ruler) {
      drag.current = { kind: 'range', from: t, moved: false, x0: x }
      return
    }
    if (inTrack(y, trackTop.video, LAYOUT.video)) {
      for (const pc of placeClips(project.videoTrack)) {
        const xa = xOf(view, pc.start)
        const xb = xOf(view, pc.end)
        if (Math.abs(x - xa) <= EDGE && x >= xa - EDGE) {
          beginGesture()
          drag.current = {
            kind: 'trim',
            clipId: pc.clip.id,
            edge: 'in',
            x0: x,
            src0: pc.clip.sourceIn,
          }
          useSession.setState({ selectedClip: pc.clip.id, selectedSuggestion: null })
          return
        }
        if (Math.abs(x - xb) <= EDGE) {
          beginGesture()
          drag.current = {
            kind: 'trim',
            clipId: pc.clip.id,
            edge: 'out',
            x0: x,
            src0: pc.clip.sourceOut,
          }
          useSession.setState({ selectedClip: pc.clip.id, selectedSuggestion: null })
          return
        }
      }
      const hit = timelineToSource(project, t)
      if (hit) {
        // 候補の上なら候補を選ぶ
        const sug = project.suggestions.find(
          (s) =>
            s.status === 'pending' &&
            s.assetId === hit.assetId &&
            hit.sourceTime >= s.sourceStart &&
            hit.sourceTime < s.sourceEnd,
        )
        useSession.setState({
          selectedClip: hit.clip.id,
          selectedSuggestion: sug?.id ?? null,
          selectedSubtitle: null,
        })
        drag.current = { kind: 'reorder', clipId: hit.clip.id, x0: x, moved: false }
      }
      seek(t)
      return
    }
    if (inTrack(y, trackTop.subs, LAYOUT.subs)) {
      const cue = cuesOf(project).find(
        (c) => t >= c.start - EDGE / zoom && t <= c.end + EDGE / zoom,
      )
      const sub = cue && project.subtitles.find((s) => s.id === cue.id)
      if (cue && sub) {
        const xa = xOf(view, cue.start)
        const xb = xOf(view, cue.end)
        const mode = Math.abs(x - xa) <= EDGE ? 'start' : Math.abs(x - xb) <= EDGE ? 'end' : 'move'
        beginGesture()
        drag.current = {
          kind: 'sub',
          subId: sub.id,
          mode,
          x0: x,
          s0: sub.sourceStart,
          e0: sub.sourceEnd,
          moved: false,
        }
        useSession.setState({ selectedSubtitle: sub.id, selectedClip: null })
        if (mode === 'move') seek(cue.start)
        return
      }
    }
    drag.current = { kind: 'scrub' }
    seek(t)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = pos(e)
    const d = drag.current
    const cv = canvasRef.current!
    if (!d) {
      // カーソルの形
      let cursor = 'default'
      if (inTrack(y, trackTop.video, LAYOUT.video)) {
        for (const pc of placeClips(project.videoTrack)) {
          if (Math.abs(x - xOf(view, pc.start)) <= EDGE || Math.abs(x - xOf(view, pc.end)) <= EDGE)
            cursor = 'ew-resize'
        }
        if (cursor === 'default') cursor = 'grab'
      } else if (y < LAYOUT.ruler) cursor = 'text'
      cv.style.cursor = cursor
      return
    }
    const t = tOf(view, x)
    if (d.kind === 'pan') setScroll(Math.max(0, d.scroll0 - (x - d.x0) / zoom))
    else if (d.kind === 'scrub') seek(t)
    else if (d.kind === 'range') {
      if (Math.abs(x - d.x0) > 3) d.moved = true
      if (d.moved) {
        const a = snap(d.from, e.shiftKey)
        const b = snap(t, e.shiftKey)
        useSession.setState({
          inPoint: Math.max(0, Math.min(a, b)),
          outPoint: Math.min(total, Math.max(a, b)),
        })
      }
    } else if (d.kind === 'trim') {
      const pc = placeClips(useProject.getState().project!.videoTrack).find(
        (p) => p.clip.id === d.clipId,
      )
      let src = d.src0 + (x - d.x0) / zoom
      if (pc && d.edge === 'out') {
        // 端のタイムライン位置でスナップする
        const edgeT = snap(pc.start + (src - pc.clip.sourceIn), e.shiftKey)
        src = pc.clip.sourceIn + (edgeT - pc.start)
      }
      previewGesture(ops.trimClip, d.clipId, d.edge, src)
    } else if (d.kind === 'reorder') {
      if (Math.abs(x - d.x0) > 5) d.moved = true
      if (d.moved) {
        const b = clipBoundaries(project.videoTrack)
        let best = b[0]!
        for (const bb of b) if (Math.abs(bb - t) < Math.abs(best - t)) best = bb
        setDropAt(best)
      }
    } else if (d.kind === 'sub') {
      if (Math.abs(x - d.x0) > 3) d.moved = true
      if (!d.moved) return
      const dt = (x - d.x0) / zoom
      const patch =
        d.mode === 'move'
          ? { sourceStart: Math.max(0, d.s0 + dt), sourceEnd: Math.max(0.1, d.e0 + dt) }
          : d.mode === 'start'
            ? { sourceStart: Math.min(d.e0 - 0.1, Math.max(0, d.s0 + dt)) }
            : { sourceEnd: Math.max(d.s0 + 0.1, d.e0 + dt) }
      previewGesture(ops.updateSubtitle, d.subId, patch)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const { x } = pos(e)
    if (d.kind === 'range' && !d.moved) {
      seek(tOf(view, x))
      useSession.setState({ inPoint: null, outPoint: null })
    } else if (d.kind === 'trim') {
      const cur = useProject.getState().project!.videoTrack.find((c) => c.id === d.clipId)
      if (cur)
        endGesture(ops.trimClip, d.clipId, d.edge, d.edge === 'in' ? cur.sourceIn : cur.sourceOut)
      else endGesture(null)
    } else if (d.kind === 'reorder' && d.moved && dropAt != null) {
      const b = clipBoundaries(project.videoTrack)
      let idx = b.findIndex((bb) => Math.abs(bb - dropAt) < 1e-6)
      const from = project.videoTrack.findIndex((c) => c.id === d.clipId)
      if (idx > from) idx -= 1
      if (idx >= 0 && idx !== from) edit(ops.moveClip, d.clipId, idx)
      setDropAt(null)
    } else if (d.kind === 'sub') {
      const cur = useProject.getState().project!.subtitles.find((s) => s.id === d.subId)
      if (d.moved && cur)
        endGesture(ops.updateSubtitle, d.subId, {
          sourceStart: cur.sourceStart,
          sourceEnd: cur.sourceEnd,
        })
      else endGesture(null)
    }
    setDropAt(null)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = pos(e)
    if (!inTrack(y, trackTop.subs, LAYOUT.subs)) return
    const t = tOf(view, x)
    const cue = cuesOf(project).find((c) => t >= c.start && t <= c.end)
    const sub = cue && project.subtitles.find((s) => s.id === cue.id)
    if (cue && sub) {
      setEditing({
        id: sub.id,
        x: xOf(view, cue.start),
        w: Math.max(160, (cue.end - cue.start) * zoom),
        text: sub.text,
      })
      return
    }
    // 字幕のない場所：空の字幕を足す
    const hit = timelineToSource(project, t)
    if (!hit) return
    const end = Math.min(hit.clip.sourceOut, hit.sourceTime + 2)
    edit(ops.addSubtitle, {
      assetId: hit.assetId,
      sourceStart: hit.sourceTime,
      sourceEnd: Math.max(end, hit.sourceTime + 0.5),
      text: '',
    })
    const added = useProject
      .getState()
      .project!.subtitles.find(
        (s) => s.assetId === hit.assetId && Math.abs(s.sourceStart - hit.sourceTime) < 1e-6,
      )
    if (added) setEditing({ id: added.id, x: xOf(view, t), w: 200, text: '' })
  }

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const f = e.deltaY < 0 ? 1.25 : 0.8
      const { x } = pos(e)
      const t = tOf(view, x)
      const nz = Math.max(0.5, Math.min(600, zoom * f))
      useSession.setState({ zoom: nz })
      setScroll(Math.max(0, t - (x - LAYOUT.gutter) / nz))
    } else if (session.zoom != null) {
      setScroll(Math.max(0, Math.min(maxScroll, view.scroll + (e.deltaX || e.deltaY) / zoom)))
    }
  }

  return (
    <section className="timeline" aria-label="タイムライン">
      <div className="timeline-bar">
        <label>
          {ja.timeline.zoom}
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round((Math.log(zoom / fit) / Math.log(600 / fit)) * 100) || 0}
            onChange={(e) => {
              const r = Number(e.target.value) / 100
              useSession.setState({ zoom: r <= 0 ? null : fit * Math.pow(600 / fit, r) })
            }}
          />
        </label>
        <button type="button" onClick={() => useSession.setState({ zoom: null })} title="Shift+Z">
          {ja.timeline.fit}
        </button>
        <label>
          <input
            type="checkbox"
            checked={session.snap}
            onChange={(e) => useSession.setState({ snap: e.target.checked })}
          />
          {ja.timeline.snap}
        </label>
        <button
          type="button"
          onClick={() => edit(ops.splitAt, session.playhead)}
          title="S / Ctrl+B"
        >
          {ja.timeline.split}
        </button>
        <button
          type="button"
          title="Delete"
          disabled={
            !(session.selectedClip || (session.inPoint != null && session.outPoint != null))
          }
          onClick={() => {
            if (session.inPoint != null && session.outPoint != null) {
              edit(ops.rippleDelete, session.inPoint, session.outPoint)
              useSession.setState({ inPoint: null, outPoint: null })
            } else if (session.selectedClip) {
              edit(ops.deleteClip, session.selectedClip)
              useSession.setState({ selectedClip: null })
            }
          }}
        >
          {ja.timeline.remove}
        </button>
      </div>
      <div className="timeline-canvas" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: TOTAL_HEIGHT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            drag.current = null
            endGesture(null)
          }}
          onDoubleClick={onDoubleClick}
          onWheel={onWheel}
        />
        {editing && (
          <textarea
            className="sub-editor"
            style={{
              left: Math.max(LAYOUT.gutter, editing.x),
              top: trackTop.subs - 4,
              width: editing.w,
            }}
            autoFocus
            defaultValue={editing.text}
            onBlur={(e) => {
              const text = e.target.value.trim()
              if (text) edit(ops.updateSubtitle, editing.id, { text })
              else edit(ops.deleteSubtitle, editing.id)
              setEditing(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                ;(e.target as HTMLTextAreaElement).blur()
              }
              if (e.key === 'Escape') setEditing(null)
            }}
          />
        )}
      </div>
    </section>
  )
}
