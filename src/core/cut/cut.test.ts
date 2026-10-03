import { describe, expect, it } from 'vitest'
import { computeEnvelope, HOP, movingMedian, snapToMinimum } from './envelope'
import { energyVadProbs, speechSegments } from './vad'
import { highlightCandidates, pickToLength, silenceCandidates } from './candidates'

/** [秒, 振幅] を並べた 16kHz の 220Hz 正弦波（微小なノイズ付き） */
export function synth(parts: [number, number][], rate = 16000): Float32Array {
  const total = parts.reduce((s, [d]) => s + d, 0)
  const out = new Float32Array(Math.round(total * rate))
  let i = 0
  let seed = 1
  for (const [d, amp] of parts) {
    const n = Math.round(d * rate)
    for (let k = 0; k < n; k++, i++) {
      seed = (seed * 16807) % 2147483647
      out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate) + 0.0005 * (seed / 2147483647 - 0.5)
    }
  }
  return out
}

describe('envelope', () => {
  it('20ms ごと', () => {
    const env = computeEnvelope(synth([[1, 0.5]]))
    expect(env.length).toBe(50)
    expect(env[25]).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 0)
  })

  it('移動中央値と谷への吸着', () => {
    const s = Float32Array.from({ length: 3000 }, (_, i) => (i % 100 === 0 ? 50 : 0))
    expect(movingMedian(s)[1500]).toBe(0)
    const env = Float32Array.from({ length: 100 }, (_, i) => (i === 40 ? -80 : -20))
    expect(snapToMinimum(env, 0.75)).toBeCloseTo(40 * HOP + HOP / 2)
  })
})

describe('VAD の後処理', () => {
  it('ヒステリシス・短い切れ目の補完・短い発話の除去', () => {
    const f = 0.032
    const probs = [
      ...Array(10).fill(0.1),
      ...Array(20).fill(0.9), // 発話
      ...Array(3).fill(0.4), // 0.35 以上なので継続
      ...Array(5).fill(0.1), // 0.16 秒の切れ目 → 埋める
      ...Array(20).fill(0.8),
      ...Array(30).fill(0.1),
      ...Array(5).fill(0.9), // 0.16 秒の孤立 → 捨てる
      ...Array(10).fill(0.1),
    ]
    const seg = speechSegments(probs)
    expect(seg).toHaveLength(1)
    expect(seg[0]!.start).toBeCloseTo(10 * f)
    expect(seg[0]!.end).toBeCloseTo(58 * f)
  })
})

describe('トークモード（無音カット）', () => {
  // 音 2 秒 / 無音 1.5 秒 / 音 2 秒 / 無音 0.4 秒 / 音 2 秒 / 無音 3 秒 / 音 1 秒
  const pcm = synth([
    [2, 0.3],
    [1.5, 0],
    [2, 0.3],
    [0.4, 0],
    [2, 0.3],
    [3, 0],
    [1, 0.3],
  ])
  const env = computeEnvelope(pcm)
  const { probs, frame } = energyVadProbs(env)
  const speech = speechSegments(probs, frame)

  it('無音区間が ±0.1 秒の精度で候補になる（余白 0.15 秒込み）', () => {
    const c = silenceCandidates(speech, env, 11.9)
    expect(c).toHaveLength(2)
    expect(c[0]!.sourceStart).toBeGreaterThan(2.15 - 0.1)
    expect(c[0]!.sourceStart).toBeLessThan(2.15 + 0.1)
    expect(c[0]!.sourceEnd).toBeGreaterThan(3.35 - 0.1)
    expect(c[0]!.sourceEnd).toBeLessThan(3.35 + 0.1)
    expect(c[1]!.sourceStart).toBeCloseTo(8.05, 0)
    expect(c[1]!.sourceEnd).toBeCloseTo(10.75, 0)
  })

  it('詰め具合（minSilence）で 0.4 秒の間も拾える', () => {
    expect(silenceCandidates(speech, env, 11.9, { minSilence: 0.3, padding: 0.05 })).toHaveLength(3)
  })
})

describe('ゲームモード（盛り上がり）', () => {
  // 静かなゲーム音 60 秒の中に、40 秒地点で 1.5 秒の大きな音
  const pcm = synth([
    [40, 0.03],
    [1.5, 0.6],
    [40, 0.03],
  ])
  const env = computeEnvelope(pcm)

  it('ピークの前 8 秒・後 4 秒がハイライト、残りが削除候補', () => {
    const c = highlightCandidates(env, [], 81.5)
    const h = c.filter((x) => x.kind === 'highlight')
    expect(h).toHaveLength(1)
    expect(h[0]!.sourceStart).toBeGreaterThan(30)
    expect(h[0]!.sourceStart).toBeLessThan(34)
    expect(h[0]!.sourceEnd).toBeGreaterThan(43)
    expect(h[0]!.sourceEnd).toBeLessThan(46.5)
    const low = c.filter((x) => x.kind === 'lowActivity')
    expect(low).toHaveLength(2)
    expect(low[0]!.sourceStart).toBe(0)
  })

  it('目標の長さを指定すると合計がその長さ ±10%', () => {
    const regions = [
      { start: 0, end: 12, score: 0.5 },
      { start: 20, end: 32, score: 0.9 },
      { start: 50, end: 62, score: 0.7 },
    ]
    const picked = pickToLength(regions, 30)
    const sum = picked.reduce((s, r) => s + r.end - r.start, 0)
    expect(Math.abs(sum - 30)).toBeLessThanOrEqual(3)
    expect(picked.map((r) => r.start)).toContain(20)
  })
})
