/** Quantas letras o nome de um projeto carrega. O domínio aceita 120; a lista lê melhor com menos. */
const NAME_LIMIT = 60

/**
 * O nome do projeto, tirado da ideia que a pessoa escreveu.
 *
 * Antes era `brief.slice(0, 60)`, e o corte caía onde caísse: a lista mostrava
 * "quero uma página para apresentar minha clínica e receber con". Um nome
 * cortado no meio de uma palavra faz o produto parecer quebrado justamente na
 * tela em que a pessoa procura o próprio trabalho.
 *
 * O corte agora acontece no último espaço antes do limite, e o reticências diz
 * que há mais texto. A ideia inteira continua guardada em `original_brief` —
 * este é o RÓTULO, não o conteúdo.
 * @param brief - a ideia, com as palavras da pessoa.
 * @returns o nome, com no máximo 60 letras.
 */
export function projectNameFromBrief(brief: string): string {
  const clean = brief.trim().replace(/\s+/gu, ' ')
  if (clean.length <= NAME_LIMIT) return clean
  const cut = clean.slice(0, NAME_LIMIT - 1)
  const lastSpace = cut.lastIndexOf(' ')
  // Uma única palavra maior que o limite não tem espaço onde cortar: aí o corte
  // seco é o certo, e continua com reticências.
  return `${(lastSpace > NAME_LIMIT / 3 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
