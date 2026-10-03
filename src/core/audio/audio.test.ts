import { describe, expect, it } from 'vitest'
import { bgmTaps, duckingCurve, evalCurve, fadeGain, speechOnTimeline } from './ducking'
import { Limiter } from './limiter'
import { LoudnessMeter, integratedLoudness, kWeighting } from './loudness'
import { Resampler, bgmGainDb, remix, voiceGainDb } from './mix'
import { defaultAudioMix } from '../project/create'
import { clip } from '../time/time.test'

const sine = (n: number, amp: number, freq: number, rate: number, offset = 0) =>
  Float32Array.from(
    { length: n },
    (_, i) => amp * Math.sin((2 * Math.PI * freq * (offset + i)) / rate),
  )

describe('loudness', () => {
  it('48kHz の K 特性係数は規格の値と一致する', () => {
    const [shelf, hp] = kWeighting(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 6)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 6)
    expect(hp.a1).toBeCloseTo(-1.99004745483398, 6)
    expect(hp.a2).toBeCloseTo(0.99007225036621, 6)
  })

  it('1kHz・-20dBFS(RMS) のステレオ正弦波は約 -20+3-0.69+0.69 ≒ -17 LUFS', () => {
    const m = new LoudnessMeter(48000)
    const amp = Math.pow(10, -20 / 20) * Math.SQRT2
    for (let b = 0; b < 50; b++) {
      const ch = sine(4800, amp, 1000, 48000, b * 4800)
      m.push([ch, ch])
    }
    expect(m.integrated()).toBeGreaterThan(-17.5)
    expect(m.integrated()).toBeLessThan(-16.5)
    // 一部のブロックだけで測る
    expect(integratedLoudness(m.blocks, (i) => i < 10)).toBeCloseTo(m.integrated(), 0)
    expect(integratedLoudness([])).toBe(-Infinity)
  })

  it('16kHz でも同じくらいの値になる', () => {
    const m = new LoudnessMeter(16000, 1)
    const amp = Math.pow(10, -20 / 20) * Math.SQRT2
    m.push([sine(16000 * 5, amp, 1000, 16000)])
    expect(m.integrated()).toBeGreaterThan(-20.5)
    expect(m.integrated()).toBeLessThan(-19.5)
  })
})

describe('limiter', () => {
  it('上限を超えず、遅延は 5ms', () => {
    const lim = new Limiter(48000, -1)
    expect(lim.latency).toBe(240)
    const input = sine(48000, 1.5, 440, 48000)
    const a = lim.push([input, input])
    const b = lim.flush()
    expect(a[0]!.length + b[0]!.length).toBe(48000)
    const ceiling = Math.pow(10, -1 / 20)
    let peak = 0
    for (const x of [...a[0]!, ...b[0]!]) peak = Math.max(peak, Math.abs(x))
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-6)
    expect(peak).toBeGreaterThan(ceiling * 0.95)
  })

  it('小さい音はそのまま（遅延だけ）', () => {
    const lim = new Limiter(48000, -1)
    const input = sine(1000, 0.2, 440, 48000)
    const out = [...lim.push([input])[0]!, ...lim.flush()[0]!]
    expect(out.length).toBe(1000)
    for (let i = 0; i < 1000; i += 97) expect(out[i]).toBeCloseTo(input[i]!, 5)
  })
})

describe('ducking', () => {
  const ducking = { enabled: true, amountDb: 12, attackMs: 150, holdMs: 300, releaseMs: 500 }

  it('発話区間に追従するカーブ', () => {
    const c = duckingCurve(
      [
        { start: 1, end: 2 },
        { start: 2.6, end: 3 },
        { start: 10, end: 11 },
      ],
      ducking,
    )
    expect(c).toHaveLength(8)
    expect(evalCurve(c, 0.5)).toBe(0)
    expect(evalCurve(c, 0.925)).toBeCloseTo(-6)
    expect(evalCurve(c, 2.3)).toBe(-12)
    expect(evalCurve(c, 3.55)).toBeCloseTo(-6)
    expect(evalCurve(c, 5)).toBe(0)
    expect(duckingCurve([{ start: 1, end: 2 }], { ...ducking, enabled: false })).toEqual([])
  })

  it('発話区間はタイムラインへ変換し、0.5 秒未満の隙間を結合する', () => {
    const track = [clip('a', 'A', 0, 5), clip('b', 'A', 10, 20)]
    const s = speechOnTimeline(
      { videoTrack: track },
      {
        A: [
          { start: 1, end: 4.8 },
          { start: 10.2, end: 12 },
          { start: 6, end: 8 },
        ],
      },
    )
    expect(s).toEqual([{ start: 1, end: 7 }])
  })

  it('BGM のフェードとループのクロスフェード', () => {
    const bgm = {
      id: 'x',
      assetId: 'M',
      timelineStart: 0,
      timelineEnd: 30,
      sourceOffset: 0,
      loop: true,
      fadeIn: 1,
      fadeOut: 2,
    }
    expect(fadeGain(bgm, 0.5)).toBeCloseTo(0.5)
    expect(fadeGain(bgm, 29)).toBeCloseTo(0.5)
    expect(bgmTaps(bgm, 5, 10)).toEqual([{ pos: 5, weight: 1 }])
    const x = bgmTaps(bgm, 9.95 + 0.025, 10)
    expect(x).toHaveLength(2)
    expect(x[0]!.pos).toBeCloseTo(0.025)
    expect(x[0]!.weight).toBeCloseTo(0.5)
    expect(x[1]!.pos).toBeCloseTo(9.975)
    expect(bgmTaps({ ...bgm, loop: false }, 12, 10)).toEqual([])
  })
})

describe('mix', () => {
  it('ゲインの基準', () => {
    const mix = defaultAudioMix('talk')
    expect(voiceGainDb(-20, mix)).toBe(6)
    expect(voiceGainDb(-Infinity, mix)).toBe(0)
    expect(bgmGainDb(-10, mix)).toBe(-24)
    expect(bgmGainDb(-10, { ...mix, preset: 'bgmForward', bgmOffsetDb: 2 })).toBe(-8)
  })

  it('リサンプラーは分割して入れても同じ結果', () => {
    const src = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10))
    const whole = new Resampler(48000, 16000, 1).push([src])[0]!
    const r = new Resampler(48000, 16000, 1)
    const a = r.push([src.subarray(0, 1001)])[0]!
    const b = r.push([src.subarray(1001)])[0]!
    expect(whole.length).toBe(1600)
    expect(a.length + b.length).toBe(1600)
    const joined = [...a, ...b]
    for (let i = 0; i < 1600; i += 37) expect(joined[i]).toBeCloseTo(whole[i]!, 5)
    const up = new Resampler(44100, 48000, 2).push([src, src])
    expect(Math.abs(up[0]!.length - 4800 * (48000 / 44100))).toBeLessThan(2)
    expect(remix([src], 2)).toHaveLength(2)
    expect(remix([src, src], 1)[0]![5]).toBeCloseTo(src[5]!)
  })
})
