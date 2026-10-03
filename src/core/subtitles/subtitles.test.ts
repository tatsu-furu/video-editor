import { describe, expect, it } from 'vitest'
import {
  adjustTiming,
  buildSubtitles,
  charsPerSecond,
  cueAt,
  splitSentence,
  timelineCues,
  wrapLines,
} from './split'
import { toSrt } from './srt'
import { chunksToSegments, filterHallucinations } from './transcript'
import { clip } from '../time/time.test'

describe('字幕の分割（8.4）', () => {
  it('句点・感嘆符・疑問符で区切り、末尾の句点は表示しない', () => {
    const items = buildSubtitles([
      { start: 0, end: 6, text: 'こんにちは。元気ですか？今日はいい天気！' },
    ])
    expect(items.map((i) => i.text)).toEqual(['こんにちは', '元気ですか？', '今日はいい天気！'])
    // 文字数で按分（5:6:8）
    expect(items[0]!.sourceEnd).toBeCloseTo((6 * 6) / 20, 1)
  })

  it('2行に収まらなければ読点で、それでも長ければ長さで区切る', () => {
    const long = 'あ'.repeat(20) + '、' + 'い'.repeat(20) + '、' + 'う'.repeat(10)
    const parts = splitSentence(long, { maxCharsPerLine: 18, maxLines: 2 })
    expect(parts.every((p) => Array.from(p).length <= 36)).toBe(true)
    expect(parts[0]).toBe('あ'.repeat(20) + '、')
    const noComma = splitSentence('か'.repeat(80), { maxCharsPerLine: 18, maxLines: 2 })
    expect(noComma).toHaveLength(3)
    expect(noComma.every((p) => Array.from(p).length <= 36)).toBe(true)
  })

  it('1行18文字で折り返す', () => {
    expect(wrapLines('あいうえおかきくけこさしすせそたちつてとなにぬ', 18)).toEqual([
      'あいうえおかきくけこさし',
      'すせそたちつてとなにぬ',
    ])
    expect(wrapLines('短い', 18)).toEqual(['短い'])
  })

  it('表示時間は最短 0.8 秒・最長 6 秒、0.2 秒未満の隙間は詰める', () => {
    const t = adjustTiming([
      { sourceStart: 0, sourceEnd: 0.3 },
      { sourceStart: 1, sourceEnd: 9 },
      { sourceStart: 7.1, sourceEnd: 8 },
    ])
    expect(t.map((x) => [x.sourceStart, x.sourceEnd])).toEqual([
      [0, 1],
      [1, 7.1],
      [7.1, 8],
    ])
  })

  it('単語タイムスタンプがあれば区切り位置の時刻に使う', () => {
    const items = buildSubtitles([
      {
        start: 0,
        end: 10,
        text: 'はい。いいえ。',
        words: [
          { start: 0, end: 4, text: 'はい。', prob: 1 },
          { start: 8, end: 10, text: 'いいえ。', prob: 1 },
        ],
      },
    ])
    expect(items[0]!.sourceEnd).toBe(4)
  })

  it('読む速さの警告', () => {
    expect(
      charsPerSecond({ sourceStart: 0, sourceEnd: 1, text: 'あいうえおかきくけ' }),
    ).toBeGreaterThan(8)
  })
})

describe('タイムラインと SRT', () => {
  it('カットした区間の字幕は消え、一部だけ残れば切り詰める', () => {
    const track = [clip('a', 'A', 0, 5), clip('b', 'A', 10, 20)]
    const subs = [
      { id: '1', assetId: 'A', sourceStart: 1, sourceEnd: 2, text: 'いち' },
      { id: '2', assetId: 'A', sourceStart: 6, sourceEnd: 8, text: '消える' },
      { id: '3', assetId: 'A', sourceStart: 9, sourceEnd: 12.5, text: 'さん' },
    ]
    const cues = timelineCues(subs, track, { maxCharsPerLine: 18, maxLines: 2 })
    expect(cues.map((c) => [c.id, c.start, c.end])).toEqual([
      ['1', 1, 2],
      ['3', 5, 7.5],
    ])
    expect(cueAt(cues, 6)?.id).toBe('3')
    expect(cueAt(cues, 3)).toBeNull()
    expect(toSrt(cues)).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\nいち\n\n2\n00:00:05,000 --> 00:00:07,500\nさん\n',
    )
  })
})

describe('誤認識対策（8.2）', () => {
  it('発話率 10% 未満・3回以上の繰り返し・定型句を捨てる', () => {
    const segs = [
      { start: 0, end: 2, text: 'こんにちは' },
      { start: 2, end: 4, text: 'ご視聴ありがとうございました。' },
      { start: 4, end: 5, text: 'うん' },
      { start: 5, end: 6, text: 'うん' },
      { start: 6, end: 7, text: 'うん' },
      { start: 7, end: 9, text: 'またね' },
      { start: 20, end: 25, text: '無音の中' },
    ]
    const speech = [{ start: 0, end: 10 }]
    expect(filterHallucinations(segs, speech).map((s) => s.text)).toEqual(['こんにちは', 'またね'])
  })

  it('窓ごとの相対時刻をソース時刻にする', () => {
    expect(chunksToSegments([{ text: 'a', timestamp: [1, null] }], 10, 20)).toEqual([
      { start: 11, end: 14, text: 'a' },
    ])
  })
})
