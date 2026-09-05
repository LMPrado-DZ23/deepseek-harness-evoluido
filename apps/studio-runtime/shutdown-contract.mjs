export function classifyShutdown(code, signal, requestedSignal) {
  if (requestedSignal !== 'SIGINT' && requestedSignal !== 'SIGTERM') return null
  if (code === null && signal === requestedSignal) return 'forwarded-signal'
  if (code === 0 && signal === null) return 'zero-exit'
  return null
}
