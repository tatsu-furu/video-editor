import { describe, expect, it } from 'vitest'
import type { VideoClip } from '../project/types'
import {
  clipBoundaries,
  keptSourceRanges,
  mergeRanges,
  placeClips,
  sourceRangeToTimeline,
  sourceToTimeline,
  subtractRanges,
  timelineToSource,
  totalDuration,
} from './time'

export const clip = (id: string, assetId: string, a: number, b: number): VideoClip => ({
  id,
  assetId,
  sourceIn: a,
  sourceOut: b,
  gainDb: 0,
  muted: false,
})

const p = { videoTrack: [clip('a', 'A', 0, 10), clip('b', 'B', 5, 8), clip('c', 'A', 20, 25)] }

describe('time', () => {
  it('位置と長さは並び順から導出する', () => {
    expect(placeClips(p.videoTrack).map((x) => [x.start, x.end])).toEqual([
      [0, 10],
      [10, 13],
      [13, 18],
    ])
    expect(totalDuration(p.videoTrack)).toBe(18)
    expect(clipBoundaries(p.videoTrack)).toEqual([0, 10, 13, 18])
  })

  it('timelineToSource：境界は後ろのクリップ、末尾は最後のクリップ、範囲外は null', () => {
    expect(timelineToSource(p, 11)).toMatchObject({ assetId: 'B', sourceTime: 6, index: 1 })
    expect(timelineToSource(p, 10)).toMatchObject({ assetId: 'B', sourceTime: 5 })
    expect(timelineToSource(p, 18)).toMatchObject({ assetId: 'A', sourceTime: 25 })
    expect(timelineToSource(p, 18.5)).toBeNull()
    expect(timelineToSource({ videoTrack: [] }, 0)).toBeNull()
  })

  it('sourceToTimeline：カット済みは null', () => {
    expect(sourceToTimeline(p, 'A', 22)).toBe(15)
    expect(sourceToTimeline(p, 'A', 15)).toBeNull()
    expect(sourceToTimeline(p, 'B', 1)).toBeNull()
  })

  it('ソース区間 → タイムライン区間', () => {
    expect(sourceRangeToTimeline(p.videoTrack, 'A', 8, 22)).toEqual([
      { start: 8, end: 10 },
      { start: 13, end: 15 },
    ])
    expect(keptSourceRanges(p.videoTrack, 'A')).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 25 },
    ])
  })

  it('区間の結合と差', () => {
    expect(
      mergeRanges(
        [
          { start: 3, end: 4 },
          { start: 0, end: 1 },
          { start: 1.2, end: 2 },
        ],
        0.3,
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
    ])
    expect(
      subtractRanges(
        [{ start: 0, end: 10 }],
        [
          { start: 2, end: 3 },
          { start: 9, end: 12 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 9 },
    ])
  })
})
