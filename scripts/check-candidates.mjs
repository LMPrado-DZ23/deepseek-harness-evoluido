#!/usr/bin/env node
/**
 * Portão do registro de candidatos (EVO-01 / AT-113 / AT-114).
 *
 * Recusa as duas formas de o registro deixar de registrar:
 *
 * 1. um candidato marcado OPERACIONAL que não sustenta a promoção — a
 *    contradição que a AT-114 existe para impedir;
 * 2. um candidato sem CAPACIDADE ou sem AUTORIDADE nomeada — porque é assim
 *    que uma capacidade some junto com o candidato recusado, e ninguém vê a
 *    troca de "não adotamos o Mitosis" por "não fazemos isso".
 *
 * Uso: node scripts/check-candidates.mjs [--self-test]
 */
import { readFileSync } from 'node:fs'
import { DECISOES, capacidadePreservada, problemasDoRegistro, promocao } from './candidate-registry.mjs'

const ARQUIVO = 'docs/inventory/candidatos-v6.json'

/**
 * Um candidato mínimo VÁLIDO, para o autoteste partir dele e quebrar um campo
 * por vez. Um autoteste que monta o caso ruim do zero prova menos: ele não
 * mostra que a MESMA entrada passava antes.
 */
function base() {
  return {
    id: 'X', capacidade: 'fazer algo', autoridade_atual: 'quem já faz',
    decisao: 'NAO_ADOTAR', identidade_resolvida: true, estado: 'NAO_ADOTADO',
    plano_saida: 'não entra',
  }
}

function selfTest() {
  const checks = []
  const ok = (nome, condicao) => { checks.push(condicao); if (!condicao) console.error(`  autoteste FALHOU: ${nome}`) }

  ok('registro valido nao acusa', problemasDoRegistro([base()]).length === 0)
  ok('capacidade ausente acusa', problemasDoRegistro([{ ...base(), capacidade: '' }]).length === 1)
  ok('autoridade ausente acusa', problemasDoRegistro([{ ...base(), autoridade_atual: undefined }]).length === 1)
  ok('decisao fora das quatro acusa', problemasDoRegistro([{ ...base(), decisao: 'TALVEZ' }]).length === 1)
  ok('id repetido acusa', problemasDoRegistro([base(), base()]).length === 1)
  ok('OPERACIONAL sem sustentacao acusa', problemasDoRegistro([{ ...base(), estado: 'OPERACIONAL' }]).length === 1)
  ok('integrar sem identidade acusa', problemasDoRegistro([{ ...base(), decisao: 'INTEGRAR_COMPONENTE', identidade_resolvida: false }]).length >= 1)
  // As tres recusas que a AT-114 nomeia.
  const completo = {
    ...base(), decisao: 'INTEGRAR_COMPONENTE', licenca_aprovada: true, custo_aprovado: true,
    testes: 'EXECUTADOS', instalacao_autorizada: true, telemetria_sai_da_maquina: false,
    proprietario_repositorio: 'dono/repo', versao_avaliada: 'v1', licenca: 'MIT',
    telemetria: 'nenhuma', dados_enviados: 'nenhum', custo: 'zero',
  }
  ok('completo e promovivel', promocao(completo).promovivel)
  ok('identidade ausente bloqueia', promocao({ ...completo, identidade_resolvida: false }).bloqueios.includes('IDENTIDADE_NAO_RESOLVIDA'))
  ok('licenca nao resolvida bloqueia', promocao({ ...completo, licenca_aprovada: false }).bloqueios.includes('LICENCA_NAO_RESOLVIDA'))
  ok('telemetria bloqueia em privado-local', promocao({ ...completo, telemetria_sai_da_maquina: true }).bloqueios.includes('TELEMETRIA_INCOMPATIVEL'))
  ok('telemetria NAO bloqueia em perfil que permite saida',
    !promocao({ ...completo, telemetria_sai_da_maquina: true }, { perfil: 'melhor-qualidade' }).bloqueios.includes('TELEMETRIA_INCOMPATIVEL'))
  ok('recusa preserva a capacidade', promocao({ ...completo, licenca_aprovada: false }).capacidade_preservada)
  ok('quatro decisoes', DECISOES.length === 4 + 1 && DECISOES.includes('EM_ESTUDO'))
  ok('capacidadePreservada recusa DESCONHECIDO', !capacidadePreservada({ capacidade: 'x', autoridade_atual: 'DESCONHECIDO' }))

  const passou = checks.every(Boolean)
  console.log(`CANDIDATES_SELF_TEST=${passou ? 'PASS' : 'FAIL'} checks=${String(checks.length)}`)
  return passou
}

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest() ? 0 : 1
} else {
  let registro
  try { registro = JSON.parse(readFileSync(ARQUIVO, 'utf8')) }
  catch (error) {
    console.error(`CANDIDATES=FAIL motivo=${ARQUIVO} ilegível: ${error instanceof Error ? error.message : 'erro'}`)
    process.exitCode = 1
    registro = undefined
  }
  if (registro !== undefined) {
    const candidatos = registro.candidatos ?? []
    if (candidatos.length === 0) {
      // Um portão que passa com zero itens é uma falha, não um portão.
      console.error('CANDIDATES=FAIL motivo=registro vazio')
      process.exitCode = 1
    } else {
      const problemas = problemasDoRegistro(candidatos)
      const operacionais = candidatos.filter(item => item.estado === 'OPERACIONAL')
      const semCapacidade = candidatos.filter(item => !capacidadePreservada(item))
      for (const problema of problemas) console.error(`  - ${problema}`)
      const passou = problemas.length === 0
      console.log(`CANDIDATES=${passou ? 'PASS' : 'FAIL'} candidatos=${String(candidatos.length)} operacionais=${String(operacionais.length)} sem_capacidade=${String(semCapacidade.length)} problemas=${String(problemas.length)}`)
      process.exitCode = passou ? 0 : 1
    }
  }
}
