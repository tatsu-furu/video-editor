/**
 * 素材ファイルの情報を読む（設計書 5章 Asset）。
 * ヘッダーを読むだけなのでメインスレッドで行ってよい。
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import { newId } from '../core/project/create'
import type { Asset } from '../core/project/types'
import { fingerprintOf, headHash } from '../storage/fingerprint'

export class UnsupportedFileError extends Error {}

export async function probeFile(file: File, kind: 'video' | 'audio'): Promise<Asset> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  try {
    if (!(await input.canRead()))
      throw new UnsupportedFileError(
        `${file.name} は読み込めない形式です。MP4・MOV・MKV・WebM の動画を選んでください。`,
      )
    const video = kind === 'video' ? await input.getPrimaryVideoTrack() : null
    if (kind === 'video' && !video)
      throw new UnsupportedFileError(`${file.name} に映像が入っていません。`)
    if (video && !(await video.canDecode()))
      throw new UnsupportedFileError(
        video.codec === 'avc'
          ? `このブラウザでは ${file.name} の映像（H.264）を扱えません。最新版の Google Chrome か Microsoft Edge（パソコン版）で開いてください。`
          : `${file.name} の映像の形式（${video.codec ?? '不明'}）はこのブラウザで扱えません。OBS の設定で「H.264」の MP4 として録画するか、変換ソフトで H.264 の MP4 に変換してから読み込んでください。`,
      )
    const audios = await input.getAudioTracks()
    if (kind === 'audio' && audios.length === 0)
      throw new UnsupportedFileError(`${file.name} に音声が入っていません。`)
    const duration = await input.computeDuration()
    let fps = 30
    if (video) {
      const stats = await video.computePacketStats(100)
      fps = stats.averagePacketRate || 30
    }
    const audioTracks = await Promise.all(
      audios.map(async (t, index) => ({
        index,
        label: (await t.getName()) || `音声${index + 1}`,
        channels: t.numberOfChannels,
        sampleRate: t.sampleRate,
      })),
    )
    return {
      id: newId(),
      kind,
      name: file.name,
      duration,
      fingerprint: fingerprintOf(file, await headHash(file)),
      video: video
        ? {
            width: video.displayWidth,
            height: video.displayHeight,
            fps,
            codec: video.codec ?? 'unknown',
          }
        : undefined,
      audioTracks,
      // 既定は1本目（OBS では通常すべての音が入っている）。マイク別録りのトラックは画面で選べる
      analysisAudioTrack: 0,
    }
  } finally {
    input.dispose()
  }
}
