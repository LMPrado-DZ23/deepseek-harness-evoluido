import type { SupervisorForwardRequest, SupervisorStartRequest } from './protocol.js'

export interface ManagedPreviewRow { readonly runtime_ref: string; readonly preview_id: string }
export interface SupervisorForwardResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly body_base64: string
}

export interface PreviewSupervisorPort {
  start(input: SupervisorStartRequest, signal: AbortSignal): Promise<{ readonly runtime_ref: string }>
  stop(runtimeRef: string, signal: AbortSignal): Promise<void>
  health(runtimeRef: string, signal: AbortSignal): Promise<'OK' | 'DOWN'>
  logs(runtimeRef: string, limit: number, signal: AbortSignal): Promise<readonly unknown[]>
  verificationMessages(runtimeRef: string, signal: AbortSignal): Promise<readonly unknown[]>
  listManaged(signal: AbortSignal): Promise<readonly ManagedPreviewRow[]>
  forward(input: SupervisorForwardRequest, signal: AbortSignal): Promise<SupervisorForwardResponse>
}
