export interface OperatorCommand {
  command: 'backup' | 'verify-backup' | 'restore' | 'status'
  dsnRef?: string
  [key: string]: unknown
}

export function parseOperatorCommand(argv: readonly string[]): OperatorCommand
export function runOperator(command: OperatorCommand, dependencies?: { signal?: AbortSignal }): Promise<Record<string, unknown>>
export function sanitizeOperatorError(error: unknown, secrets?: readonly string[]): string
export function main(runtime?: {
  argv?: readonly string[]
  environment?: NodeJS.ProcessEnv
  stdout?: { write(value: string): unknown }
  stderr?: { write(value: string): unknown }
  signals?: { once(name: 'SIGINT' | 'SIGTERM', listener: () => void): unknown; off(name: 'SIGINT' | 'SIGTERM', listener: () => void): unknown }
  dependencies?: Record<string, unknown>
}): Promise<0 | 1>
