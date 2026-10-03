// FileSystemSyncAccessHandle は Worker 用の型（lib.webworker）にしかないので、ここで宣言する。
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  truncate(newSize: number): void
  getSize(): number
  flush(): void
  close(): void
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>
}
