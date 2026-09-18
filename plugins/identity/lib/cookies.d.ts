export declare const SESSION_COOKIE = "dz23_studio_session";
/**
 * O nome do cookie de sessão quando há TLS — com o prefixo `__Host-`.
 *
 * O prefixo não é enfeite: o navegador RECUSA gravar um cookie `__Host-` que
 * traga `Domain`, que não traga `Secure` ou cujo `Path` não seja `/`. É
 * exatamente isso que fecha o ataque de cookie sombra: sem ele, quem controlar
 * um subdomínio irmão (ou conseguir injetar num HTTP em texto claro) grava
 * `dz23_studio_session=<token dele>; Domain=.dominio.exemplo`, o navegador da
 * vítima passa a mandar DOIS cookies com o mesmo nome, e a vítima acaba
 * navegando dentro da sessão do atacante — e registrando a chave de acesso do
 * próprio dispositivo na conta dele.
 *
 * O nome SEM prefixo continua existindo porque em modo pessoal o Studio serve
 * sem TLS, e ACEITAR O PREFIXO ALI DEPENDE DA VERSÃO DO NAVEGADOR: medido,
 * Chromium 133 recusa `__Host-` sobre http mesmo em endereço de contexto
 * seguro, e Chromium 141 aceita. Emitir só o nome forte trancaria para fora
 * quem estivesse no navegador mais antigo. Os dois NUNCA são aceitos ao mesmo
 * tempo quando há TLS: aceitar o nome fraco ali reabriria o buraco inteiro.
 *
 * ESTE COMENTÁRIO JÁ AFIRMOU ALGO FALSO, e a correção fica registrada. Ele
 * dizia que "nesse modo não existe subdomínio irmão de onde atacar". Existe: a
 * topologia local da ADR-012 serve o Studio em `studio.dz23.localhost` e cada
 * prévia em `p-<hex>.dz23.localhost`, tudo em HTTP claro — e o aplicativo
 * GERADO, que ninguém leu, roda dentro da prévia. A jornada em navegador real
 * prova a gravação do cookie sombra a partir de lá. O que impede o roubo de
 * conta continua sendo recusar a ambiguidade; o que impede a recusa de virar
 * tranca é `shadowCookieDeletions`, logo abaixo.
 */
export declare const SECURE_SESSION_COOKIE = "__Host-dz23_studio_session";
/**
 * O nome do cookie de sessão para esta configuração.
 * @param secure - se os cookies são emitidos com `Secure`.
 * @returns o nome a emitir e a aceitar — um só, nunca os dois.
 */
export declare function sessionCookieName(secure: boolean): string;
/** Legacy marker expired on logout; clients no longer read cookies for login generation. */
export declare const SESSION_GENERATION_COOKIE = "dz23_studio_session_generation";
/** Legacy name retained only so existing client cookies can be expired. */
export declare const CSRF_COOKIE = "dz23_studio_csrf";
/**
 * As instruções que apagam um cookie de sessão gravado por um vizinho.
 *
 * O navegador manda os dois cookies no MESMO cabeçalho e não diz qual é o do
 * próprio host: por isso o servidor recusa a ambiguidade. Recusar e parar por
 * aí, porém, troca o roubo de conta por uma TRANCA — qualquer aplicativo
 * gerado rodando numa prévia irmã derruba a dona do Studio para fora, e ela
 * não tem gesto nenhum para se recuperar.
 *
 * A saída é apagar o cookie do vizinho e não o do host. Uma remoção com
 * `Domain` casa SÓ o cookie de domínio; o cookie host-only, que é o legítimo,
 * não é alcançado por ela. Depois disso o pedido seguinte tem um valor só e
 * volta a funcionar. O atacante pode plantar de novo, e aí paga outro pedido
 * recusado — o que ele não consegue é nem entrar na conta, nem manter a pessoa
 * de fora.
 *
 * Emite uma remoção por domínio-pai possível: quem planta pode estar num irmão
 * ou num primo mais acima. Domínio que o navegador recusar é simplesmente
 * ignorado por ele.
 *
 * A prévia CONTINUA irmã, e isso foi medido: separá-la de domínio quebra a
 * admissão sobre HTTP, porque o cookie dela é `SameSite=Strict` e um quadro de
 * outro site não o recebe de volta. Enquanto `T-37` estiver bloqueada em
 * certificado, esta limpeza é a defesa que sobra — e é por isso que ela passou
 * a alcançar mais de um `Path`.
 *
 * O QUE ELA NÃO ALCANÇA, e por isso não é a defesa principal: remoção de cookie
 * casa por (nome, domínio, CAMINHO), e o caminho aqui é `/`. Quem planta
 * escolhe o caminho — `Path=/api` produz um cookie que viaja em todo pedido de
 * API e que esta remoção nunca apaga. A defesa que de fato fecha o plantio é o
 * nome com prefixo `__Host-`, que o navegador recusa gravar com `Domain`; ver
 * `serializeSessionCookies`. Esta função é a rede para a instalação cujo
 * navegador não aceitou o nome forte.
 * @param host - o cabeçalho `Host` do pedido, com porta ou sem.
 * @param name - o nome do cookie de sessão desta instalação.
 * @returns os valores de `Set-Cookie`, vazio quando não há domínio-pai.
 */
export declare function shadowCookieDeletions(host: string | undefined, name: string): readonly string[];
/**
 * Os CAMINHOS que a remoção alcança.
 *
 * Remoção de cookie casa por (nome, domínio, caminho), e quem planta escolhe o
 * caminho. Parece infinito, e não é: um cookie gravado com `Path=P` só viaja
 * para um pedido quando `P` é o caminho do pedido ou é prefixo dele numa
 * fronteira de barra. O conjunto de caminhos que ALCANÇAM alguma rota desta
 * identidade é, portanto, fechado — e é ele, inteiro, que esta lista tem.
 *
 * Ela é DERIVADA dos contratos de rota, e não escrita à mão, porque a versão
 * escrita à mão sobreviveu à sabotagem: toda asserção saía da própria lista,
 * então encolhê-la encolhia junto a expectativa, e os testes mediam coerência
 * onde deviam medir COBERTURA. A lista escrita à mão também estava ERRADA —
 * trazia `/studio`, que este servidor não atende, e não trazia
 * `/api/studio/identity`, que ele atende em todo pedido.
 *
 * LIMITE DECLARADO: a cobertura é das rotas DESTA identidade, que é quem
 * recusa a ambiguidade (`parseCookieValues` não é lido em nenhum outro
 * plugin). Um plantio em caminho de outro serviço continua fora do alcance —
 * ele não tranca ninguém para fora da identidade, e é só disso que esta rede
 * trata. A defesa principal continua sendo o nome com prefixo `__Host-`.
 */
export declare const CAMINHOS_DA_REMOCAO: readonly string[];
export declare function parseCookieValues(header: string | undefined, name: string): readonly string[];
export declare function parseCookies(header: string | undefined): Readonly<Record<string, string>>;
//# sourceMappingURL=cookies.d.ts.map