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
export const FORMAS = ['IPV4', 'IPV6', 'NOME'];
/** Prefixos que carregam um IPv4 dentro de um IPv6, e por isso alcançam o que aquele IPv4 alcança. */
function ipv4Embutido(grupos) {
    const zerosIniciais = grupos.slice(0, 5).every(grupo => grupo === 0);
    // ::ffff:a.b.c.d (mapeado) e ::a.b.c.d (compatível, obsoleto mas ainda roteado por pilhas antigas).
    const mapeado = zerosIniciais && (grupos[5] === 0xffff || grupos[5] === 0);
    // 64:ff9b::/96 e 64:ff9b:1::/48 são o prefixo NAT64 bem conhecido: o tradutor entrega no IPv4.
    const nat64 = grupos[0] === 0x0064 && grupos[1] === 0xff9b;
    if (!mapeado && !nat64)
        return undefined;
    const alto = grupos[6];
    const baixo = grupos[7];
    const octetos = [alto >> 8, alto & 0xff, baixo >> 8, baixo & 0xff];
    // `::` e `::1` não são "o IPv4 0.0.0.1": são o endereço não especificado e o loopback,
    // e tratá-los como IPv4 mandaria `::1` para a faixa 0.0.0.0/8, que é BLOQUEADA — o
    // loopback deixaria de ser suportado, que é função de propósito neste produto.
    if (mapeado && grupos[5] === 0 && alto === 0 && baixo <= 1)
        return undefined;
    return octetos;
}
function lerIpv6(texto) {
    if (!texto.includes(':'))
        return undefined;
    const [esquerda, direita, excedente] = texto.split('::');
    if (excedente !== undefined)
        return undefined;
    const partes = (lado) => (lado === '' ? [] : lado.split(':'));
    const cabeca = partes(esquerda ?? '');
    const cauda = direita === undefined ? [] : partes(direita);
    const converter = (lista, ate, terminaOEndereco) => {
        const saida = [];
        for (let indice = 0; indice < ate; indice++) {
            const parte = lista[indice];
            if (parte.includes('.')) {
                // Só o último grupo DO ENDEREÇO INTEIRO pode ser um IPv4 escrito por
                // extenso. Testar "último da metade" aceitava `1.2.3.4::1`, onde o IPv4
                // está no COMEÇO — e aí os 32 bits finais, que são o que decide se há
                // IPv4 embutido, seriam outros.
                if (!terminaOEndereco || indice !== ate - 1)
                    return undefined;
                const octetos = lerIpv4(parte);
                if (octetos === undefined)
                    return undefined;
                saida.push((octetos[0] << 8) | octetos[1], (octetos[2] << 8) | octetos[3]);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/u.test(parte))
                return undefined;
            saida.push(Number.parseInt(parte, 16));
        }
        return saida;
    };
    const frente = converter(cabeca, cabeca.length, direita === undefined);
    const fundo = converter(cauda, cauda.length, true);
    if (frente === undefined || fundo === undefined)
        return undefined;
    if (direita === undefined) {
        if (frente.length !== 8)
            return undefined;
        return frente;
    }
    // A compressão `::` tem de representar PELO MENOS um grupo zero: `1:2:3:4:5:6:7::8`
    // já traz oito, e aceitá-lo produziria nove.
    if (frente.length + fundo.length > 7)
        return undefined;
    const grupos = [...frente, ...Array(8 - frente.length - fundo.length).fill(0), ...fundo];
    return grupos;
}
function lerIpv4(texto) {
    const partes = texto.split('.');
    if (partes.length !== 4)
        return undefined;
    const octetos = [];
    for (const parte of partes) {
        if (!/^(0|[1-9][0-9]{0,2})$/u.test(parte))
            return undefined;
        const valor = Number.parseInt(parte, 10);
        if (valor > 255)
            return undefined;
        octetos.push(valor);
    }
    return octetos;
}
/**
 * A forma canônica do host que o `URL` do Node entregou.
 *
 * O ponto final do nome absoluto cai aqui, e não numa regex a mais: `x.internal`
 * e `x.internal.` são o MESMO nome para o resolvedor, e só um deles casava.
 * @param hostname - o `hostname` de um `URL`, com ou sem colchetes.
 * @returns a forma canônica, com os octetos ou grupos quando é literal de endereço.
 */
export function hostCanonico(hostname) {
    const semColchetes = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
    const grupos = lerIpv6(semColchetes);
    if (grupos !== undefined) {
        return { forma: 'IPV6', texto: semColchetes, grupos, octetos: ipv4Embutido(grupos) };
    }
    const octetos = lerIpv4(semColchetes);
    if (octetos !== undefined)
        return { forma: 'IPV4', texto: semColchetes, octetos, grupos: undefined };
    const semPontoFinal = semColchetes.length > 1 && semColchetes.endsWith('.') ? semColchetes.slice(0, -1) : semColchetes;
    return { forma: 'NOME', texto: semPontoFinal, octetos: undefined, grupos: undefined };
}
/** As faixas IPv4 que, de dentro de um servidor, alcançam o que ninguém publicou. */
export function ipv4Bloqueado(octetos) {
    const [a, b] = [octetos[0], octetos[1]];
    if (a === 0)
        return true; // 0.0.0.0/8
    if (a === 10)
        return true; // RFC 1918
    if (a === 100 && b >= 64 && b <= 127)
        return true; // 100.64/10 — CGNAT, e metadados de nuvem
    if (a === 169 && b === 254)
        return true; // link-local, o serviço de metadados clássico
    if (a === 172 && b >= 16 && b <= 31)
        return true; // RFC 1918
    if (a === 192 && b === 0 && octetos[2] === 0)
        return true; // 192.0.0/24 — atribuições de protocolo
    if (a === 192 && b === 168)
        return true; // RFC 1918
    if (a === 198 && (b === 18 || b === 19))
        return true; // 198.18/15 — bancada de teste
    if (a >= 224)
        return true; // multicast e reservado, inclusive 255.255.255.255
    return false;
}
/** As faixas IPv6 que não são endereço público, fora do loopback, que é suportado de propósito. */
export function ipv6Bloqueado(grupos) {
    const primeiro = grupos[0];
    if (grupos.every(grupo => grupo === 0))
        return true; // :: — não especificado
    if ((primeiro & 0xffc0) === 0xfe80)
        return true; // fe80::/10 — link-local INTEIRO, não só `fe80:`
    if ((primeiro & 0xfe00) === 0xfc00)
        return true; // fc00::/7 — único local
    if ((primeiro & 0xff00) === 0xff00)
        return true; // ff00::/8 — multicast
    return false;
}
/** Sufixos de NOME que não são a própria máquina nem a internet: quem controla o resolvedor decide. */
const NOMES_BLOQUEADOS = ['.localhost', '.internal', '.local'];
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
export function hostLoopback(host) {
    if (host.octetos !== undefined)
        return host.octetos[0] === 127;
    if (host.forma === 'IPV6')
        return host.grupos.slice(0, 7).every(grupo => grupo === 0) && host.grupos[7] === 1;
    return host.texto === 'localhost';
}
/**
 * Se este host é destino proibido para uma integração.
 * @param host - a forma canônica.
 * @returns `true` quando o endereço alcança a rede interna de quem hospeda.
 */
export function hostBloqueado(host) {
    if (hostLoopback(host))
        return false;
    if (host.octetos !== undefined)
        return ipv4Bloqueado(host.octetos);
    if (host.forma === 'IPV6')
        return ipv6Bloqueado(host.grupos);
    return NOMES_BLOQUEADOS.some(sufixo => host.texto.endsWith(sufixo));
}
