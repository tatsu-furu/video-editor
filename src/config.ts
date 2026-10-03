/**
 * 設定値（設計書 3章「ホスティング要件」）。
 * 音声認識・VAD のモデルの取得元。自前ドメインに置く場合はここを書き換える。
 */
export const MODEL_HOST = 'https://huggingface.co'

/** Silero VAD（ONNX） */
export const SILERO_VAD_URL = `${MODEL_HOST}/onnx-community/silero-vad/resolve/main/onnx/model.onnx`

/** 文字起こしのモデル（設計書 8.1）。sizeMb はダウンロードの目安 */
export const ASR_MODELS = {
  fast: { id: 'onnx-community/whisper-base', label: '高速（base）', sizeMb: 80, needsGpu: false },
  standard: {
    id: 'onnx-community/whisper-small',
    label: '標準（small）',
    sizeMb: 250,
    needsGpu: false,
  },
  accurate: {
    id: 'onnx-community/whisper-large-v3-turbo',
    label: '高精度（large-v3-turbo）',
    sizeMb: 600,
    needsGpu: true,
  },
} as const

export type AsrModelKey = keyof typeof ASR_MODELS
