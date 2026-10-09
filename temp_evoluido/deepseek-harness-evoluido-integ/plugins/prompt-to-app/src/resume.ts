import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { RunFileAuthor } from './run-report.js'

/**
 * O marco de geração concluída de uma tentativa.
 *
 * Existe porque uma criação cancelada recomeçava do ZERO. Quem apertava
 * "Cancelar" depois de esperar quatro minutos — porque precisava do computador,
 * porque fechou o navegador, porque a máquina reiniciou — perdia a geração
 * inteira e pagava o modelo de novo.
 *
 * E pagar de novo é o menor dos dois problemas. **A geração não é
 * determinística**: pedir de novo ao modelo, com o mesmo plano, devolve um
 * aplicativo DIFERENTE. A pessoa aprovou um plano, esperou, cancelou, mandou
 * recomeçar — e recebia outra coisa. Retomar não é só economia; é a única forma
 * de a segunda tentativa entregar o que a primeira estava construindo.
 *
 * O arquivo é escrito no diretório da tentativa DEPOIS que a geração deu certo
 * e foi gravada. A presença dele é um fato verificável: "o modelo respondeu,
 * a resposta passou pelos controles e está em disco". A ausência também é um
 * fato: não há de onde retomar, e a execução gera de novo, como sempre fez.
 */
export const RESUME_MARKER_FILE = 'generation.json'

export const resumeMarkerSchema = z.object({
  plan_id: z.string().min(1),
  /**
   * O resumo do que a pessoa pediu. Junto com `plan_id`, é o que impede a
   * retomada de responder a pergunta ERRADA: se ela editou o plano ou mudou as
   * respostas depois de cancelar, os arquivos guardados respondem a outra
   * pergunta, e reaproveitá-los entregaria calado o aplicativo antigo.
   */
  app_spec_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  attempt: z.number().int().min(1),
  route: z.string().nullable(),
  model: z.string().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  /**
   * Os caminhos protegidos e o hash da árvore imutável, EXATAMENTE como foram
   * calculados antes da geração.
   *
   * Recalculá-los na retomada daria outro resultado: naquele momento o
   * diretório tinha só o template e as camadas do Studio, e agora tem também os
   * arquivos do modelo. Um `listTreeFiles` na retomada declararia o código
   * gerado como parte do template protegido — e a conferência de integridade
   * passaria a proteger justamente o que ela existe para vigiar.
   */
  protected_paths: z.array(z.string().min(1)),
  immutable_before: z.string().regex(/^[a-f0-9]{64}$/u),
  files: z.array(z.object({ path: z.string().min(1), author: z.enum(['studio', 'model']) }).strict()),
  created_at: z.string().min(1),
}).strict()

export type ResumeMarker = z.infer<typeof resumeMarkerSchema>

/** O resumo do plano e da especificação que a retomada precisa casar. */
export function resumeFingerprint(appSpecSha256: string, planId: string): { readonly app_spec_sha256: string; readonly plan_id: string } {
  return { app_spec_sha256: appSpecSha256, plan_id: planId }
}

/** Grava o marco. Falhar aqui NÃO derruba a execução: só desiste da retomada. */
export async function writeResumeMarker(directory: string, marker: ResumeMarker): Promise<void> {
  try {
    await writeFile(resolve(directory, RESUME_MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
  } catch {
    // Uma execução que está indo bem não pode morrer porque o atalho da
    // PRÓXIMA vez não pôde ser anotado.
  }
}

/**
 * Lê o marco de um diretório, se ele existir e servir.
 *
 * Devolve `null` para tudo que não é uma retomada segura: arquivo ausente,
 * ilegível, malformado, de outro plano ou de outra especificação. Nunca lança —
 * uma retomada impossível vira geração normal, que é o comportamento que sempre
 * existiu, e não um erro na cara de quem só queria continuar.
 */
export async function readResumeMarker(directory: string, expect: { readonly planId: string; readonly appSpecSha256: string }): Promise<ResumeMarker | null> {
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(resolve(directory, RESUME_MARKER_FILE), 'utf8')) }
  catch { return null }
  const marker = resumeMarkerSchema.safeParse(parsed)
  if (!marker.success) return null
  if (marker.data.plan_id !== expect.planId) return null
  if (marker.data.app_spec_sha256 !== expect.appSpecSha256) return null
  return marker.data
}

/**
 * Os arquivos da tentativa retomada, relidos do disco.
 *
 * O marco guarda caminho e autor; o CONTEÚDO fica onde sempre esteve, no
 * diretório da tentativa. Guardar o conteúdo dentro do marco duplicaria o
 * aplicativo inteiro em disco, e as duas cópias poderiam divergir — e a cópia
 * que importa é a que o construtor vai compilar.
 *
 * Um arquivo que sumiu é ignorado em vez de derrubar a retomada: o relato
 * mostra o que existe, e o construtor reprova sozinho se faltar algo que
 * importa. Inventar conteúdo para completar a lista seria mentir no diff.
 */
export async function readResumedFiles(directory: string, marker: ResumeMarker): Promise<readonly { readonly path: string; readonly content: string; readonly author: RunFileAuthor }[]> {
  const files: { path: string; content: string; author: RunFileAuthor }[] = []
  for (const entry of marker.files) {
    try { files.push({ path: entry.path, content: await readFile(resolve(directory, entry.path), 'utf8'), author: entry.author }) }
    catch { /* sumiu do disco: o construtor reprova sozinho se fizer falta */ }
  }
  return files
}

/** O resumo de um texto, no formato que o marco usa. */
export function sha256(value: string): string { return createHash('sha256').update(value).digest('hex') }
