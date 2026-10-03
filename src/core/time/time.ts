/**
 * タイムライン時刻とソース時刻の変換（設計書 5章「編集操作」）。
 *
 * 映像トラックはマグネティックなので、クリップの位置は並び順と長さから毎回求める。
 */
import type { Id, Project, Sec, VideoClip } from '../project/types'

export interface PlacedClip {
  clip: VideoClip
  index: number
  start: Sec
  end: Sec
}

export interface Range {
  start: Sec
  end: Sec
}

const EPS = 1e-6

export const clipDuration = (c: VideoClip): Sec => Math.max(0, c.sourceOut - c.sourceIn)

export function placeClips(track: readonly VideoClip[]): PlacedClip[] {
  const out: PlacedClip[] = []
  let t = 0
  track.forEach((clip, index) => {
    const d = clipDuration(clip)
    out.push({ clip, index, start: t, end: t + d })
    t += d
  })
  return out
}

export function totalDuration(track: readonly VideoClip[]): Sec {
  return track.reduce((s, c) => s + clipDuration(c), 0)
}

/** クリップ境界のタイムライン時刻（先頭 0 と末尾を含む） */
export function clipBoundaries(track: readonly VideoClip[]): Sec[] {
  const out = [0]
  for (const p of placeClips(track)) out.push(p.end)
  return out
}

export interface SourcePoint {
  clip: VideoClip
  index: number
  /** クリップのタイムライン上の開始 */
  clipStart: Sec
  assetId: Id
  sourceTime: Sec
}

/**
 * タイムライン時刻 → ソース時刻。境界ちょうどは後ろのクリップに属する。
 * 末尾ちょうどは最後のクリップの終わり。範囲外は null。
 */
export function timelineToSource(project: Pick<Project, 'videoTrack'>, t: Sec): SourcePoint | null {
  const placed = placeClips(project.videoTrack)
  if (placed.length === 0 || t < -EPS) return null
  for (const p of placed) {
    if (t < p.end - EPS)
      return {
        clip: p.clip,
        index: p.index,
        clipStart: p.start,
        assetId: p.clip.assetId,
        sourceTime: p.clip.sourceIn + Math.max(0, t - p.start),
      }
  }
  const last = placed[placed.length - 1]!
  if (t <= last.end + EPS)
    return {
      clip: last.clip,
      index: last.index,
      clipStart: last.start,
      assetId: last.clip.assetId,
      sourceTime: last.clip.sourceOut,
    }
  return null
}

/**
 * ソース時刻 → タイムライン時刻。カット済み（どのクリップにも含まれない）なら null。
 * 同じソース区間が複数回使われていれば最初のものを返す。
 */
export function sourceToTimeline(
  project: Pick<Project, 'videoTrack'>,
  assetId: Id,
  s: Sec,
): Sec | null {
  for (const p of placeClips(project.videoTrack)) {
    if (p.clip.assetId === assetId && s >= p.clip.sourceIn - EPS && s < p.clip.sourceOut + EPS)
      return p.start + Math.max(0, s - p.clip.sourceIn)
  }
  return null
}

/** ソース区間 → タイムライン区間の列（カットで分かれる・消えることがある） */
export function sourceRangeToTimeline(
  track: readonly VideoClip[],
  assetId: Id,
  start: Sec,
  end: Sec,
): Range[] {
  const out: Range[] = []
  for (const p of placeClips(track)) {
    if (p.clip.assetId !== assetId) continue
    const s = Math.max(start, p.clip.sourceIn)
    const e = Math.min(end, p.clip.sourceOut)
    if (e - s > EPS)
      out.push({ start: p.start + (s - p.clip.sourceIn), end: p.start + (e - p.clip.sourceIn) })
  }
  return out
}

/** 素材ごとに、タイムラインに残っているソース区間 */
export function keptSourceRanges(track: readonly VideoClip[], assetId: Id): Range[] {
  return mergeRanges(
    track
      .filter((c) => c.assetId === assetId)
      .map((c) => ({ start: c.sourceIn, end: c.sourceOut })),
  )
}

/** 重なる・隙間が gap 以下の区間をまとめる */
export function mergeRanges(ranges: readonly Range[], gap = 0): Range[] {
  const s = [...ranges].filter((r) => r.end > r.start).sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of s) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** 区間の集合から別の区間の集合を引く */
export function subtractRanges(from: readonly Range[], remove: readonly Range[]): Range[] {
  let cur = mergeRanges(from)
  for (const r of mergeRanges(remove)) {
    const next: Range[] = []
    for (const c of cur) {
      if (r.end <= c.start || r.start >= c.end) next.push(c)
      else {
        if (r.start > c.start) next.push({ start: c.start, end: r.start })
        if (r.end < c.end) next.push({ start: r.end, end: c.end })
      }
    }
    cur = next
  }
  return cur
}

export const rangesLength = (rs: readonly Range[]): Sec =>
  rs.reduce((s, r) => s + (r.end - r.start), 0)

/** ピンのタイムライン時刻（カットで消えたピンは出さない） */
export function markerTimes(
  project: Pick<Project, 'videoTrack' | 'markers'>,
): { id: Id; t: Sec; label: string }[] {
  const out: { id: Id; t: Sec; label: string }[] = []
  for (const m of project.markers ?? []) {
    const t = sourceToTimeline(project, m.assetId, m.sourceTime)
    if (t != null) out.push({ id: m.id, t, label: m.label })
  }
  return out.sort((a, b) => a.t - b.t)
}
