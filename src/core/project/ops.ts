/**
 * 編集操作（設計書 5章「編集操作」）。
 *
 * 各操作は Immer の draft を書き換える「レシピ」として書き、`pure` で包んだ純粋関数も公開する。
 * ストアはレシピを produceWithPatches に渡して Undo/Redo 用のパッチを得る。
 */
import { produce, type Draft } from 'immer'
import { newId } from './create'
import type { Asset, BgmClip, Id, Project, Sec, SubtitleItem, Suggestion, VideoClip } from './types'
import { mergeRanges, placeClips, timelineToSource, totalDuration, type Range } from '../time/time'

export type Recipe<A extends unknown[]> = (d: Draft<Project>, ...args: A) => void

/** レシピから純粋関数を作る */
export const pure =
  <A extends unknown[]>(r: Recipe<A>) =>
  (p: Project, ...args: A): Project =>
    produce(p, (d) => {
      r(d, ...args)
    })

/** 短すぎるクリップは作らない */
export const MIN_CLIP: Sec = 0.05

const stamp = (d: Draft<Project>) => {
  d.updatedAt = new Date().toISOString()
}

/* ---------- 素材 ---------- */

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
export function normalizeFps(f: number): number {
  if (!Number.isFinite(f) || f <= 0) return 30
  if (f > 50) return 60
  if (f > 27) return 30
  if (f > 24.5) return 25
  return 24
}

export const addVideoAsset: Recipe<[Asset]> = (d, asset) => {
  d.assets[asset.id] = asset
  if (d.videoTrack.length === 0 && asset.video) {
    d.output.width = even(asset.video.width)
    d.output.height = even(asset.video.height)
    d.output.fps = normalizeFps(asset.video.fps)
  }
  d.videoTrack.push({
    id: newId(),
    assetId: asset.id,
    sourceIn: 0,
    sourceOut: asset.duration,
    gainDb: 0,
    muted: false,
  })
  stamp(d)
}

/** BGM を追加する。既定はタイムライン全体に1クリップ・ループ・フェード 1s/2s（設計書 9.1） */
export const addBgm: Recipe<[Asset, Range?]> = (d, asset, range) => {
  d.assets[asset.id] = asset
  const len = totalDuration(d.videoTrack)
  const start = range?.start ?? 0
  const end = range?.end ?? (len || asset.duration)
  // 重なる BGM は取り除く（重なりは不可）
  d.bgmTrack = d.bgmTrack.filter((b) => b.timelineEnd <= start || b.timelineStart >= end)
  d.bgmTrack.push({
    id: newId(),
    assetId: asset.id,
    timelineStart: start,
    timelineEnd: end,
    sourceOffset: 0,
    loop: true,
    fadeIn: 1,
    fadeOut: 2,
  })
  d.bgmTrack.sort((a, b) => a.timelineStart - b.timelineStart)
  stamp(d)
}

export const updateBgm: Recipe<[Id, Partial<Omit<BgmClip, 'id' | 'assetId'>>]> = (d, id, patch) => {
  const b = d.bgmTrack.find((x) => x.id === id)
  if (!b) return
  Object.assign(b, patch)
  b.timelineStart = Math.max(0, b.timelineStart)
  b.timelineEnd = Math.max(b.timelineStart + 0.1, b.timelineEnd)
  stamp(d)
}

export const removeBgm: Recipe<[Id]> = (d, id) => {
  d.bgmTrack = d.bgmTrack.filter((b) => b.id !== id)
  pruneAssets(d)
  stamp(d)
}

/** BGM がタイムラインの末尾を超えていたら切り詰める（カットで短くなったとき） */
export const fitBgm: Recipe<[]> = (d) => {
  const len = totalDuration(d.videoTrack)
  for (const b of d.bgmTrack) if (b.timelineEnd > len) b.timelineEnd = len
  d.bgmTrack = d.bgmTrack.filter((b) => b.timelineEnd - b.timelineStart > 0.1)
}

/** どこからも使われなくなった素材と、その字幕・候補を消す */
export function pruneAssets(d: Draft<Project>) {
  const used = new Set<Id>([
    ...d.videoTrack.map((c) => c.assetId),
    ...d.bgmTrack.map((c) => c.assetId),
  ])
  for (const id of Object.keys(d.assets)) if (!used.has(id)) delete d.assets[id]
  d.subtitles = d.subtitles.filter((s) => used.has(s.assetId))
  d.suggestions = d.suggestions.filter((s) => used.has(s.assetId))
}

export const setAnalysisTrack: Recipe<[Id, number]> = (d, assetId, index) => {
  const a = d.assets[assetId]
  if (a) a.analysisAudioTrack = index
}

/* ---------- 映像トラック ---------- */

