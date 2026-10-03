/**
 * OPFS：解析キャッシュと 16kHz PCM（設計書 5章「解析キャッシュ」・12.5）。
 *
 * cache/<キー>/ の下に envelope.f32・vad.json・blocks.f32・pcm16k.i16・transcript-<モデル>.json を置く。
 * 大きな PCM は Worker 内で FileSystemSyncAccessHandle を使ってチャンク単位で読み書きする。
 */
import type { Asset } from '../core/project/types'

export const cacheKey = (a: Pick<Asset, 'fingerprint'>, track: number): string =>
  `${a.fingerprint.headHash.slice(0, 32)}-${a.fingerprint.size}-t${track}`

async function root(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

export async function cacheDir(
  key: string,
  create = true,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const cache = await (await root()).getDirectoryHandle('cache', { create })
    return await cache.getDirectoryHandle(key, { create })
  } catch {
    return null
  }
}

export async function readBytes(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<ArrayBuffer | null> {
  try {
    const f = await (await dir.getFileHandle(name)).getFile()
    return await f.arrayBuffer()
  } catch {
    return null
  }
}

export async function writeBytes(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | ArrayBufferView | string,
): Promise<void> {
  const h = await dir.getFileHandle(name, { create: true })
  const w = await h.createWritable()
  try {
    await w.write(data as FileSystemWriteChunkType)
    await w.close()
  } catch (e) {
    await w.abort().catch(() => {})
    throw e
  }
}

export async function readJson<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  const b = await readBytes(dir, name)
  if (!b) return null
  try {
    return JSON.parse(new TextDecoder().decode(b)) as T
  } catch {
    return null
  }
}

export async function removeEntry(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  await dir.removeEntry(name, { recursive: true }).catch(() => {})
}

/** キャッシュ全体の使用量（バイト） */
export async function cacheUsage(): Promise<number> {
  let total = 0
  try {
    const cache = await (await root()).getDirectoryHandle('cache')
    for await (const dir of (
      cache as unknown as { values(): AsyncIterable<FileSystemHandle> }
    ).values()) {
      if (dir.kind !== 'directory') continue
      for await (const f of (
        dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
      ).values())
        if (f.kind === 'file') total += (await (f as FileSystemFileHandle).getFile()).size
    }
  } catch {
    /* キャッシュがまだ無い */
  }
  return total
}

export async function clearCache(): Promise<void> {
  await (await root()).removeEntry('cache', { recursive: true }).catch(() => {})
}

/** 書き出し用の作業ファイル（OPFS 直下 tmp/） */
export async function tmpDir(): Promise<FileSystemDirectoryHandle> {
  return (await root()).getDirectoryHandle('tmp', { create: true })
}

export async function clearTmp(): Promise<void> {
  await (await root()).removeEntry('tmp', { recursive: true }).catch(() => {})
}
