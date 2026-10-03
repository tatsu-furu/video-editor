/**
 * 起動と画面切り替え（設計書 4章 app/）：機能チェック → プロジェクト一覧／編集画面。
 */
import { useEffect, useMemo, useState } from 'react'
import { useProject } from '../store/project'
import { toast as showToast, useSession } from '../store/session'
import { Editor } from '../ui/Editor'
import { ProjectList } from '../ui/ProjectList'
import { checkFeatures, type FeatureEnv, type FeatureResult } from './featureCheck'

export default function App() {
  const report = useMemo(() => checkFeatures(globalThis as unknown as FeatureEnv), [])
  const hasProject = useProject((s) => s.project != null)
  const toast = useSession((s) => s.toast)
  const [showFeatures, setShowFeatures] = useState(false)
  const warn = report.missingRequired.length > 0 || report.missingRecommended.length > 0

  // 想定外のエラーも画面に出す（設計書 12.3）
  useEffect(() => {
    const onError = (e: ErrorEvent) => showToast(`エラーが起きました：${e.message}`, 'error')
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: unknown = e.reason
      console.error(r)
      showToast(`エラーが起きました：${r instanceof Error ? r.message : String(r)}`, 'error')
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  return (
    <div className={hasProject ? 'shell is-editor' : 'shell'}>
      {warn && (
        <div
          className={`feature-banner ${report.canEdit ? 'is-limited' : 'is-missing'}`}
          role="status"
        >
          <span>
            {report.canEdit
              ? '一部の機能が使えないため、遅くなる処理があります。'
              : 'このブラウザでは編集に必要な機能が足りません。最新版の Google Chrome か Microsoft Edge（パソコン版）で開いてください。'}
          </span>
          <button type="button" className="link" onClick={() => setShowFeatures(!showFeatures)}>
            {showFeatures ? '閉じる' : '詳しく'}
          </button>
        </div>
      )}
      {showFeatures && <FeatureList results={report.results} />}
      {hasProject ? <Editor /> : <ProjectList />}
      {toast && (
        <div
          className={`toast is-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          onClick={() => useSession.setState({ toast: null })}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

function FeatureList({ results }: { results: FeatureResult[] }) {
  return (
    <section className="features-box" aria-label="機能の対応状況">
      <ul className="features">
        {results.map((r) => (
          <li
            key={r.id}
            className={`feature ${r.available ? 'is-ok' : r.level === 'required' ? 'is-missing' : 'is-limited'}`}
          >
            <div className="feature-text">
              <span className="feature-name">{r.label}</span>
              <span className="feature-purpose">{r.purpose}</span>
            </div>
            <span className="feature-status">
              {r.available
                ? '使えます'
                : r.level === 'required'
                  ? '使えません'
                  : '使えません（任意）'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
