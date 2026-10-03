import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'

// 素材は scripts/make-fixtures.sh（npm run fixtures）で作る。無ければスキップする。
const FIX = 'fixtures/generated/'
const hasFixtures = existsSync(`${FIX}talk.webm`)

test.beforeEach(async ({ page }) => {
  // ファイル選択は input type=file 経由にする（showOpenFilePicker は自動操作できないため）
  await page.addInitScript(() => {
    Object.assign(window, { showOpenFilePicker: undefined, showSaveFilePicker: undefined })
  })
  page.on('dialog', (d) => void d.accept())
})

test('読み込み → 無音カット → 元に戻す → 書き出し', async ({ page }) => {
  test.skip(!hasFixtures, 'npm run fixtures を先に実行してください')
  test.setTimeout(120_000)
  await page.goto('/')
  await page.getByRole('button', { name: /トーク動画/ }).click()
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '動画を追加する' }).first().click(),
  ])
  await chooser.setFiles(`${FIX}talk.webm`)

  // 解析が終わるとカットのステップに移り、無音（1.5 秒と 3 秒）の 2 か所が候補になる
  await expect(page.locator('.steps .is-current')).toContainText('カット', { timeout: 60_000 })
  await expect(page.locator('.sug')).toHaveCount(2)
  const timecode = page.locator('.timecode')
  await expect(timecode).toContainText('/ 0:13.00')

  await page.getByRole('button', { name: /すべて削除する/ }).click()
  await expect(timecode).not.toContainText('/ 0:13.00')
  await page.getByRole('button', { name: /元に戻す/ }).click()
  await expect(timecode).toContainText('/ 0:13.00')
  await page.getByRole('button', { name: /やり直す/ }).click()
  await expect(timecode).not.toContainText('/ 0:13.00')

  // 書き出し（メモリ上で作ってダウンロード）
  await page.locator('.steps button', { hasText: '書き出し' }).click()
  const download = page.waitForEvent('download', { timeout: 90_000 })
  await page.getByRole('button', { name: 'MP4 を書き出す' }).click()
  const d = await download
  expect(await d.failure()).toBeNull()
  await expect(page.locator('.toast')).toContainText('書き出しました')
})
