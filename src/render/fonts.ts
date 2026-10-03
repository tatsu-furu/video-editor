/**
 * 字幕フォント（Noto Sans JP）の読み込み（設計書 3章「フォント」）。
 *
 * woff2 は @fontsource/noto-sans-jp のものを自前ホストする（COEP のため外部 CDN は使わない）。
 * 日本語フォントは文字の範囲ごとに分割されているので、FontFace に unicode-range を付けて登録し、
 * 描画前に「使う文字」を指定して load() すると必要な分だけ読み込まれる。
 * メインスレッド（document.fonts）と Worker（self.fonts）の両方で使う。
 */
import css400 from '@fontsource/noto-sans-jp/400.css?raw'
import css700 from '@fontsource/noto-sans-jp/700.css?raw'
import css900 from '@fontsource/noto-sans-jp/900.css?raw'

export const FONT_FAMILY = 'Noto Sans JP'

const urls = import.meta.glob(
  '/node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-*-{400,700,900}-normal.woff2',
  {
    query: '?url',
    import: 'default',
    eager: true,
  },
) as Record<string, string>

const byName = new Map<string, string>()
for (const [path, url] of Object.entries(urls))
  byName.set(path.slice(path.lastIndexOf('/') + 1), url)

interface FaceSpec {
  weight: string
  url: string
  unicodeRange: string
}

function parse(css: string): FaceSpec[] {
  const out: FaceSpec[] = []
  for (const block of css.split('@font-face').slice(1)) {
    const weight = /font-weight:\s*(\d+)/.exec(block)?.[1]
    const file = /url\(\.\/files\/([^)]+\.woff2)\)/.exec(block)?.[1]
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1]
    const url = file ? byName.get(file) : undefined
    if (weight && url && range) out.push({ weight, url, unicodeRange: range.trim() })
  }
  return out
}

let registered: WeakSet<FontFaceSet> = new WeakSet()

/** FontFaceSet に Noto Sans JP の全サブセットを登録する（実際の読み込みは load() まで遅延される） */
export function registerFonts(set: FontFaceSet): void {
  if (registered.has(set)) return
  for (const f of [...parse(css400), ...parse(css700), ...parse(css900)]) {
    set.add(
      new FontFace(FONT_FAMILY, `url(${f.url}) format('woff2')`, {
        weight: f.weight,
        unicodeRange: f.unicodeRange,
        display: 'block',
      }),
    )
  }
  registered.add(set)
}

/** text の描画に必要なサブセットを読み込む */
export async function loadGlyphs(set: FontFaceSet, weight: number, text: string): Promise<void> {
  registerFonts(set)
  if (!text) return
  await set.load(`${weight} 32px "${FONT_FAMILY}"`, text)
}

/** テスト用：登録をやり直す */
export function resetFontRegistry(): void {
  registered = new WeakSet()
}
