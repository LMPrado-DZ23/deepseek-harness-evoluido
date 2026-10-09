import { useState } from 'react'
import { useCatalogos } from '../i18n/IdiomaProvider'
import { api } from '../api'

/**
 * OS ARQUIVOS da versão, com o código de verdade dentro.
 *
 * ## O que ela mostra
 *
 * A lista vem do RELATO daquela tentativa — caminho, tamanho, quem escreveu e
 * se mudou —, que é o mesmo relato que o servidor usa como lista branca para
 * decidir o que pode ser servido. Uma lista só, dos dois lados.
 *
 * ## O que ela não faz
 *
 * Não baixa o arquivo inteiro para todo mundo de uma vez: o conteúdo é buscado
 * quando a pessoa abre UM. Um pacote com oitenta arquivos abertos de uma vez é
 * uma tela que demora e uma resposta que ninguém lê.
 *
 * Não inventa autoria nem mudança: as duas saem do relato. Quando ele não diz,
 * a linha não diz também — `NÃO OBSERVADO` e `sem mudança` são respostas
 * diferentes.
 */

export interface ArquivoDaVersao {
  readonly path: string
  readonly lines: number
  readonly bytes: number
  readonly author?: 'model' | 'studio'
  readonly change?: 'added' | 'changed' | 'unchanged'
}

export function Arquivos({ projectId, arquivos }: {
  readonly projectId: string
  readonly arquivos: readonly ArquivoDaVersao[]
}) {
  const { previa } = useCatalogos()
  const [aberto, setAberto] = useState<string | null>(null)
  const [conteudo, setConteudo] = useState<string | null>(null)
  const [recusa, setRecusa] = useState<'FONTE_GRANDE_DEMAIS' | 'FONTE_FORA_DA_LISTA' | null>(null)

  async function abrir(caminho: string) {
    if (aberto === caminho) { setAberto(null); setConteudo(null); setRecusa(null); return }
    setAberto(caminho)
    setConteudo(null)
    setRecusa(null)
    try {
      const lido = await api<{ content: string }>(`/projects/${encodeURIComponent(projectId)}/source?path=${encodeURIComponent(caminho)}`)
      setConteudo(lido.content)
    } catch (causa) {
      /*
        As duas recusas do servidor são causas DIFERENTES, e pedem frases
        diferentes: uma é "este arquivo não é desta versão", a outra é "este
        arquivo é seu e não cabe aqui". Colapsá-las mandaria a pessoa procurar o
        problema errado.
      */
      setRecusa(String(causa).includes('FONTE_GRANDE_DEMAIS') ? 'FONTE_GRANDE_DEMAIS' : 'FONTE_FORA_DA_LISTA')
    }
  }

  const rotuloDoAutor = (autor: ArquivoDaVersao['author']) =>
    autor === 'model' ? previa.autorModelo : autor === 'studio' ? previa.autorStudio : null
  const rotuloDaMudanca = (mudanca: ArquivoDaVersao['change']) =>
    mudanca === 'added' ? previa.mudouAdicionado
      : mudanca === 'changed' ? previa.mudouAlterado
        : mudanca === 'unchanged' ? previa.mudouIgual : null

  return <ul className="dz-previa-arquivos">
    {arquivos.map(arquivo => <li key={arquivo.path}>
      <button type="button" aria-expanded={aberto === arquivo.path} onClick={() => { void abrir(arquivo.path) }}>
        <code>{arquivo.path}</code>
        {/* Autoria e mudança só aparecem quando o relato as declara. */}
        {rotuloDoAutor(arquivo.author) === null ? null : <small>{rotuloDoAutor(arquivo.author)}</small>}
        {rotuloDaMudanca(arquivo.change) === null ? null : <small>{rotuloDaMudanca(arquivo.change)}</small>}
      </button>
      {aberto !== arquivo.path ? null
        : recusa === 'FONTE_GRANDE_DEMAIS' ? <p className="dz-previa-ajuda">{previa.arquivoGrande}</p>
          : recusa === 'FONTE_FORA_DA_LISTA' ? <p className="dz-previa-ajuda">{previa.arquivoRecusado}</p>
            : conteudo === null ? null
              : <pre className="dz-previa-codigo" tabIndex={0}><code>{conteudo}</code></pre>}
    </li>)}
  </ul>
}
