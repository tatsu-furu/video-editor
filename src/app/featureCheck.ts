/**
 * 起動時の機能チェック（設計書 3章「対象ブラウザ」・12.3「エラー処理」）。
 *
 * ブラウザのグローバルを直接触らず、必要なものだけを持つ `FeatureEnv` を受け取る
 * 純粋関数にしてある。テストでは偽の環境を渡す。
 */

export type FeatureId =
  | 'crossOriginIsolated'
  | 'webCodecs'
  | 'webGpu'
  | 'opfs'
  | 'fileSystemAccess'
  | 'offscreenCanvas'
  | 'webAudio'
  | 'indexedDb'

/** required: 無いと編集そのものができない / recommended: 無くても動くが遅い・不便になる */
export type FeatureLevel = 'required' | 'recommended'

export interface FeatureResult {
  id: FeatureId
  level: FeatureLevel
  available: boolean
  /** ユーザーに見せる機能名 */
  label: string
  /** その機能で何ができるか（使えない場合に何が困るか） */
  purpose: string
}

export interface FeatureReport {
  results: FeatureResult[]
  /** 必須機能がすべて揃っているか */
  canEdit: boolean
  missingRequired: FeatureResult[]
  missingRecommended: FeatureResult[]
}

/** チェックに必要なグローバルだけを抜き出した型。実ブラウザでは globalThis を渡す。 */
export interface FeatureEnv {
  crossOriginIsolated?: boolean
  VideoDecoder?: unknown
  VideoEncoder?: unknown
  AudioDecoder?: unknown
  AudioEncoder?: unknown
  OffscreenCanvas?: unknown
  AudioContext?: unknown
  indexedDB?: unknown
  showOpenFilePicker?: unknown
  showSaveFilePicker?: unknown
  navigator?: {
    gpu?: unknown
    storage?: { getDirectory?: unknown }
  }
}

const isFn = (v: unknown): boolean => typeof v === 'function'

export function checkFeatures(env: FeatureEnv): FeatureReport {
  const results: FeatureResult[] = [
    {
      id: 'webCodecs',
      level: 'required',
      available:
        isFn(env.VideoDecoder) &&
        isFn(env.VideoEncoder) &&
        isFn(env.AudioDecoder) &&
        isFn(env.AudioEncoder),
      label: 'WebCodecs',
      purpose: '動画と音声の読み込み・書き出し',
    },
    {
      id: 'opfs',
      level: 'required',
      available: isFn(env.navigator?.storage?.getDirectory),
      label: 'ブラウザ内ストレージ（OPFS）',
      purpose: '解析結果や文字起こしの保存',
    },
    {
      id: 'offscreenCanvas',
      level: 'required',
      available: isFn(env.OffscreenCanvas),
      label: 'OffscreenCanvas',
      purpose: '字幕を重ねた映像の書き出し',
    },
    {
      id: 'webAudio',
      level: 'required',
      available: isFn(env.AudioContext),
      label: 'Web Audio',
      purpose: 'プレビューでの音声ミックスとBGMの音量調整',
    },
    {
      id: 'indexedDb',
      level: 'required',
      available: env.indexedDB != null,
      label: 'IndexedDB',
      purpose: 'プロジェクトの自動保存',
    },
    {
      id: 'webGpu',
      level: 'recommended',
      available: env.navigator?.gpu != null,
      label: 'WebGPU',
      purpose: '文字起こしの高速化（無い場合はかなり遅くなります）',
    },
    {
      id: 'fileSystemAccess',
      level: 'recommended',
      available: isFn(env.showOpenFilePicker) && isFn(env.showSaveFilePicker),
      label: 'ファイルの直接読み書き',
      purpose: 'プロジェクトを開き直したときの素材の再読み込みと、大きな動画の書き出し',
    },
    {
      id: 'crossOriginIsolated',
      level: 'recommended',
      available: env.crossOriginIsolated === true,
      label: 'クロスオリジン分離',
      purpose: '音声解析のマルチスレッド処理（無い場合はシングルスレッドで動きます）',
    },
  ]

  const missingRequired = results.filter((r) => r.level === 'required' && !r.available)
  const missingRecommended = results.filter((r) => r.level === 'recommended' && !r.available)

  return {
    results,
    canEdit: missingRequired.length === 0,
    missingRequired,
    missingRecommended,
  }
}
