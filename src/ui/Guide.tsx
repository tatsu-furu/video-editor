/**
 * 使い方（初めての人向けの説明）。ヘッダーとプロジェクト一覧から開く。
 */
import { useSession } from '../store/session'

export const KOFI_URL = 'https://ko-fi.com/alt4l'

/** 左下の支援ボタン。COEP のため Ko-fi の外部スクリプトは読み込まず、ただのリンクにしている */
export function KofiButton() {
  return (
    <a className="kofi" href={KOFI_URL} target="_blank" rel="noopener noreferrer">
      ☕ Support me
    </a>
  )
}

export function GuideButton({ className = '' }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => useSession.setState({ guideOpen: true })}
    >
      📖 使い方
    </button>
  )
}

const STEPS: [string, string[]][] = [
  [
    '① 読み込み',
    [
      '「動画を追加する」かドラッグ＆ドロップで動画を入れます。複数入れると、入れた順につながります。',
      '「ゲーム録画」か「トーク動画」を選んでおくと、自動カットの探し方が変わります（あとで変えられます）。',
      '入れるとすぐに音声の解析が始まります。終わると自動で②カットに進みます。',
    ],
  ],
  [
    '② カット',
    [
      'タイムラインの赤い斜線が「削除候補」（無音・静かな場面）、緑が「盛り上がり（残す場面）」です。',
      '左の一覧で候補をクリックすると、その少し前から確認できます。「削除する」「残す」を選ぶか、「すべて削除する」でまとめて消せます。',
      '「詰め具合」「感度」「目標の長さ」を変えると、候補が作り直されます。',
    ],
  ],
  [
    '③ 字幕',
    [
      '「文字起こしする」で話した内容を文字にします（初回はモデルのダウンロードがあります。GPU がないとかなり時間がかかります）。',
      '一覧で文字を直してから「字幕を入れる」を押すと、1画面に収まるように分けて字幕が入ります。',
      'タイムラインの字幕（黄色）はドラッグで動かせ、ダブルクリックで文字を直せます。',
    ],
  ],
  [
    '④ BGM',
    [
      '「BGM を追加する」で曲を入れると、動画の長さに合わせてループし、最初と最後はフェードします。',
      '話しているところでは BGM が自動で小さくなります（タイムラインの BGM の線が下がっている所）。',
      '「BGM の大きさ」のスライダーだけで、全体のバランスを調整できます。',
    ],
  ],
  [
    '⑤ 書き出し',
    [
      '「MP4 を書き出す」で保存先を選ぶと書き出しが始まります。終わるまでこのタブは開いたままにしてください。',
      '字幕だけ欲しいときは「SRT を保存する」。',
    ],
  ],
]

const TIMELINE: [string, string][] = [
  ['再生位置を動かす', 'タイムラインの空いた所や目盛りをクリック（ドラッグで動かしながら確認）'],
  ['切る', '再生位置で「分割する」（S キー）'],
  [
    'いらない部分を消す',
    '消したいクリップをクリックしてチェック ✓ を付け、「チェックした○本を削除して詰める」（Delete キー）。何本でもまとめて消せます',
  ],
  ['範囲で消す', '目盛りをドラッグして範囲を選び、「範囲を削除して詰める」'],
  ['長さを変える', 'クリップの左右の端をドラッグ'],
  ['順番を変える', 'クリップをドラッグして、入れたい場所で離す'],
  [
    '目印を付ける',
    '「📍 ピンを打つ」（M キー）。旗をクリックで選んで、名前を付けたり消したりできます。↑↓ キーでピンにも移動できます',
  ],
  ['元に戻す', '「元に戻す」（Ctrl+Z）。間違えても何回でも戻せます'],
]

export function Guide() {
  const open = useSession((s) => s.guideOpen)
  if (!open) return null
  const close = () => useSession.setState({ guideOpen: false })
  return (
    <div className="modal" role="dialog" aria-label="使い方" onClick={close}>
      <div className="modal-body guide" onClick={(e) => e.stopPropagation()}>
        <h2>使い方</h2>
        <p className="muted small">
          上の「①読み込み →
          ⑤書き出し」の順に進めるだけで動画ができます。どのステップにもいつでも戻れます。動画はどこにもアップロードされず、作業は自動で保存されます。
        </p>
        {STEPS.map(([title, lines]) => (
          <section key={title}>
            <h3>{title}</h3>
            <ul>
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </section>
        ))}
        <h3>タイムラインの操作</h3>
        <table className="keys">
          <tbody>
            {TIMELINE.map(([k, d]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{d}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">キーボードの操作の一覧は「? ショートカット」から見られます。</p>
        <button type="button" className="primary" onClick={close}>
          閉じる
        </button>
      </div>
    </div>
  )
}
