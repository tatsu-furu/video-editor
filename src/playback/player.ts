/**
 * プレビュー再生（設計書 6.2・9.2）。
 *
 * - video 要素を2つ使い、片方で現在のクリップを再生、もう片方は次のクリップの頭に事前シークして待たせる。
 * - 映像は Canvas に描き、その上に書き出しと同じ関数で字幕を重ねる。
 * - 音声は video 要素を Web Audio に通してクリップごとのゲインを掛け、BGM は AudioBuffer で別系統に流す。
 *   ダッキングのカーブは BGM の GainNode にスケジュールする。
 */
import { dbToGain, evalCurve, fadeGain, type GainPoint } from '../core/audio/ducking'
import type { BgmClip, Id, Project, Sec } from '../core/project/types'
import type { TimelineCue } from '../core/subtitles/split'
import { placeClips, timelineToSource, totalDuration, type PlacedClip } from '../core/time/time'
import { fitRect } from '../render/letterbox'
import { renderSubtitles } from '../render/subtitles'

export interface PlayerInput {
  project: Project
  urls: Record<Id, string>
  cues: TimelineCue[]
  duck: GainPoint[]
  voiceDb: number
  bgmDb: Record<Id, number>
  bgmBuffers: Record<Id, AudioBuffer>
  /** プレビューの縮小率（1 か 0.5） */
  scale: number
}

export interface PlayerEvents {
  onTime(t: Sec): void
  onEnded(): void
  /** フレーム落ちが続いた（自動解像度用） */
  onDropping(): void
}

interface Deck {
  el: HTMLVideoElement
  src: MediaElementAudioSourceNode | null
  gain: GainNode | null
  assetId: Id | null
}

export class Player {
  private readonly canvas: HTMLCanvasElement
  private readonly c2d: CanvasRenderingContext2D
  private readonly decks: [Deck, Deck]
  private active = 0
  private input: PlayerInput | null = null
  private placed: PlacedClip[] = []
  private clipIdx = -1
  private t: Sec = 0
  private rate = 1
  private playing = false
  private raf = 0
  private ctx: AudioContext | null = null
  private voiceBus: GainNode | null = null
  private bgmBus: GainNode | null = null
  private bgmNodes: { src: AudioBufferSourceNode; gains: GainNode[] }[] = []
  private reverseLast = 0
  private dropped = 0
  private dropStreak = 0
  private lastQualityCheck = 0
  private readonly ev: PlayerEvents

  constructor(canvas: HTMLCanvasElement, ev: PlayerEvents) {
    this.canvas = canvas
    this.c2d = canvas.getContext('2d', { alpha: false })!
    this.ev = ev
    const mk = (): Deck => {
      const el = document.createElement('video')
      el.preload = 'auto'
      el.playsInline = true
      el.addEventListener('seeked', () => {
        if (!this.playing) this.draw()
      })
      el.addEventListener('loadeddata', () => {
        if (!this.playing) this.draw()
      })
      return { el, src: null, gain: null, assetId: null }
    }
    this.decks = [mk(), mk()]
  }

  private deck(i: number): Deck {
    return this.decks[i === 0 ? 0 : 1]
  }

