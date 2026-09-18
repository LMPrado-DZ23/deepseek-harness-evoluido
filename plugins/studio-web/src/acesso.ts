import { IdentityError, authenticatedMutation, type StudioIdentityService } from '@dz23-studio/identity'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Como a pessoa chegou até a interface. */
export type FormaDeAcesso = 'sessao' | 'pessoal'

/**
 * QUEM PODE ABRIR A INTERFACE DO FRIGG.
 *
 * ## O defeito que isto conserta, e ele impedia usar o produto
 *
 * O `COMECAR.md` não tem passo de login: `pnpm studio`, abra o endereço, e
 * escreva o que você precisa. O MODO PESSOAL existe justamente para isso — o
 * servidor preso em `127.0.0.1`, nenhuma pessoa registrada, e a identidade
 * devolvendo um principal local. `GET /api/studio/identity/session` respondia
 * `{"mode":"personal"}` corretamente.
 *
 * E a página da interface, servida logo ao lado, exigia cookie de sessão. Sem
 * cookie, `401 Entre para continuar.` — numa instalação onde ENTRAR não existe,
 * porque não há ninguém para entrar como. Medido em 18/09/2026, na primeira vez
 * que o produto montado subiu nesta missão: a árvore carregava, o endereço
 * aparecia, e o que a pessoa via era uma recusa em texto puro.
 *
 * Nenhum teste podia pegar: os testes de `studio-web` montam o manipulador com
 * uma identidade dublê que autentica, e os de identidade testam identidade. O
 * defeito morava entre os dois, que é onde esta casa já se queimou antes.
 *
 * ## O que ele NÃO afrouxa
 *
 * A porta pessoal não é "sem autenticação": ela é a MESMA regra que
 * `GET /session` usa, e a regra mora na identidade, não aqui. Basta uma pessoa
 * registrada, ou a borda obrigatória, ou o servidor escutando em `0.0.0.0`,
 * para `personalPrincipal` devolver `undefined` — e aí a recusa volta, igual.
 * O cookie continua tendo precedência: quando ele existe, é ele que vale, com
 * recusa de ambiguidade e tudo o que vem junto.
 * @param request - o pedido.
 * @param identity - o serviço de identidade.
 * @param bindHost - o endereço em que o servidor escuta.
 * @param response - a resposta, para a limpeza de cookie sombra.
 * @returns como o acesso foi concedido.
 */
export async function acessoDaInterface(
  request: IncomingMessage,
  identity: StudioIdentityService,
  bindHost: '127.0.0.1' | '0.0.0.0',
  response?: ServerResponse,
): Promise<FormaDeAcesso> {
  try {
    await authenticatedMutation(request, identity, response)
    return 'sessao'
  } catch (erro) {
    // SÓ a recusa de identidade abre a porta pessoal. Qualquer outro erro
    // continua subindo: tratar falha de leitura como "deve ser modo pessoal"
    // transformaria um defeito em uma autorização.
    if (!(erro instanceof IdentityError)) throw erro
    // SÓ a recusa por falta de sessão abre a porta pessoal. `locked` é uma
    // instalação com gente registrada batendo no teto de tentativas, e ali a
    // resposta certa continua sendo a recusa — com o 429 que ela merece.
    if (erro.code !== 'invalid') throw erro
    if (identity.personalPrincipal(bindHost) === undefined) throw erro
    return 'pessoal'
  }
}