/** タイムライン時刻 t でクリップを2つに分ける */
export const splitAt: Recipe<[Sec]> = (d, t) => {
  const hit = timelineToSource(d, t)
  if (!hit) return
  const c = d.videoTrack[hit.index]!
  if (hit.sourceTime - c.sourceIn < MIN_CLIP || c.sourceOut - hit.sourceTime < MIN_CLIP) return
  const b: VideoClip = { ...c, id: newId(), sourceIn: hit.sourceTime }
  c.sourceOut = hit.sourceTime
  d.videoTrack.splice(hit.index + 1, 0, b)
  stamp(d)
}

/** タイムライン区間 [t0, t1) を削除して後ろを詰める（複数クリップにまたがってよい） */
export const rippleDelete: Recipe<[Sec, Sec]> = (d, t0, t1) => {
  const a = Math.min(t0, t1)
  const b = Math.max(t0, t1)
  if (b - a < 1e-6) return
  const next: VideoClip[] = []
  for (const p of placeClips(d.videoTrack as VideoClip[])) {
    const c = { ...p.clip }
    if (p.end <= a || p.start >= b) {
      next.push(c)
      continue
    }
    if (a - p.start >= MIN_CLIP) next.push({ ...c, sourceOut: c.sourceIn + (a - p.start) })
    if (p.end - b >= MIN_CLIP) {
      const tail = { ...c, sourceIn: c.sourceIn + (b - p.start) }
      // 前半を残した場合は後半に新しい ID を振る
      if (a - p.start >= MIN_CLIP) tail.id = newId()
      next.push(tail)
    }
  }
  d.videoTrack = next
  fitBgm(d)
  stamp(d)
}

export const deleteClip: Recipe<[Id]> = (d, clipId) => {
  d.videoTrack = d.videoTrack.filter((c) => c.id !== clipId)
  pruneAssets(d)
  fitBgm(d)
  stamp(d)
}

/** クリップの開始・終了をトリムする（ソースの範囲を超えない） */
export const trimClip: Recipe<[Id, 'in' | 'out', Sec]> = (d, clipId, edge, newSourceTime) => {
  const c = d.videoTrack.find((x) => x.id === clipId)
  if (!c) return
  const dur = d.assets[c.assetId]?.duration ?? c.sourceOut
  if (edge === 'in') c.sourceIn = Math.max(0, Math.min(newSourceTime, c.sourceOut - MIN_CLIP))
  else c.sourceOut = Math.min(dur, Math.max(newSourceTime, c.sourceIn + MIN_CLIP))
  fitBgm(d)
  stamp(d)
}

export const moveClip: Recipe<[Id, number]> = (d, clipId, newIndex) => {
  const from = d.videoTrack.findIndex((c) => c.id === clipId)
  if (from < 0) return
  const [c] = d.videoTrack.splice(from, 1)
  d.videoTrack.splice(Math.max(0, Math.min(d.videoTrack.length, newIndex)), 0, c!)
  stamp(d)
}

export const setClipAudio: Recipe<[Id, { gainDb?: number; muted?: boolean }]> = (
  d,
  clipId,
  patch,
) => {
  const c = d.videoTrack.find((x) => x.id === clipId)
  if (c) Object.assign(c, patch)
}

/** ソース区間を取り除く（自動カット候補の適用で使う） */
function cutSource(d: Draft<Project>, assetId: Id, ranges: readonly Range[]) {
  const sorted = mergeRanges(ranges)
  const out: VideoClip[] = []
  for (const orig of d.videoTrack as VideoClip[]) {
    if (orig.assetId !== assetId) {
      out.push(orig)
      continue
    }
    let pieces: VideoClip[] = [{ ...orig }]
    for (const r of sorted) {
      const next: VideoClip[] = []
      for (const p of pieces) {
        if (r.end <= p.sourceIn || r.start >= p.sourceOut) next.push(p)
        else {
          if (r.start - p.sourceIn >= MIN_CLIP) next.push({ ...p, sourceOut: r.start })
          if (p.sourceOut - r.end >= MIN_CLIP) next.push({ ...p, sourceIn: r.end })
        }
      }
      pieces = next
    }
    pieces.forEach((p, i) => out.push({ ...p, id: i === 0 ? orig.id : newId() }))
  }
  d.videoTrack = out
}

/** ソース区間をタイムラインから取り除いて詰める（文字起こしの「この部分をカット」） */
export const cutSourceRange: Recipe<[Id, Sec, Sec]> = (d, assetId, start, end) => {
  cutSource(d, assetId, [{ start, end }])
  fitBgm(d)
  stamp(d)
}

/* ---------- 自動カット候補 ---------- */

/** 再計算した候補で、その素材の未処理（pending）の候補だけを置き換える */
export const replaceSuggestions: Recipe<[Id, Omit<Suggestion, 'id' | 'assetId' | 'status'>[]]> = (
  d,
  assetId,
  found,
) => {
  const kept = d.suggestions.filter((s) => s.assetId !== assetId || s.status !== 'pending')
  const added: Suggestion[] = found.map((f) => ({ ...f, id: newId(), assetId, status: 'pending' }))
  d.suggestions = [...kept, ...added].sort((a, b) => a.sourceStart - b.sourceStart)
}

