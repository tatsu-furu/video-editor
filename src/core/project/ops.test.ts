import { describe, expect, it } from 'vitest'
import { createProject, isProject } from './create'
import * as ops from './ops'
import type { Asset, Project } from './types'
import { markerTimes, totalDuration } from '../time/time'
import { clip } from '../time/time.test'

const asset = (id: string, duration: number, kind: 'video' | 'audio' = 'video'): Asset => ({
  id,
  kind,
  name: id,
  duration,
  fingerprint: { name: id, size: 1, lastModified: 0, headHash: 'x' },
  video: kind === 'video' ? { width: 1281, height: 720, fps: 59.94, codec: 'avc' } : undefined,
  audioTracks: [{ index: 0, label: 'A', channels: 2, sampleRate: 48000 }],
  analysisAudioTrack: 0,
})

const splitAt = ops.pure(ops.splitAt)
const rippleDelete = ops.pure(ops.rippleDelete)
const trimClip = ops.pure(ops.trimClip)
const moveClip = ops.pure(ops.moveClip)
const deleteClip = ops.pure(ops.deleteClip)
const addVideo = ops.pure(ops.addVideoAsset)
const addBgm = ops.pure(ops.addBgm)
const replaceSuggestions = ops.pure(ops.replaceSuggestions)
const applySuggestions = ops.pure(ops.applySuggestions)
const generateSubtitles = ops.pure(ops.generateSubtitles)
const splitSubtitle = ops.pure(ops.splitSubtitle)
const mergeSubtitle = ops.pure(ops.mergeSubtitleWithNext)

function base(): Project {
  const p = createProject('t', new Date(0))
  return {
    ...p,
    assets: { A: asset('A', 30), B: asset('B', 10) },
    videoTrack: [clip('a', 'A', 0, 10), clip('b', 'B', 5, 8), clip('c', 'A', 20, 25)],
  }
}

