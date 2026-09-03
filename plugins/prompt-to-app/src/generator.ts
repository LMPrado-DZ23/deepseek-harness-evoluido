import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { z } from 'zod'

export const generatedFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().max(512 * 1024),
}).strict()
export type GeneratedFile = z.infer<typeof generatedFileSchema>

export class GeneratedFileRejectedError extends Error {
  readonly code = 'GENERATED_FILE_REJECTED'
}

export interface GeneratedWritePolicy {
  readonly plannedPaths?: readonly string[]
  readonly mutableGeneratedPaths?: readonly string[]
  readonly protectedTemplatePaths?: readonly string[]
}

export function validateGeneratedPath(path: string): string {
  const normalized = validateRelativePath(path)
  const parts = normalized.split('/')
  if (parts[0] !== 'src' && parts[0] !== 'content') throw new GeneratedFileRejectedError('O modelo só pode alterar src/ e content/.')
  return normalized
}

function validateRelativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (isAbsolute(path) || normalized.startsWith('/') || normalized.includes('\0')) throw new GeneratedFileRejectedError('O modelo tentou usar um caminho absoluto.')
  const parts = normalized.split('/')
  if (parts.some(part => part === '..' || part === '' || part === '.')) throw new GeneratedFileRejectedError('O modelo tentou sair do diretório permitido.')
  return normalized
}

function normalizedSet(paths: readonly string[] | undefined): ReadonlySet<string> | undefined {
  return paths === undefined ? undefined : new Set(paths.map(validateGeneratedPath))
}

export async function writeGeneratedFiles(runDirectory: string, files: readonly GeneratedFile[], policy: GeneratedWritePolicy = {}): Promise<readonly string[]> {
  const root = await realpath(runDirectory)
  const planned = normalizedSet(policy.plannedPaths)
  const mutable = normalizedSet(policy.mutableGeneratedPaths) ?? new Set()
  const protectedTemplate = policy.protectedTemplatePaths === undefined ? new Set<string>() : new Set(policy.protectedTemplatePaths.map(validateRelativePath))
  const seen = new Set<string>()
  const written: string[] = []
  for (const input of files) {
    const file = generatedFileSchema.parse(input)
    const safe = validateGeneratedPath(file.path)
    if (planned !== undefined && !planned.has(safe)) throw new GeneratedFileRejectedError(`Arquivo fora do plano aprovado: ${safe}`)
    if (seen.has(safe)) throw new GeneratedFileRejectedError(`Arquivo repetido: ${safe}`)
    seen.add(safe)
    const target = resolve(root, safe)
    const boundary = `${root}${sep}`
    if (!target.startsWith(boundary) || relative(root, target).startsWith('..')) throw new GeneratedFileRejectedError('O arquivo saiu do diretório da execução.')
    await mkdir(dirname(target), { recursive: true })
    const existing = await lstat(target).catch(() => undefined)
    if (existing?.isSymbolicLink()) throw new GeneratedFileRejectedError('Link simbólico proibido na saída gerada.')
    if (existing !== undefined && protectedTemplate.has(safe)) throw new GeneratedFileRejectedError(`Arquivo protegido do template: ${safe}`)
    if (existing !== undefined && !mutable.has(safe)) throw new GeneratedFileRejectedError(`O plano não autorizou alterar o arquivo existente: ${safe}`)
    try {
      await writeFile(target, file.content, { encoding: 'utf8', flag: existing === undefined ? 'wx' : 'w' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new GeneratedFileRejectedError(`O modelo tentou substituir um arquivo existente: ${safe}`)
      }
      throw error
    }
    written.push(safe)
  }
  return written
}
