/**
 * A tarefa parou DEPOIS da última resposta e ANTES da especificação?
 *
 * A síntese chama o modelo depois da última resposta. Quando essa chamada
 * falha, a resposta já está gravada: não há pergunta aberta, a tarefa continua
 * em `DRAFT`, e a tela não oferecia nada — nem pergunta, nem plano, nem
 * tentar de novo. Medido em 19/09/2026 no computador do titular, na primeira
 * criação pela Mistral: a conversa ficou parada na terceira resposta.
 *
 * O servidor já sabe refazer a síntese quando recebe uma resposta sem
 * pergunta aberta (18/09); faltava a tela oferecer.
 * @param estado - o estado da tarefa.
 * @param pergunta - a pergunta aberta, ou `null`.
 * @param turnos - as respostas gravadas.
 * @returns se a tela deve oferecer "tentar de novo".
 */
export function sinteseParada(
  estado: string | null,
  pergunta: unknown,
  turnos: readonly unknown[] | undefined,
): boolean {
  return estado === 'DRAFT' && pergunta === null && (turnos?.length ?? 0) > 0
}
