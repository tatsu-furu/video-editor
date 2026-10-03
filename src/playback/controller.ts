/**
 * 画面とプレビュー再生の橋渡し。Player は1つだけ作り、ここから操作する。
 */
import type { Sec } from '../core/project/types'
import { totalDuration } from '../core/time/time'
import { useProject } from '../store/project'
import { useSession } from '../store/session'
import { Player } from './player'

let player: Player | null = null
let rate = 0
let lastTimeUpdate = 0

export function mountPlayer(canvas: HTMLCanvasElement): Player {
  player?.destroy()
  player = new Player(canvas, {
    onTime(t) {
      // 再描画の負荷を抑えるため、再生中は 30fps 程度に間引いて画面へ伝える
      const now = performance.now()
      if (!player?.isPlaying || now - lastTimeUpdate > 33) {
        lastTimeUpdate = now
        useSession.setState({ playhead: t })
      }
    },
    onEnded() {
      rate = 0
      useSession.setState({ playing: false, playhead: player?.time ?? 0 })
    },
    onDropping() {
      const s = useSession.getState()
      if (s.previewRes === 'auto' && !s.previewReduced)
        useSession.setState({ previewReduced: true })
    },
  })
  return player
}

export function unmountPlayer(): void {
  player?.destroy()
  player = null
}

export const getPlayer = (): Player | null => player

export function seek(t: Sec): void {
  const p = useProject.getState().project
  const total = p ? totalDuration(p.videoTrack) : 0
  const clamped = Math.max(0, Math.min(t, total))
  useSession.setState({ playhead: clamped })
  player?.seek(clamped)
}

export function play(r = 1): void {
  if (useSession.getState().job?.kind === 'export') return
  rate = r
  player?.play(r)
  useSession.setState({ playing: true })
}

export function pause(): void {
  rate = 0
  player?.pause()
  // 止めたら解像度を元に戻す（設計書 6.2）
  useSession.setState({
    playing: false,
    previewReduced: false,
    playhead: player?.time ?? useSession.getState().playhead,
  })
}

export function togglePlay(): void {
  if (useSession.getState().playing) pause()
  else play(1)
}

/** J / L：押すたびに倍速（1→2→4） */
export function shuttle(dir: 1 | -1): void {
  const next = Math.sign(rate) === dir ? Math.min(4, Math.abs(rate) * 2) * dir : dir
  play(next)
}

export function stepFrames(n: number): void {
  if (useSession.getState().playing) pause()
  player?.step(n)
  useSession.setState({ playhead: player?.time ?? 0 })
}
