import { expect, test } from '@playwright/test'

test('ページが表示され、クロスオリジン分離が有効になっている', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true)
})
