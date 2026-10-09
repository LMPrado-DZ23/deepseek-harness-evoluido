import tarefa from '../i18n/tarefa.pt-BR.json'
import { usoDaTarefa, type TentativaComUso } from './uso'

/**
 * O painel de USO E CUSTOS desta tarefa.
 *
 * Ele mostra o que o produto REGISTRA hoje — consumo por tentativa, gravado
 * pelo pipeline — e nada além disso. Cota de assinatura e custo informado pelo
 * provedor não existem em lugar nenhum deste código, então não têm linha aqui:
 * o adendo do proprietário separa os cinco números de propósito, e mostrar um
 * que ninguém mede seria inventá-lo.
 *
 * A regra que importa está em `uso.ts`, com teste: ausência é ausência.
 */
export function UsoDaTarefa({ tentativas }: { readonly tentativas: readonly TentativaComUso[] }) {
  const uso = usoDaTarefa(tentativas)
  const numero = (valor: number | null) => valor === null ? tarefa.usoNaoRegistrado : String(valor)
  return <div className="dz-uso">
    <dl className="dz-uso-linhas">
      <div><dt>{tarefa.usoTentativas}</dt><dd>{uso.tentativas}</dd></div>
      <div><dt>{tarefa.usoTokensEntrada}</dt><dd>{numero(uso.tokensEntrada)}</dd></div>
      <div><dt>{tarefa.usoTokensSaida}</dt><dd>{numero(uso.tokensSaida)}</dd></div>
      <div>
        <dt>{tarefa.usoCustoEstimado}</dt>
        <dd>{uso.custoEstimadoUsd === null ? tarefa.usoNaoRegistrado : `US$ ${uso.custoEstimadoUsd.toFixed(4)}`}</dd>
      </div>
      {uso.rotas.length === 0 ? null : <div><dt>{tarefa.usoRotas}</dt><dd>{uso.rotas.join(', ')}</dd></div>}
      {uso.modelos.length === 0 ? null : <div><dt>{tarefa.usoModelos}</dt><dd>{uso.modelos.join(', ')}</dd></div>}
    </dl>
    {/*
      A linha que impede o resto de mentir. Sem ela, uma soma pequena parece o
      custo inteiro; com ela, ela é lida como incompleta — que é o que ela é.
    */}
    {uso.tentativasSemRegistro > 0
      ? <p className="dz-uso-aviso" role="status">{tarefa.usoSemRegistro.replace('{quantas}', String(uso.tentativasSemRegistro))}</p>
      : null}
    <p className="dz-uso-limite">{tarefa.usoLimite}</p>
  </div>
}
