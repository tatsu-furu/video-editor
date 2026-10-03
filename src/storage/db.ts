/**
 * IndexedDB：プロジェクト JSON とファイルハンドル（設計書 12.2）。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Project } from '../core/project/types'

interface Schema extends DBSchema {
  projects: { key: string; value: Project; indexes: { updatedAt: string } }
  handles: { key: string; value: FileSystemFileHandle }
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null

function db(): Promise<IDBPDatabase<Schema>> {
  dbp ??= openDB<Schema>('video-editor', 1, {
    upgrade(d) {
      const s = d.createObjectStore('projects', { keyPath: 'id' })
      s.createIndex('updatedAt', 'updatedAt')
      d.createObjectStore('handles')
    },
  })
  return dbp
}

export async function saveProject(p: Project): Promise<void> {
  await (await db()).put('projects', p)
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id)
}

export async function listProjects(): Promise<Project[]> {
  const all = await (await db()).getAll('projects')
  return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function deleteProject(id: string): Promise<void> {
  const d = await db()
  const p = await d.get('projects', id)
  await d.delete('projects', id)
  for (const a of Object.values(p?.assets ?? {}))
    if (a.handleKey) await d.delete('handles', a.handleKey)
}

export async function saveHandle(key: string, h: FileSystemFileHandle): Promise<void> {
  await (await db()).put('handles', h, key)
}

export async function loadHandle(key: string): Promise<FileSystemFileHandle | undefined> {
  return (await db()).get('handles', key)
}
