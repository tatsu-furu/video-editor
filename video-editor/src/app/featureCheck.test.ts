import { describe, expect, it } from 'vitest'
import { checkFeatures, type FeatureEnv } from './featureCheck'

class Fake {}

const fullEnv: FeatureEnv = {
  crossOriginIsolated: true,
  VideoDecoder: Fake,
  VideoEncoder: Fake,
  AudioDecoder: Fake,
  AudioEncoder: Fake,
  OffscreenCanvas: Fake,
  AudioContext: Fake,
  indexedDB: {},
  showOpenFilePicker: () => undefined,
  showSaveFilePicker: () => undefined,
  navigator: { gpu: {}, storage: { getDirectory: () => undefined } },
}

describe('checkFeatures', () => {
  it('すべて揃っていれば編集でき、不足はない', () => {
    const report = checkFeatures(fullEnv)
    expect(report.canEdit).toBe(true)
    expect(report.missingRequired).toEqual([])
    expect(report.missingRecommended).toEqual([])
  })

  it('WebCodecsが一部でも欠けていれば編集できない', () => {
    const report = checkFeatures({ ...fullEnv, AudioEncoder: undefined })
    expect(report.canEdit).toBe(false)
    expect(report.missingRequired.map((r) => r.id)).toEqual(['webCodecs'])
  })

  it('推奨機能だけが欠けていても編集はできる', () => {
    const report = checkFeatures({
      ...fullEnv,
      crossOriginIsolated: false,
      showOpenFilePicker: undefined,
      navigator: { storage: { getDirectory: () => undefined } },
    })
    expect(report.canEdit).toBe(true)
    expect(report.missingRecommended.map((r) => r.id).sort()).toEqual([
      'crossOriginIsolated',
      'fileSystemAccess',
      'webGpu',
    ])
  })

  it('空の環境では必須機能がすべて不足になる', () => {
    const report = checkFeatures({})
    expect(report.canEdit).toBe(false)
    expect(report.missingRequired).toHaveLength(5)
  })
})
