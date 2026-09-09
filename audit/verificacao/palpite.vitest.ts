import { describe, it } from 'vitest'
import { suggestCategory } from '../../apps/studio-web/src/categorySuggestion'

const TEXTOS: readonly (readonly [string, string])[] = [
  // esperado, texto
  ['scheduling', 'quero uma agenda para minha clinica marcar consultas'],
  ['scheduling', 'preciso que meus clientes escolham um horario e eu confirme'],
  ['scheduling', 'salao de beleza, cliente escolhe dia e hora com a manicure'],
  ['scheduling', 'quero q as pessoa marque hora comigo pelo celular'],
  ['scheduling', 'sistema pra barbearia'],
  ['catalog', 'quero mostrar meus bolos com foto e preco'],
  ['catalog', 'cardapio digital da minha pizzaria'],
  ['catalog', 'uma vitrine dos moveis que eu faco'],
  ['catalog', 'lista dos meus produtos com preço pra mandar no zap'],
  ['form-database', 'formulario de inscricao pro meu curso e ver quem se inscreveu'],
  ['form-database', 'quero cadastrar meus alunos e ve los em uma lista'],
  ['form-database', 'anotar os pedidos que chegam por telefone'],
  ['crud-panel', 'um painel para minha equipe criar editar e excluir clientes'],
  ['crud-panel', 'quero gerenciar meu estoque, adicionar e tirar produto'],
  ['crud-panel', 'controle de ordens de servico da oficina, mexer nos dados'],
  ['dashboard', 'quero acompanhar os numeros da loja sem alterar nada'],
  ['dashboard', 'ver quanto vendi no mes em graficos'],
  ['dashboard', 'saber quanto entrou e quanto saiu por semana'],
  ['saas-authenticated', 'cada cliente meu entra com a propria conta e ve so os dados dele'],
  ['saas-authenticated', 'quero vender assinatura mensal com area restrita'],
  ['landing-page', 'uma pagina para divulgar meu trabalho de fotografia'],
  ['landing-page', 'site institucional da minha empresa com fale conosco'],
  // ambiguos de proposito
  ['?', 'quero um sistema para minha clinica'],
  ['?', 'um app pra minha loja'],
  ['?', 'painel de controle da minha equipe com os numeros de vendas'],
  ['?', 'catalogo de servicos onde o cliente ja marca o horario'],
  ['?', 'quero uma agenda e tambem um relatorio de quantos atendimentos fiz'],
  ['?', 'site com cardapio e reserva de mesa'],
  // mal escritos
  ['?', 'axo q preciso d um lugar pra guarda os nome dos meu cliente'],
  ['?', 'AJENDA PRA MINHA CLINICA'],
  ['?', 'quero organizar minhas coisa do trabalho'],
  ['?', 'me ajuda a fazer um negocio pra vender bolo'],
  ['?', 'preciso controlar quem me deve'],
  ['?', 'app de delivery'],
  ['?', 'sistema de ponto dos funcionarios'],
  ['?', 'quero um lugar pros meus pacientes preencherem a ficha antes da consulta'],
  ['?', 'loja virtual com carrinho e pagamento'],
  ['?', 'rede social pra minha igreja'],
  ['?', 'quero um chat com meus clientes'],
]

describe('palpite de categoria com textos de gente', () => {
  it('imprime', async () => {
    const linhas = TEXTOS.map(([esperado, texto]) => {
      const got = suggestCategory(texto)
      const mark = esperado === '?' ? '  ?  ' : (got === esperado ? ' ok  ' : 'ERRO ')
      return `${mark} ${got.padEnd(20)} <- ${texto}${esperado === '?' ? '' : `   (esperado ${esperado})`}`
    });
    (await import('node:fs')).writeFileSync('/home/claude/integ/audit/verificacao/palpite.txt', linhas.join('\n'))
  })
})
