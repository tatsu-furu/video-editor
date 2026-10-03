/**
 * ファイルの選択とドロップ（設計書 6.1：showOpenFilePicker、非対応時は input type=file）。
 */
export interface Picked {
  file: File
  handle?: FileSystemFileHandle
}

type OpenPicker = (o: {
  multiple?: boolean
  types?: { description: string; accept: Record<string, string[]> }[]
}) => Promise<FileSystemFileHandle[]>

export const VIDEO_ACCEPT = { 'video/*': ['.mp4', '.mov', '.mkv', '.webm', '.m4v'] }
export const AUDIO_ACCEPT = {
  'audio/*': ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac'],
}

export async function pickFiles(kind: 'video' | 'audio', multiple: boolean): Promise<Picked[]> {
  const picker = (window as unknown as { showOpenFilePicker?: OpenPicker }).showOpenFilePicker
  if (picker) {
    try {
      const handles = await picker({
        multiple,
        types: [
          {
            description: kind === 'video' ? '動画' : '音声',
            accept: kind === 'video' ? VIDEO_ACCEPT : AUDIO_ACCEPT,
          },
        ],
      })
      return Promise.all(handles.map(async (h) => ({ file: await h.getFile(), handle: h })))
    } catch {
      return []
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = multiple
    input.accept = kind === 'video' ? 'video/*,.mkv' : 'audio/*'
    input.onchange = () => resolve(Array.from(input.files ?? []).map((file) => ({ file })))
    input.click()
  })
}

/** ドロップされたファイル。Chrome ではファイルハンドルも取れる（再開時に使う） */
export async function droppedFiles(dt: DataTransfer): Promise<Picked[]> {
  const items = Array.from(dt.items).filter((i) => i.kind === 'file')
  const out: Picked[] = []
  for (const item of items) {
    const getHandle = (
      item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
    ).getAsFileSystemHandle
    const file = item.getAsFile()
    if (!file) continue
    let handle: FileSystemFileHandle | undefined
    if (getHandle) {
      try {
        const h = await getHandle.call(item)
        if (h?.kind === 'file') handle = h as FileSystemFileHandle
      } catch {
        /* ハンドルは無くてもよい */
      }
    }
    out.push({ file, handle })
  }
  return out
}
