/**
 * キーボードショートカット（設計書 11.3）。Mac では Ctrl を Cmd に読み替える。
 */
import * as ops from '../core/project/ops'
import { clipBoundaries, markerTimes, timelineToSource, totalDuration } from '../core/time/time'
import { pause, seek, shuttle, stepFrames, togglePlay } from '../playback/controller'
import { edit, redo, undo, useProject } from '../store/project'
import { useSession } from '../store/session'

export const SHORTCUTS: [string, string][] = [
  ['Space', '再生／一時停止'],
  ['J / K / L', '逆再生（倍速）／停止／再生（押すたびに倍速）'],
  ['← / →', '1フレーム移動'],
  ['Shift + ← / →', '1秒移動'],
  ['↑ / ↓', '前／次のクリップ境界・ピンへ移動'],
  ['S または Ctrl+B', '再生ヘッドの位置で分割'],
  ['Q', '再生ヘッドより前を（そのクリップ内で）削除して詰める'],
  ['W', '再生ヘッドより後を（そのクリップ内で）削除して詰める'],
  ['I / O', '範囲の開始点／終了点を設定'],
  ['クリック（映像トラック）', 'クリップにチェックを付ける／外す'],
  ['Delete / Backspace', 'チェックしたクリップ、または I/O 範囲を削除して詰める'],
  ['M', '再生ヘッドの位置にピン（目印）を打つ'],
  ['N / Shift+N', '次／前の自動カット候補へ移動'],
  ['Enter', '選択中の候補を削除する（適用）'],
  ['Backspace（候補を選択中・チェックなし）', '選択中の候補を残す（却下）'],
  ['Ctrl+Z / Ctrl+Shift+Z', '元に戻す／やり直す'],
  ['+ / −', 'タイムラインのズーム'],
  ['Shift + Z', 'タイムライン全体表示'],
  ['?', 'この一覧を表示'],
]

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

/** 次／前の未処理の候補を選んで、その 2 秒前から再生位置を合わせる */
export function gotoSuggestion(dir: 1 | -1): void {
  const p = useProject.getState().project
  if (!p) return
  const s = useSession.getState()
  const list = p.suggestions
    .filter((x) => x.status === 'pending')
    .map((x) => ({ x, t: tlStart(x.assetId, x.sourceStart, x.sourceEnd) }))
    .filter((v): v is { x: (typeof p.suggestions)[number]; t: number } => v.t != null)
    .sort((a, b) => a.t - b.t)
  if (!list.length) return
  const curIdx = list.findIndex((v) => v.x.id === s.selectedSuggestion)
  const next =
    curIdx < 0
      ? dir > 0
        ? (list.find((v) => v.t > s.playhead) ?? list[0]!)
        : ([...list].reverse().find((v) => v.t < s.playhead) ?? list[list.length - 1]!)
      : list[(curIdx + dir + list.length) % list.length]!
  useSession.setState({ selectedSuggestion: next.x.id })
  seek(Math.max(0, next.t - 2))
}

function tlStart(assetId: string, a: number, b: number): number | null {
  const p = useProject.getState().project!
  let t = 0
  for (const c of p.videoTrack) {
    const s = Math.max(a, c.sourceIn)
    const e = Math.min(b, c.sourceOut)
    if (c.assetId === assetId && e > s) return t + (s - c.sourceIn)
    t += c.sourceOut - c.sourceIn
  }
  return null
}

/**
 * Delete キーと「削除して詰める」ボタン：チェックしたクリップ → I/O 範囲 → 選んだピン → 選んだ候補（残す）の順に処理する。
 * 何もしなかったら false
 */
export function deleteSelection(): boolean {
  const p = useProject.getState().project
  const s = useSession.getState()
  if (!p) return false
  const checked = s.checkedClips.filter((id) => p.videoTrack.some((c) => c.id === id))
  if (checked.length) {
    edit(ops.deleteClips, checked)
    useSession.setState({ checkedClips: [], selectedClip: null })
  } else if (s.inPoint != null && s.outPoint != null && s.outPoint > s.inPoint) {
    edit(ops.rippleDelete, s.inPoint, s.outPoint)
    seek(s.inPoint)
    useSession.setState({ inPoint: null, outPoint: null })
  } else if (s.selectedMarker) {
    edit(ops.removeMarker, s.selectedMarker)
    useSession.setState({ selectedMarker: null })
  } else if (s.selectedSuggestion) {
    edit(ops.rejectSuggestions, [s.selectedSuggestion])
  } else return false
  return true
}

