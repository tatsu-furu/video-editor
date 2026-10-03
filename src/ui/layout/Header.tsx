/**
 * ヘッダーとステップ表示（設計書 11.1）。
 */
import * as ops from '../../core/project/ops'
import { ja } from '../../i18n/ja'
import { cancelJob } from '../../store/jobs'
import { edit, redo, saveNow, undo, useProject } from '../../store/project'
import { resetSession, useSession, type Step } from '../../store/session'
import { openProject } from '../../store/project'

const STEPS: Step[] = ['import', 'cut', 'subtitles', 'bgm', 'export']

export function Header() {
  const project = useProject((s) => s.project)
  const saveState = useProject((s) => s.saveState)
  const saveError = useProject((s) => s.saveError)
  const canUndo = useProject((s) => s.past.length > 0)
  const canRedo = useProject((s) => s.future.length > 0)
  const analysis = useSession((s) => s.analysis)
  const job = useSession((s) => s.job)
  const step = useSession((s) => s.step)
  if (!project) return null

  const running = Object.entries(analysis).filter(
    ([, a]) => a.status === 'running' || a.status === 'waiting',
  )
  const avg = running.length ? running.reduce((s, [, a]) => s + a.progress, 0) / running.length : 1

  return (
    <header className="app-header">
      <div className="header-row">
        <button
          type="button"
          className="ghost"
          onClick={async () => {
            await saveNow()
            resetSession()
            openProject(null)
          }}
        >
          ← {ja.projects}
        </button>
        <input
          className="project-name"
          aria-label="プロジェクト名"
          defaultValue={project.name}
          key={project.id}
          onBlur={(e) => edit(ops.rename, e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className={`save-state is-${saveState}`} title={saveError ?? undefined}>
          {ja.save[saveState]}
        </span>
        <div className="header-actions">
          <button type="button" onClick={undo} disabled={!canUndo} title="Ctrl+Z">
            ↶ {ja.undo}
          </button>
          <button type="button" onClick={redo} disabled={!canRedo} title="Ctrl+Shift+Z">
            ↷ {ja.redo}
          </button>
          <button type="button" onClick={() => useSession.setState({ helpOpen: true })} title="?">
            ? {ja.help}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => useSession.setState({ step: 'export' })}
          >
            {ja.exportButton}
          </button>
        </div>
      </div>
      {(running.length > 0 || job) && (
        <div className="header-progress">
          {running.length > 0 && (
            <span>
              {ja.analysis.running} {Math.round(avg * 100)}%
              <progress value={avg} max={1} />
            </span>
          )}
          {job && (
            <span>
              {job.label} {Math.round(job.progress * 100)}%
              {job.remain != null && !job.label.includes('残り')
                ? `（残り 約${Math.max(1, Math.ceil(job.remain / 60))}分）`
                : ''}
              <progress value={job.progress} max={1} />
              <button type="button" onClick={cancelJob}>
                {ja.cancel}
              </button>
            </span>
          )}
        </div>
      )}
      <nav className="steps" aria-label="作業の流れ">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            className={s === step ? 'step is-current' : 'step'}
            onClick={() => useSession.setState({ step: s })}
            aria-current={s === step}
          >
            <span className="step-num">{'①②③④⑤'[i]}</span>
            {ja.steps[s]}
          </button>
        ))}
      </nav>
    </header>
  )
}
