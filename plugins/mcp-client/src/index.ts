/**
 * Cliente MCP do DZ23 STUDIO (X-11).
 *
 * Monta o despachante que o Integration Hub usa quando uma integração do tipo
 * `mcp` é acionada. Não tem domínio próprio, não guarda nada e não expõe rota:
 * tudo o que precisa ser lembrado — o registro da integração, os contadores, a
 * auditoria — já vive no Hub, e um segundo lugar guardando o mesmo assunto é um
 * segundo lugar que um dia discorda do primeiro.
 *
 * O QUE ESTE PLUGIN ISOLA DE VERDADE no processo do servidor MCP:
 * - pasta de trabalho explícita e absoluta, declarada no perfil;
 * - ambiente construído do zero (`environment.ts`): o que não foi declarado não
 *   existe lá dentro, e `process.env` do Studio nunca é lido;
 * - nenhum interpretador de comandos (`shell: false`) e nenhum descritor além
 *   dos três canos;
 * - tempo máximo de apresentação e de chamada, com MORTE do processo (SIGTERM,
 *   carência curta, SIGKILL) em vez de abandono;
 * - teto de bytes por mensagem e de número de ferramentas, ambos recusando em
 *   vez de truncar;
 * - um processo por chamada, encerrado no `finally`, mais uma rede de segurança
 *   que mata todo filho vivo na saída do processo do Studio.
 *
 * O QUE ESTE PLUGIN **NÃO** ISOLA, e ninguém deve supor que sim:
 * - REDE: o servidor MCP fica no mesmo espaço de rede do Studio e pode abrir
 *   qualquer conexão. Não há espaço de rede separado, nem filtro, nem seccomp
 *   aqui. Só um confinamento do sistema operacional resolveria isso — este
 *   repositório tem a semente dele em
 *   `third_party/deepseek-harness/native/landlock-run`, que NÃO está ligada a
 *   este caminho.
 * - SISTEMA DE ARQUIVOS: a pasta de trabalho decide onde o processo COMEÇA, não
 *   o que ele pode abrir. Um servidor MCP pode ler e escrever qualquer caminho
 *   absoluto que o usuário do Studio alcance.
 * - USUÁRIO, MEMÓRIA E CPU: o filho roda com o mesmo usuário e grupo do Studio,
 *   sem cgroup e sem limite de memória ou de tempo de CPU.
 * - NETOS: `detached: false` mantém o filho no grupo do Studio, mas um processo
 *   que o servidor MCP crie por conta própria não é alcançado pelo encerramento
 *   daqui.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@dz23-studio/integration-hub'
import { createMcpDispatcher, mcpLimitsFromCallPolicy, parseServerCatalog, type McpServerCatalog } from './dispatch.js'
import { type McpConnectionLimits } from './model.js'

export * from './client.js'
export * from './dispatch.js'
export * from './environment.js'
export * from './model.js'
export * from './transport.js'

export const name = 'dz23-studio-mcp-client'

/**
 * `studioIntegrationHub` é OBRIGATÓRIO, ao contrário do padrão preguiçoso de
 * `plugins/emergency-stop`.
 *
 * O botão de emergência é resolvido preguiçosamente porque ele tem muitos
 * consumidores opcionais e precisa funcionar para quem montar depois. Aqui é o
 * contrário: este plugin tem exatamente um consumidor, e um cliente MCP sem o
 * Hub não teria a quem servir — nem registro, nem assinatura, nem teto, nem
 * auditoria. Declarar a dependência faz o perfil recusar a montagem em vez de
 * subir um plugin que não faz nada e não diz que não faz.
 */
export const inject = ['studioIntegrationHub']

export interface McpClientConfig {
  /**
   * Os servidores MCP que ESTE computador concorda em executar, por `id` de
   * manifesto.
   *
   * Escrito no perfil e nunca lido do ambiente, pelo mesmo motivo que o canal do
   * Hub: uma variável de ambiente não pode decidir qual programa o Studio
   * executa. Vazio (o padrão) significa que nenhuma integração MCP é chamada, e
   * a recusa é auditada — falha fechada, não silêncio.
   */
  readonly servers?: Readonly<Record<string, unknown>>
  /**
   * Ajustes de teto do processo filho. O TEMPO não entra aqui: ele vem da
   * política de chamada do Hub, para que não exista um segundo número capaz de
   * discordar do primeiro.
   */
  readonly limits?: Pick<Partial<McpConnectionLimits>, 'maxMessageBytes' | 'maxTools' | 'shutdownGraceMs'>
}

export interface StudioMcpClientRuntime {
  /** Os servidores cadastrados neste Studio. Existe para a tela poder dizer o que está disponível. */
  readonly catalog: McpServerCatalog
}

declare module '@deepseek-ai/cordis' {
  interface Context { studioMcpClient: StudioMcpClientRuntime }
}

export async function apply(ctx: Context, config: McpClientConfig = {}): Promise<void> {
  // Validado na MONTAGEM, não na primeira chamada: um cadastro torto descoberto
  // durante o uso apareceria para quem está usando o Studio como "a integração
  // falhou", e não para quem pode consertar como "o perfil está errado".
  const catalog = parseServerCatalog(config.servers ?? {})
  const hub = ctx.studioIntegrationHub.service
  const dispatcher = createMcpDispatcher({
    catalog,
    // Lido a CADA chamada: a política de chamada é do Hub, e capturá-la aqui
    // congelaria um teto que o Hub pode ter mudado.
    limits: () => mcpLimitsFromCallPolicy(hub.callPolicy, config.limits ?? {}),
  })
  const uninstall = hub.useMcpDispatcher(dispatcher)
  ctx.effect(() => uninstall, 'dz23-studio-mcp-client.dispatcher')
  ctx.provide('studioMcpClient', { catalog })
}