export function zoomBy(f: number): void {
  const s = useSession.getState()
  const cur = s.zoom ?? fitZoom()
  useSession.setState({ zoom: Math.max(0.5, Math.min(600, cur * f)) })
}

/** 全体表示のときの拡大率（タイムライン幅が分からないときの目安） */
export function fitZoom(): number {
  const p = useProject.getState().project
  const total = p ? totalDuration(p.videoTrack) : 60
  return Math.max(0.5, (window.innerWidth - 120) / Math.max(1, total))
}

export function handleKey(e: KeyboardEvent): void {
  if (typing(e.target)) return
  const mod = isMac ? e.metaKey : e.ctrlKey
  const p = useProject.getState().project
  const s = useSession.getState()
  if (!p) return
  const key = e.key
  let handled = true

  if (mod && (key === 'z' || key === 'Z')) {
    if (e.shiftKey) redo()
    else undo()
  } else if (mod && (key === 'y' || key === 'Y')) redo()
  else if (mod && (key === 'b' || key === 'B')) edit(ops.splitAt, s.playhead)
  else if (mod) handled = false
  else if (key === ' ') togglePlay()
  else if (key === 'j' || key === 'J') shuttle(-1)
  else if (key === 'k' || key === 'K') pause()
  else if (key === 'l' || key === 'L') shuttle(1)
  else if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const dir = key === 'ArrowLeft' ? -1 : 1
    if (e.shiftKey) seek(s.playhead + dir)
    else stepFrames(dir)
  } else if (key === 'ArrowUp' || key === 'ArrowDown') {
    const b = [...clipBoundaries(p.videoTrack), ...markerTimes(p).map((m) => m.t)].sort(
      (x, y) => x - y,
    )
    const t = s.playhead
    const target =
      key === 'ArrowUp' ? [...b].reverse().find((x) => x < t - 1e-3) : b.find((x) => x > t + 1e-3)
    if (target != null) seek(target)
  } else if (key === 's' || key === 'S') edit(ops.splitAt, s.playhead)
  else if (key === 'q' || key === 'Q' || key === 'w' || key === 'W') {
    const hit = timelineToSource(p, s.playhead)
    if (hit) {
      const start = hit.clipStart
      const end = hit.clipStart + (hit.clip.sourceOut - hit.clip.sourceIn)
      if (key === 'q' || key === 'Q') {
        edit(ops.rippleDelete, start, s.playhead)
        seek(start)
      } else edit(ops.rippleDelete, s.playhead, end)
    }
  } else if (key === 'i' || key === 'I') useSession.setState({ inPoint: s.playhead })
  else if (key === 'o' || key === 'O') useSession.setState({ outPoint: s.playhead })
  else if (key === 'Delete' || key === 'Backspace') {
    if (!deleteSelection()) handled = false
  } else if (key === 'm' || key === 'M') edit(ops.addMarker, s.playhead)
  else if (key === 'n' || key === 'N') gotoSuggestion(e.shiftKey ? -1 : 1)
  else if (key === 'Enter') {
    if (s.selectedSuggestion) {
      const id = s.selectedSuggestion
      edit(ops.applySuggestions, [id])
      gotoSuggestion(1)
    } else handled = false
  } else if (key === '+' || key === '=' || key === ';') zoomBy(1.5)
  else if (key === '-' || key === '_') zoomBy(1 / 1.5)
  else if (key === 'Z' && e.shiftKey) useSession.setState({ zoom: null })
  else if (key === '?') useSession.setState({ helpOpen: !s.helpOpen })
  else if (key === 'Escape')
    useSession.setState({
      helpOpen: false,
      selectedSuggestion: null,
      selectedClip: null,
      checkedClips: [],
      selectedMarker: null,
      inPoint: null,
      outPoint: null,
    })
  else handled = false
  if (handled) e.preventDefault()
}