describe('ops', () => {
  it('元のプロジェクトを書き換えない', () => {
    const p = base()
    const json = JSON.stringify(p)
    splitAt(p, 4)
    rippleDelete(p, 1, 2)
    expect(JSON.stringify(p)).toBe(json)
  })

  it('splitAt', () => {
    const s = splitAt(base(), 4)
    expect(s.videoTrack.map((c) => [c.sourceIn, c.sourceOut])).toEqual([
      [0, 4],
      [4, 10],
      [5, 8],
      [20, 25],
    ])
    expect(new Set(s.videoTrack.map((c) => c.id)).size).toBe(4)
    // 境界では分けない
    expect(splitAt(base(), 10).videoTrack).toHaveLength(3)
  })

  it('rippleDelete は複数クリップにまたがって削除し、後ろを詰める', () => {
    const r = rippleDelete(base(), 8, 14)
    expect(r.videoTrack.map((c) => [c.assetId, c.sourceIn, c.sourceOut])).toEqual([
      ['A', 0, 8],
      ['A', 21, 25],
    ])
    expect(totalDuration(r.videoTrack)).toBe(12)
    // クリップの途中だけ削除すると2つに分かれる
    const mid = rippleDelete(base(), 2, 3)
    expect(mid.videoTrack.map((c) => [c.sourceIn, c.sourceOut]).slice(0, 2)).toEqual([
      [0, 2],
      [3, 10],
    ])
    expect(new Set(mid.videoTrack.map((c) => c.id)).size).toBe(4)
  })

  it('trimClip はソース範囲を超えない・moveClip・deleteClip', () => {
    expect(trimClip(base(), 'b', 'in', -5).videoTrack[1]!.sourceIn).toBe(0)
    expect(trimClip(base(), 'b', 'out', 99).videoTrack[1]!.sourceOut).toBe(10)
    expect(trimClip(base(), 'b', 'out', 1).videoTrack[1]!.sourceOut).toBeCloseTo(5.05)
    expect(moveClip(base(), 'c', 0).videoTrack.map((c) => c.id)).toEqual(['c', 'a', 'b'])
    const d = deleteClip(base(), 'b')
    expect(d.videoTrack.map((c) => c.id)).toEqual(['a', 'c'])
    expect(d.assets.B).toBeUndefined()
  })

  it('動画の追加で出力設定が1本目に合う', () => {
    const p = addVideo(createProject(), asset('X', 12))
    expect(p.output).toMatchObject({ width: 1282, height: 720, fps: 60 })
    expect(isProject(p)).toBe(true)
  })

  it('BGM は全体に1クリップ、ループ・フェード 1/2 秒', () => {
    const p = addBgm(base(), asset('M', 12, 'audio'))
    expect(p.bgmTrack[0]).toMatchObject({
      timelineStart: 0,
      timelineEnd: 18,
      loop: true,
      fadeIn: 1,
      fadeOut: 2,
    })
    // カットで短くなれば BGM も切り詰める
    expect(rippleDelete(p, 0, 10).bgmTrack[0]!.timelineEnd).toBe(8)
  })

  it('候補の適用はソース区間をカットし、pending だけを置き換えられる', () => {
    let p = replaceSuggestions(base(), 'A', [
      { kind: 'silence', sourceStart: 2, sourceEnd: 3, score: 0.5 },
      { kind: 'silence', sourceStart: 9, sourceEnd: 21, score: 0.5 },
      { kind: 'highlight', sourceStart: 22, sourceEnd: 24, score: 1 },
    ])
    const ids = p.suggestions.map((s) => s.id)
    p = applySuggestions(p, ids)
    expect(p.videoTrack.map((c) => [c.assetId, c.sourceIn, c.sourceOut])).toEqual([
      ['A', 0, 2],
      ['A', 3, 9],
      ['B', 5, 8],
      ['A', 21, 25],
    ])
    expect(p.suggestions.every((s) => s.status === 'accepted')).toBe(true)
    p = replaceSuggestions(p, 'A', [{ kind: 'silence', sourceStart: 0, sourceEnd: 1, score: 1 }])
    expect(p.suggestions).toHaveLength(4)
  })

  it('字幕の生成・分割・結合', () => {
    let p = generateSubtitles(base(), 'A', [
      { sourceStart: 0, sourceEnd: 2, text: 'あいうえ' },
      { sourceStart: 3, sourceEnd: 4, text: 'かき' },
    ])
    expect(p.subtitles).toHaveLength(2)
    const id = p.subtitles[0]!.id
    p = splitSubtitle(p, id, 1)
    expect(p.subtitles.map((s) => s.text)).toEqual(['あい', 'うえ', 'かき'])
    p = mergeSubtitle(p, p.subtitles[1]!.id)
    expect(p.subtitles.map((s) => [s.text, s.sourceEnd])).toEqual([
      ['あい', 1],
      ['うえかき', 4],
    ])
    // 再生成は置き換え
    p = generateSubtitles(p, 'A', [{ sourceStart: 0, sourceEnd: 1, text: 'x' }])
    expect(p.subtitles).toHaveLength(1)
  })
})

describe('ピンとまとめて削除', () => {
  const deleteClips = ops.pure(ops.deleteClips)
  const addMarker = ops.pure(ops.addMarker)
  const removeMarker = ops.pure(ops.removeMarker)

  it('チェックした複数のクリップを1回で削除して詰める', () => {
    const p = deleteClips(base(), ['a', 'c'])
    expect(p.videoTrack.map((c) => c.id)).toEqual(['b'])
    expect(p.assets.A).toBeUndefined()
  })

  it('ピンはソース時刻で付き、カットしても同じ場面に残る', () => {
    let p = addMarker(base(), 11, '見どころ')
    expect(markerTimes(p)).toEqual([{ id: p.markers![0]!.id, t: 11, label: '見どころ' }])
    // 前のクリップを消すと、ピンも一緒に前へ詰まる
    p = deleteClips(p, ['a'])
    expect(markerTimes(p)[0]!.t).toBe(1)
    // ピンのある場面を消すと出なくなる
    expect(markerTimes(deleteClips(p, ['b']))).toEqual([])
    p = removeMarker(p, p.markers![0]!.id)
    expect(p.markers).toEqual([])
  })
})
