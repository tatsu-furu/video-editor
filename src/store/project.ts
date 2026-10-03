/**
 * プロジェクトのストア（設計書 3章「状態管理」・5章 Undo/Redo・12.2 自動保存）。
 *
 * 編集は core/project/ops.ts のレシピを produceWithPatches で実行し、パッチを履歴に積む。
 * 履歴は最大 200 件。字幕テキストの連続入力は 1 秒以内なら 1 件にまとめる。
 */
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import { create } from 'zustand'
import type { Recipe } from '../core/project/ops'
import type { Project } from '../core/project/types'
import { saveProject } from '../storage/db'

enablePatches()

export const HISTORY_LIMIT = 200
const COALESCE_MS = 1000
const SAVE_DEBOUNCE_MS = 1000

interface Entry {
  patches: Patch[]
  inverse: Patch[]
  key?: string
  at: number
}

export type SaveState = 'saved' | 'saving' | 'error' | 'idle'

interface State {
  project: Project | null
  past: Entry[]
  future: Entry[]
  saveState: SaveState
  saveError: string | null
}

export const useProject = create<State>(() => ({
  project: null,
  past: [],
  future: [],
  saveState: 'idle',
  saveError: null,
}))

/** プロジェクトを開く（履歴は空にする） */
export function openProject(p: Project | null): void {
  useProject.setState({
    project: p,
    past: [],
    future: [],
    saveState: p ? 'saved' : 'idle',
    saveError: null,
  })
}

/**
 * 編集を実行する。coalesceKey が同じで 1 秒以内の連続操作は、履歴を 1 件にまとめる。
 * record=false なら履歴に残さない（解析結果の反映など）。
 */
export function edit<A extends unknown[]>(recipe: Recipe<A>, ...args: A): void {
  run(recipe, args, {})
}

export function editCoalesced<A extends unknown[]>(
  key: string,
  recipe: Recipe<A>,
  ...args: A
): void {
  run(recipe, args, { key })
}

export function editSilently<A extends unknown[]>(recipe: Recipe<A>, ...args: A): void {
  run(recipe, args, { record: false })
}

function run<A extends unknown[]>(
  recipe: Recipe<A>,
  args: A,
  opts: { key?: string; record?: boolean },
) {
  const { project, past } = useProject.getState()
  if (!project) return
  const [next, patches, inverse] = produceWithPatches(project, (d) => {
    recipe(d, ...args)
  })
  if (patches.length === 0) return
  if (opts.record === false) {
    useProject.setState({ project: next })
    return
  }
  const now = Date.now()
  const last = past[past.length - 1]
  let nextPast: Entry[]
  if (opts.key && last && last.key === opts.key && now - last.at < COALESCE_MS) {
    // まとめる：新しいパッチは後ろに、逆パッチは前に足す
    nextPast = [
      ...past.slice(0, -1),
      {
        patches: [...last.patches, ...patches],
        inverse: [...inverse, ...last.inverse],
        key: opts.key,
        at: now,
      },
    ]
  } else {
    nextPast = [...past, { patches, inverse, key: opts.key, at: now }].slice(-HISTORY_LIMIT)
  }
  useProject.setState({ project: next, past: nextPast, future: [] })
}

export function undo(): void {
  const { project, past, future } = useProject.getState()
  const e = past[past.length - 1]
  if (!project || !e) return
  useProject.setState({
    project: applyPatches(project, e.inverse),
    past: past.slice(0, -1),
    future: [{ ...e, key: undefined }, ...future],
  })
}

export function redo(): void {
  const { project, past, future } = useProject.getState()
  const e = future[0]
  if (!project || !e) return
  useProject.setState({
    project: applyPatches(project, e.patches),
    past: [...past, e],
    future: future.slice(1),
  })
}

/* ---------- ドラッグ操作（途中経過は履歴に残さず、離したときに1件だけ残す） ---------- */

let gestureBase: Project | null = null

export function beginGesture(): void {
  gestureBase = useProject.getState().project
}

/** ドラッグ中のプレビュー：開始時点の状態にレシピを当てて表示する（履歴には残さない） */
export function previewGesture<A extends unknown[]>(recipe: Recipe<A>, ...args: A): void {
  if (!gestureBase) return
  const [next] = produceWithPatches(gestureBase, (d) => {
    recipe(d, ...args)
  })
  useProject.setState({ project: next })
}

/** ドラッグ終了：開始時点に戻してから、最終結果を1回の編集として実行する */
export function endGesture<A extends unknown[]>(recipe: Recipe<A> | null, ...args: A): void {
  const base = gestureBase
  gestureBase = null
  if (!base) return
  useProject.setState({ project: base })
  if (recipe) edit(recipe, ...args)
}

/* ---------- 自動保存（1 秒デバウンス） ---------- */

let timer: ReturnType<typeof setTimeout> | null = null
let lastSaved: Project | null = null

async function flush() {
  timer = null
  const p = useProject.getState().project
  if (!p || p === lastSaved) return
  useProject.setState({ saveState: 'saving' })
  try {
    await saveProject(p)
    lastSaved = p
    if (useProject.getState().project === p)
      useProject.setState({ saveState: 'saved', saveError: null })
  } catch (e) {
    useProject.setState({
      saveState: 'error',
      saveError: e instanceof Error ? e.message : String(e),
    })
  }
}

/** 保存待ちがあれば今すぐ保存する */
export async function saveNow(): Promise<void> {
  if (timer) clearTimeout(timer)
  await flush()
}

useProject.subscribe((s, prev) => {
  if (!s.project || s.project === prev.project) return
  if (prev.project?.id !== s.project.id) {
    // 開いた直後は保存しない
    lastSaved = s.project
    return
  }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
})
