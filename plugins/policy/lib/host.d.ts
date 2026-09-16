/**
 * Canonical form of a host, and the ranges an integration may never talk to.
 *
 * A revisão adversarial de `staging`/`integration-hub` achou aqui o defeito mais
 * grave da missão até agora, e a causa é a de sempre: a decisão morava numa
 * lista de expressões regulares comparada com o TEXTO do host, e o texto de um
 * endereço não é único. `http://[::ffff:169.254.169.254]/` chega ao `URL` do
 * Node como `::ffff:a9fe:a9fe`, que não casa com `^169\.254\.`;
 * `metadata.google.internal.` — com o ponto final, que é o nome absoluto e
 * resolve igual — não casa com `\.internal$`; e `100.100.100.200`, que é o
 * serviço de metadados de uma nuvem inteira, não estava em lista nenhuma.
 *
 * Por isso este módulo não acrescenta padrão: ele NORMALIZA primeiro e decide
 * por FAIXA NUMÉRICA depois. Uma forma nova de escrever o mesmo endereço passa
 * a cair na mesma decisão em vez de precisar de mais uma linha de regex.
 *
 * O que continua fora do alcance, e está dito em OS-30: a recusa é sobre o que
 * o manifesto ESCREVEU. Um nome público que RESOLVE para endereço interno passa
 * por aqui, e fechar isso exige decidir no momento da conexão, dentro de quem
 * fala o protocolo.
 */
export declare const FORMAS: readonly ["IPV4", "IPV6", "NOME"];
export type FormaDeHost = (typeof FORMAS)[number];
export interface HostCanonico {
    readonly forma: FormaDeHost;
    /** O host já sem colchetes, em minúsculas e sem o ponto final do nome absoluto. */
    readonly texto: string;
    /** Os quatro octetos, inclusive quando o IPv4 veio EMBUTIDO num literal IPv6. */
    readonly octetos: readonly number[] | undefined;
    /** Os oito grupos de 16 bits, quando o host é um literal IPv6. */
    readonly grupos: readonly number[] | undefined;
}
/**
 * A forma canônica do host que o `URL` do Node entregou.
 *
 * O ponto final do nome absoluto cai aqui, e não numa regex a mais: `x.internal`
 * e `x.internal.` são o MESMO nome para o resolvedor, e só um deles casava.
 * @param hostname - o `hostname` de um `URL`, com ou sem colchetes.
 * @returns a forma canônica, com os octetos ou grupos quando é literal de endereço.
 */
export declare function hostCanonico(hostname: string): HostCanonico;
/** As faixas IPv4 que, de dentro de um servidor, alcançam o que ninguém publicou. */
export declare function ipv4Bloqueado(octetos: readonly number[]): boolean;
/** As faixas IPv6 que não são endereço público, fora do loopback, que é suportado de propósito. */
export declare function ipv6Bloqueado(grupos: readonly number[]): boolean;
/**
 * Se este host é loopback DE VERDADE.
 *
 * `localhost` exato e `127.0.0.0/8` são; `*.localhost` NÃO é — aquilo é um nome,
 * e `attacker.example.localhost` aponta para onde o resolvedor quiser. O IPv4
 * mapeado (`::ffff:127.0.0.1`) É loopback e não era reconhecido: o produto o
 * tratava como endereço externo, o que dava o piso de política errado.
 * @param host - a forma canônica.
 * @returns `true` quando o endereço alcança apenas esta máquina.
 */
export declare function hostLoopback(host: HostCanonico): boolean;
/**
 * Se este host é destino proibido para uma integração.
 * @param host - a forma canônica.
 * @returns `true` quando o endereço alcança a rede interna de quem hospeda.
 */
export declare function hostBloqueado(host: HostCanonico): boolean;
//# sourceMappingURL=host.d.ts.map