/** 削除候補をまとめてカットし、status を accepted にする（Undo 1回分） */
export const applySuggestions: Recipe<[readonly Id[]]> = (d, ids) => {
  const set = new Set(ids)
  const byAsset = new Map<Id, Range[]>()
  for (const s of d.suggestions) {
    if (!set.has(s.id) || s.status !== 'pending') continue
    s.status = 'accepted'
    if (s.kind === 'highlight') continue
    const list = byAsset.get(s.assetId) ?? []
    list.push({ start: s.sourceStart, end: s.sourceEnd })
    byAsset.set(s.assetId, list)
  }
  for (const [assetId, ranges] of byAsset) cutSource(d, assetId, ranges)
  fitBgm(d)
  stamp(d)
}

export const rejectSuggestions: Recipe<[readonly Id[]]> = (d, ids) => {
  const set = new Set(ids)
  for (const s of d.suggestions) if (set.has(s.id)) s.status = 'rejected'
}

export const setMode: Recipe<[Project['mode']]> = (d, mode) => {
  d.mode = mode
}

/* ---------- 字幕 ---------- */

/** 文字起こしから作った字幕で、その素材の字幕を置き換える */
export const generateSubtitles: Recipe<[Id, readonly Omit<SubtitleItem, 'id' | 'assetId'>[]]> = (
  d,
  assetId,
  items,
) => {
  d.subtitles = [
    ...d.subtitles.filter((s) => s.assetId !== assetId),
    ...items.map((i) => ({ ...i, id: newId(), assetId })),
  ].sort((a, b) => a.assetId.localeCompare(b.assetId) || a.sourceStart - b.sourceStart)
  stamp(d)
}

export const updateSubtitle: Recipe<
  [Id, Partial<Pick<SubtitleItem, 'text' | 'sourceStart' | 'sourceEnd'>>]
> = (d, id, patch) => {
  const s = d.subtitles.find((x) => x.id === id)
  if (!s) return
  Object.assign(s, patch)
  if (s.sourceEnd < s.sourceStart + 0.1) s.sourceEnd = s.sourceStart + 0.1
  stamp(d)
}

export const addSubtitle: Recipe<[Omit<SubtitleItem, 'id'>]> = (d, item) => {
  d.subtitles.push({ ...item, id: newId() })
  d.subtitles.sort((a, b) => a.sourceStart - b.sourceStart)
  stamp(d)
}

export const deleteSubtitle: Recipe<[Id]> = (d, id) => {
  d.subtitles = d.subtitles.filter((s) => s.id !== id)
  stamp(d)
}

/** ソース時刻 at で字幕を分ける。テキストは文字数比で分ける */
export const splitSubtitle: Recipe<[Id, Sec]> = (d, id, at) => {
  const i = d.subtitles.findIndex((s) => s.id === id)
  const s = d.subtitles[i]
  if (!s || at <= s.sourceStart + 0.1 || at >= s.sourceEnd - 0.1) return
  const chars = Array.from(s.text)
  const k = Math.max(
    1,
    Math.min(
      chars.length - 1,
      Math.round((chars.length * (at - s.sourceStart)) / (s.sourceEnd - s.sourceStart)),
    ),
  )
  const second: SubtitleItem = {
    id: newId(),
    assetId: s.assetId,
    sourceStart: at,
    sourceEnd: s.sourceEnd,
    text: chars.slice(k).join(''),
  }
  s.sourceEnd = at
  s.text = chars.slice(0, k).join('')
  d.subtitles.splice(i + 1, 0, second)
  stamp(d)
}

/** 次の字幕と結合する */
export const mergeSubtitleWithNext: Recipe<[Id]> = (d, id) => {
  const same = d.subtitles.filter((s) => s.id === id)
  const s = same[0]
  if (!s) return
  const next = d.subtitles
    .filter((x) => x.assetId === s.assetId && x.sourceStart >= s.sourceStart && x.id !== s.id)
    .sort((a, b) => a.sourceStart - b.sourceStart)[0]
  if (!next) return
  s.text = `${s.text}${next.text}`
  s.sourceEnd = Math.max(s.sourceEnd, next.sourceEnd)
  d.subtitles = d.subtitles.filter((x) => x.id !== next.id)
  stamp(d)
}

export const setSubtitleStyle: Recipe<[Partial<Project['subtitleStyle']>]> = (d, patch) => {
  Object.assign(d.subtitleStyle, patch)
  stamp(d)
}

export const setAudioMix: Recipe<
  [
    Partial<Omit<Project['audioMix'], 'ducking'>> & {
      ducking?: Partial<Project['audioMix']['ducking']>
    },
  ]
> = (d, patch) => {
  const { ducking, ...rest } = patch
  Object.assign(d.audioMix, rest)
  if (ducking) Object.assign(d.audioMix.ducking, ducking)
  stamp(d)
}

export const rename: Recipe<[string]> = (d, name) => {
  d.name = name.trim() || d.name
  stamp(d)
}
