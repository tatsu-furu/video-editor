/**
 * プロジェクト一覧（設計書 12.2）と初回体験（11.2：モード選択と大きなドロップ領域）。
 */
import { useEffect, useState } from 'react'
import { isProject } from '../core/project/create'
import type { Project } from '../core/project/types'
import { ja } from '../i18n/ja'
import { importVideos, newProject, openSaved } from '../store/jobs'
import { saveNow, openProject } from '../store/project'
import { resetSession, toast } from '../store/session'
import { deleteProject, listProjects, saveProject } from '../storage/db'
import { droppedFiles, pickFiles } from './panels/files'
import { GuideButton } from './Guide'

export function ProjectList() {
  const [list, setList] = useState<Project[] | null>(null)
  const [mode, setMode] = useState<Project['mode']>('game')
  const [over, setOver] = useState(false)

  const refresh = () => void listProjects().then(setList, () => setList([]))
  useEffect(refresh, [])

  const startWith = async (files: { file: File; handle?: FileSystemFileHandle }[]) => {
    if (!files.length) return
    await newProject(mode)
    await importVideos(files)
  }

  return (
    <main className="home">
      <h1>{ja.appName}</h1>
      <p className="lede">
        動画はどこにもアップロードされません。すべての処理をこのブラウザの中で行います。
      </p>
      <section className="intro">
        <h2>はじめての方へ</h2>
        <ol>
          <li>下で「ゲーム録画」か「トーク動画」を選んで、動画を入れます。</li>
          <li>自動で見つけた「いらなそうな所」を確認して、まとめて削除します。</li>
          <li>必要なら字幕と BGM を入れて、MP4 で書き出します。</li>
        </ol>
        <GuideButton className="primary" />
        <p className="muted small">
          最新版の Google Chrome か Microsoft Edge（パソコン版）で使ってください。
        </p>
      </section>

      <section className="start">
        <h2>{ja.list.create}</h2>
        <div className="modes">
          {(['game', 'talk'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`mode-card${mode === m ? ' is-on' : ''}`}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
            >
              <b>{ja.modes[m].label}</b>
              <span>{ja.modes[m].desc}</span>
            </button>
          ))}
        </div>
        <div
          className={`dropzone is-big${over ? ' is-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={async (e) => {
            e.preventDefault()
            setOver(false)
            await startWith(await droppedFiles(e.dataTransfer))
          }}
        >
          <p>{ja.dropHere}</p>
          <p className="muted">{ja.dropOr}</p>
          <button
            type="button"
            className="primary"
            onClick={async () => startWith(await pickFiles('video', true))}
          >
            {ja.addVideo}
          </button>
        </div>
      </section>

      <section className="saved">
        <h2>{ja.list.title}</h2>
        {list?.length === 0 && <p className="muted">{ja.list.empty}</p>}
        <ul className="project-list">
          {list?.map((p) => (
            <li key={p.id}>
              <button type="button" className="link project-open" onClick={() => openSaved(p.id)}>
                {p.name}
              </button>
              <span className="muted small">
                {new Date(p.updatedAt).toLocaleString('ja-JP')}・{ja.modes[p.mode].label}・素材{' '}
                {Object.keys(p.assets).length}
              </span>
              <span className="row">
                <button type="button" className="small" onClick={() => openSaved(p.id)}>
                  {ja.list.open}
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={async () => {
                    const name = prompt('新しい名前', p.name)?.trim()
                    if (!name) return
                    await saveProject({ ...p, name, updatedAt: new Date().toISOString() })
                    refresh()
                  }}
                >
                  {ja.list.rename}
                </button>
                <button
                  type="button"
                  className="small"
                  onClick={async () => {
                    if (!confirm(ja.list.confirmRemove(p.name))) return
                    await deleteProject(p.id)
                    refresh()
                  }}
                >
                  {ja.list.remove}
                </button>
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="small"
          onClick={async () => {
            const input = document.createElement('input')
            input.type = 'file'
            input.accept = 'application/json,.json'
            input.onchange = async () => {
              const f = input.files?.[0]
              if (!f) return
              try {
                const data: unknown = JSON.parse(await f.text())
                if (!isProject(data)) throw new Error('形式が違います')
                // 素材のハンドルは持ち込めないので外し、別のプロジェクトとして保存する
                const p: Project = {
                  ...data,
                  id: crypto.randomUUID(),
                  updatedAt: new Date().toISOString(),
                }
                for (const a of Object.values(p.assets)) delete a.handleKey
                await saveProject(p)
                resetSession()
                openProject(null)
                await saveNow()
                await openSaved(p.id)
              } catch (e) {
                toast(`読み込めませんでした：${e instanceof Error ? e.message : e}`, 'error')
              }
            }
            input.click()
          }}
        >
          {ja.list.import}
        </button>
      </section>
    </main>
  )
}
