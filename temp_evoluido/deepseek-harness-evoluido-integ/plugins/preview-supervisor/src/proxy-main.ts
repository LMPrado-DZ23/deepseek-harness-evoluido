import { listenPreviewProxy } from './proxy-server.js'

const listener = await listenPreviewProxy({
  socketPath: required('DZ23_PROXY_SOCKET'),
  runtimeRef: required('DZ23_PROXY_RUNTIME_REF'),
  runtimeHost: required('DZ23_PROXY_RUNTIME_HOST'),
  previewId: required('DZ23_PREVIEW_ID'),
  dataRoot: required('DZ23_PROXY_DATA_ROOT'),
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void listener.close().finally(() => process.exit(0))
})

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '' || value.length > 500 || value.includes('\0')) throw new Error(`INVALID_${name}`)
  return value
}
