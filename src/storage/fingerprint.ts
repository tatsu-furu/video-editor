/**
 * 素材の同一性の確認（設計書 5章 fingerprint・12.2）。先頭 1MB の SHA-256 を使う。
 */
import type { Asset } from '../core/project/types'

export async function headHash(file: Blob): Promise<string> {
  const head = await file.slice(0, 1024 * 1024).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', head)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fingerprintOf(file: File, hash: string): Asset['fingerprint'] {
  return { name: file.name, size: file.size, lastModified: file.lastModified, headHash: hash }
}

/** 選び直したファイルが同じ素材か */
export async function matchesAsset(
  file: File,
  asset: Pick<Asset, 'fingerprint'>,
): Promise<boolean> {
  if (file.size !== asset.fingerprint.size) return false
  return (await headHash(file)) === asset.fingerprint.headHash
}
