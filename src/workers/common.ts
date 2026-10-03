/**
 * Worker 共通の型（設計書 12.6）。
 */
export type Progress = (ratio: number, label?: string) => void

export class CancelledError extends Error {
  constructor() {
    super('キャンセルしました')
    this.name = 'CancelledError'
  }
}

/** Comlink 越しのエラーは name が失われることがあるので、メッセージでも判定する */
export const isCancelled = (e: unknown): boolean =>
  e instanceof CancelledError ||
  (e instanceof Error && (e.name === 'CancelledError' || e.message === 'キャンセルしました'))
