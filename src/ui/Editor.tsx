/**
 * 編集画面（設計書 11.1）：ヘッダー・ステップ表示・左パネル・プレビュー・タイムライン。
 */
import { useEffect } from 'react'
import { ja } from '../i18n/ja'
import { useProject } from '../store/project'
import { useSession } from '../store/session'
import { Header } from './layout/Header'
import { BgmPanel } from './panels/BgmPanel'
import { CutPanel } from './panels/CutPanel'
import { ExportPanel } from './panels/ExportPanel'
import { DropZone, ImportPanel } from './panels/ImportPanel'
import { SubtitlesPanel } from './panels/SubtitlesPanel'
import { Preview } from './preview/Preview'
import { handleKey, SHORTCUTS } from './shortcuts'
import { Timeline } from './timeline/Timeline'

export function Editor() {
  const step = useSession((s) => s.step)
  const helpOpen = useSession((s) => s.helpOpen)
  const empty = useProject((s) => (s.project?.videoTrack.length ?? 0) === 0)

  useEffect(() => {
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  return (
    <div className="editor">
      <Header />
      <div className="workspace">
        <aside className="left-panel" aria-label={ja.steps[step]}>
          {step === 'import' && <ImportPanel />}
          {step === 'cut' && <CutPanel />}
          {step === 'subtitles' && <SubtitlesPanel />}
          {step === 'bgm' && <BgmPanel />}
          {step === 'export' && <ExportPanel />}
        </aside>
        <div className="center">{empty ? <DropZone big /> : <Preview />}</div>
      </div>
      {!empty && <Timeline />}
      {helpOpen && (
        <div
          className="modal"
          role="dialog"
          aria-label={ja.help}
          onClick={() => useSession.setState({ helpOpen: false })}
        >
          <div className="modal-body" onClick={(e) => e.stopPropagation()}>
            <h2>{ja.help}</h2>
            <table className="keys">
              <tbody>
                {SHORTCUTS.map(([k, d]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Mac では Ctrl を Cmd
              に読み替えます。文字の入力中は文字キーのショートカットは効きません。
            </p>
            <button type="button" onClick={() => useSession.setState({ helpOpen: false })}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
