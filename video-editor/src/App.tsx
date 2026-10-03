import { useMemo } from 'react'
import { checkFeatures, type FeatureEnv, type FeatureResult } from './app/featureCheck'

/**
 * P0 の画面：このブラウザで必要な機能が使えるかを表示する。
 * P1 以降で編集画面に置き換える（機能チェック自体は起動時に残す）。
 */
export default function App() {
  const report = useMemo(() => checkFeatures(globalThis as unknown as FeatureEnv), [])

  return (
    <main className="page">
      <header className="masthead">
        <h1>動画編集アプリ（仮称）</h1>
        <p className="lede">
          {report.canEdit
            ? 'このブラウザで編集を始められます。'
            : 'このブラウザでは編集に必要な機能が足りません。'}
        </p>
      </header>

      <section aria-labelledby="track-title">
        <h2 id="track-title" className="visually-hidden">
          機能の対応状況
        </h2>
        <ol className="track" aria-hidden="true">
          {report.results.map((r) => (
            <li key={r.id} className={`clip ${statusClass(r)}`} title={r.label} />
          ))}
        </ol>

        <ul className="features">
          {report.results.map((r) => (
            <li key={r.id} className={`feature ${statusClass(r)}`}>
              <div className="feature-text">
                <span className="feature-name">{r.label}</span>
                <span className="feature-purpose">{r.purpose}</span>
              </div>
              <span className="feature-status">{statusText(r)}</span>
            </li>
          ))}
        </ul>
      </section>

      {!report.canEdit && (
        <p className="advice">
          最新版の Google Chrome か Microsoft Edge（パソコン版）で開いてください。
        </p>
      )}
      {report.canEdit && report.missingRecommended.length > 0 && (
        <p className="advice">
          編集はできますが、一部の処理が遅くなります。最新版の Chrome か Edge
          を使うと、すべての機能が使えます。
        </p>
      )}
    </main>
  )
}

function statusClass(r: FeatureResult): string {
  if (r.available) return 'is-ok'
  return r.level === 'required' ? 'is-missing' : 'is-limited'
}

function statusText(r: FeatureResult): string {
  if (r.available) return '使えます'
  return r.level === 'required' ? '使えません' : '使えません（任意）'
}