  get time(): Sec {
    return this.t
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /** プロジェクトや設定が変わったら呼ぶ */
  update(input: PlayerInput): void {
    const prev = this.input
    this.input = input
    this.placed = placeClips(input.project.videoTrack)
    const { width, height } = input.project.output
    const w = Math.max(2, Math.round(width * input.scale))
    const h = Math.max(2, Math.round(height * input.scale))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    this.applyGains()
    if (
      this.playing &&
      prev &&
      (prev.duck !== input.duck ||
        prev.project.bgmTrack !== input.project.bgmTrack ||
        prev.bgmBuffers !== input.bgmBuffers)
    )
      this.startBgm()
    if (this.playing && prev && prev.project.videoTrack !== input.project.videoTrack) {
      // タイムラインが変わったら今の位置で入り直す
      this.seek(Math.min(this.t, totalDuration(input.project.videoTrack)))
      return
    }
    if (!this.playing) {
      if (!prev || prev.project.videoTrack !== input.project.videoTrack || prev.urls !== input.urls)
        this.seek(this.t)
      else this.draw()
    }
  }

  private ensureAudio() {
    if (this.ctx) return
    const ctx = new AudioContext({ latencyHint: 'playback' })
    const master = ctx.createGain()
    // 簡易リミッター（設計書 9.3：プレビューは DynamicsCompressorNode でよい）
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -1
    comp.knee.value = 0
    comp.ratio.value = 20
    comp.attack.value = 0.003
    comp.release.value = 0.1
    master.connect(comp).connect(ctx.destination)
    this.voiceBus = ctx.createGain()
    this.bgmBus = ctx.createGain()
    this.voiceBus.connect(master)
    this.bgmBus.connect(master)
    for (const d of this.decks) {
      d.src = ctx.createMediaElementSource(d.el)
      d.gain = ctx.createGain()
      d.src.connect(d.gain).connect(this.voiceBus)
    }
    this.ctx = ctx
    this.applyGains()
  }

  private applyGains() {
    if (!this.ctx || !this.input) return
    this.voiceBus!.gain.value = dbToGain(this.input.voiceDb)
    for (const d of this.decks) {
      const clip = this.placed[this.clipIdx]?.clip
      if (d === this.deck(this.active) && clip)
        d.gain!.gain.value = clip.muted || this.rate < 0 ? 0 : dbToGain(clip.gainDb)
    }
  }

  /* ---------- 位置と再生 ---------- */

  seek(t: Sec): void {
    if (!this.input) return
    const total = totalDuration(this.input.project.videoTrack)
    this.t = Math.max(0, Math.min(t, total))
    const hit = timelineToSource(this.input.project, this.t)
    if (!hit) {
      this.clipIdx = -1
      this.draw()
      this.ev.onTime(this.t)
      return
    }
    this.clipIdx = hit.index
    const deck = this.deck(this.active)
    this.load(deck, hit.assetId)
    deck.el.currentTime = hit.sourceTime
    if (this.playing && this.rate > 0) {
      void deck.el.play().catch(() => {})
      this.preloadNext()
      this.startBgm()
    }
    this.applyGains()
    this.ev.onTime(this.t)
  }

  private load(deck: Deck, assetId: Id) {
    const url = this.input?.urls[assetId]
    if (deck.assetId === assetId && deck.el.src === url) return
    deck.assetId = assetId
    if (url) deck.el.src = url
    else deck.el.removeAttribute('src')
  }

  private preloadNext() {
    const next = this.placed[this.clipIdx + 1]
    if (!next) return
    const deck = this.deck(1 - this.active)
    deck.el.pause()
    this.load(deck, next.clip.assetId)
    deck.el.currentTime = next.clip.sourceIn
  }

  play(rate = 1): void {
    if (!this.input || this.placed.length === 0) return
    this.ensureAudio()
    void this.ctx!.resume()
    if (this.t >= totalDuration(this.input.project.videoTrack) - 0.01 && rate > 0) this.t = 0
    this.rate = rate
    this.playing = true
    this.dropStreak = 0
    const deck = this.deck(this.active)
    deck.el.playbackRate = Math.max(0.25, Math.abs(rate))
    this.seek(this.t)
    if (rate > 0) void deck.el.play().catch(() => {})
    else deck.el.pause()
    this.reverseLast = performance.now()
    this.loop()
  }

  pause(): void {
    this.playing = false
    cancelAnimationFrame(this.raf)
    for (const d of this.decks) d.el.pause()
    this.stopBgm()
    this.draw()
  }

  /** フレーム送り（n は ±フレーム数） */
  step(frames: number): void {
    if (!this.input) return
    if (this.playing) this.pause()
    this.seek(this.t + frames / this.input.project.output.fps)
  }

  private loop = () => {
    if (!this.playing || !this.input) return
    const deck = this.deck(this.active)
    const p = this.placed[this.clipIdx]
    if (this.rate < 0) {
      // 逆再生：video 要素は負の再生速度に対応しないので、シークで戻る
      const now = performance.now()
      const dt = (now - this.reverseLast) / 1000
      this.reverseLast = now
      const nt = this.t + dt * this.rate
      if (nt <= 0) {
        this.seek(0)
        this.pause()
        this.ev.onEnded()
        return
      }
      this.seek(nt)
    } else if (p) {
      const end = p.clip.sourceOut
      if (deck.el.currentTime >= end - 0.02 || deck.el.ended) {
        // 次のクリップへ切り替え
        const next = this.placed[this.clipIdx + 1]
        if (!next) {
          this.t = p.end
          this.pause()
          this.ev.onTime(this.t)
          this.ev.onEnded()
          return
        }
        deck.el.pause()
        this.active = 1 - this.active
        this.clipIdx++
        const nd = this.deck(this.active)
        this.load(nd, next.clip.assetId)
        if (Math.abs(nd.el.currentTime - next.clip.sourceIn) > 0.05)
          nd.el.currentTime = next.clip.sourceIn
        nd.el.playbackRate = Math.max(0.25, this.rate)
        void nd.el.play().catch(() => {})
        this.applyGains()
        this.preloadNext()
        this.t = next.start
      } else {
        this.t = p.start + Math.max(0, deck.el.currentTime - p.clip.sourceIn)
      }
      this.checkQuality(deck.el)
    }
    this.draw()
    this.ev.onTime(this.t)
    this.raf = requestAnimationFrame(this.loop)
  }

  /** フレーム落ちの検知（設計書 6.2：連続したら 1/2 に下げる） */
  private checkQuality(el: HTMLVideoElement) {
    const now = performance.now()
    if (now - this.lastQualityCheck < 1000) return
    this.lastQualityCheck = now
    const q = el.getVideoPlaybackQuality?.()
    if (!q) return
    const d = q.droppedVideoFrames - this.dropped
    this.dropped = q.droppedVideoFrames
    this.dropStreak = d >= 5 ? this.dropStreak + 1 : 0
    if (this.dropStreak >= 2) {
      this.dropStreak = 0
      this.ev.onDropping()
    }
  }

  /* ---------- 描画 ---------- */

  draw(): void {
    const c = this.c2d
    const W = this.canvas.width
    const H = this.canvas.height
    c.fillStyle = '#000'
    c.fillRect(0, 0, W, H)
    if (!this.input) return
    const deck = this.deck(this.active)
    const el = deck.el
    if (this.clipIdx >= 0 && el.readyState >= 2 && el.videoWidth > 0) {
      const r = fitRect(el.videoWidth, el.videoHeight, W, H)
      c.drawImage(el, r.x, r.y, r.w, r.h)
    } else if (
      this.clipIdx >= 0 &&
      !this.input.urls[this.placed[this.clipIdx]?.clip.assetId ?? '']
    ) {
      c.fillStyle = '#888'
      c.font = `${Math.round(H * 0.04)}px sans-serif`
      c.textAlign = 'center'
      c.fillText('素材が見つかりません', W / 2, H / 2)
    }
    renderSubtitles(c, this.input.cues, this.t, this.input.project.subtitleStyle, W, H)
  }

  /* ---------- BGM ---------- */

  private stopBgm() {
    for (const n of this.bgmNodes) {
      try {
        n.src.stop()
      } catch {
        /* まだ始まっていない */
      }
      n.src.disconnect()
      for (const g of n.gains) g.disconnect()
    }
    this.bgmNodes = []
  }

  /** 現在位置から BGM を流し直し、フェードとダッキングをスケジュールする */
  private startBgm() {
    this.stopBgm()
    if (!this.ctx || !this.input || this.rate <= 0) return
    const ctx = this.ctx
    const now = ctx.currentTime + 0.03
    const rate = this.rate
    for (const clip of this.input.project.bgmTrack as BgmClip[]) {
      const buf = this.input.bgmBuffers[clip.assetId]
      if (!buf || this.t >= clip.timelineEnd) continue
      const startT = Math.max(this.t, clip.timelineStart)
      const when = now + (startT - this.t) / rate
      const offset0 = clip.sourceOffset + (startT - clip.timelineStart)
      if (!clip.loop && offset0 >= buf.duration) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.loop = clip.loop
      src.playbackRate.value = rate
      const base = ctx.createGain()
      base.gain.value = dbToGain(this.input.bgmDb[clip.assetId] ?? 0)
      const env = ctx.createGain()
      // フェードとダッキングを合わせたカーブを 50ms 刻みでスケジュールする
      const end = clip.timelineEnd
      env.gain.setValueAtTime(this.bgmEnvelope(clip, startT), when)
      const points = new Set<number>()
      for (const p of this.input.duck) if (p.t > startT && p.t < end) points.add(p.t)
      for (const x of [clip.timelineStart + clip.fadeIn, end - clip.fadeOut, end])
        if (x > startT && x <= end) points.add(x)
      for (let x = startT; x < Math.min(end, startT + clip.fadeIn); x += 0.1) points.add(x)
      for (let x = Math.max(startT, end - clip.fadeOut); x < end; x += 0.1) points.add(x)
      for (const x of [...points].sort((a, b) => a - b))
        env.gain.linearRampToValueAtTime(this.bgmEnvelope(clip, x), now + (x - this.t) / rate)
      src.connect(env).connect(base).connect(this.bgmBus!)
      const offset = clip.loop ? offset0 % buf.duration : offset0
      src.start(when, offset)
      src.stop(now + (end - this.t) / rate)
      this.bgmNodes.push({ src, gains: [env, base] })
    }
  }

  private bgmEnvelope(clip: BgmClip, t: Sec): number {
    return fadeGain(clip, t) * dbToGain(evalCurve(this.input?.duck ?? [], t))
  }

  /** BGM の基準ゲインだけを即座に変える（スライダー操作） */
  setBgmGains(bgmDb: Record<Id, number>): void {
    if (!this.input) return
    this.input = { ...this.input, bgmDb }
    const clips = this.input.project.bgmTrack
    this.bgmNodes.forEach((n, i) => {
      const c = clips[i]
      if (c)
        n.gains[1]!.gain.setTargetAtTime(
          dbToGain(bgmDb[c.assetId] ?? 0),
          this.ctx!.currentTime,
          0.02,
        )
    })
  }

  destroy(): void {
    this.pause()
    for (const d of this.decks) {
      d.el.removeAttribute('src')
      d.el.load()
    }
    void this.ctx?.close()
    this.ctx = null
  }
}
