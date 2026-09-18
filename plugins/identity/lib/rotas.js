import { assertRouteContracts } from '@dz23-studio/policy';
/**
 * Onde o servidor monta a identidade.
 *
 * Este endereço já morava escrito à mão em três lugares — no registro da rota,
 * na fatia que descobre qual rota foi pedida e na lista de caminhos que a
 * remoção de cookie sombra alcança. Três cópias do mesmo fato divergem no
 * primeiro conserto de uma delas, e a que diverge em silêncio é justamente a
 * que ninguém lê. Agora ele existe UMA vez.
 */
export const BASE_DA_IDENTIDADE = '/api/studio/identity';
export const IDENTITY_ROUTE_CONTRACTS = [
    { method: 'POST', path: '/magic/start', access: 'public', permission: null, scope: 'none' },
    { method: 'POST', path: '/magic/verify', access: 'public', permission: null, scope: 'none' },
    { method: 'POST', path: '/passkey/login/options', access: 'public', permission: null, scope: 'none' },
    { method: 'POST', path: '/passkey/login/verify', access: 'public', permission: null, scope: 'none' },
    { method: 'GET', path: '/session', access: 'public', permission: null, scope: 'identity' },
    { method: 'GET', path: '/csrf', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'GET', path: '/harness/session', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'POST', path: '/logout', access: 'public', permission: null, scope: 'identity' },
    { method: 'POST', path: '/passkey/register/options', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'POST', path: '/passkey/register/verify', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'POST', path: '/passkey/step-up/options', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'POST', path: '/passkey/step-up/verify', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'GET', path: '/devices', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'POST', path: '/devices/revoke', access: 'authorized', permission: 'identity.self', scope: 'identity' },
    { method: 'POST', path: '/devices/revoke-all', access: 'authorized', permission: 'identity.self', scope: 'identity' },
];
assertRouteContracts(IDENTITY_ROUTE_CONTRACTS);
/**
 * Todo caminho de cookie que ALCANÇA um endereço servido.
 *
 * A regra do navegador não é prefixo de texto: um cookie gravado com
 * `Path=P` viaja para um pedido `R` quando `P` é igual a `R`, ou quando `P` é
 * prefixo de `R` e a fronteira cai numa barra. Então o conjunto de caminhos
 * que um atacante pode escolher e ainda assim atingir o produto é FINITO, e é
 * exatamente este: cada fronteira de barra de cada rota servida, mais a rota
 * inteira. Um plantio fora dele não é enviado para rota nenhuma — ele não
 * tranca ninguém, e por isso não precisa ser apagado.
 * @param base - onde a identidade está montada.
 * @param rotas - os caminhos das rotas, relativos à base.
 * @returns os caminhos, sem repetição e em ordem estável.
 */
export function caminhosAlcancaveis(base, rotas) {
    const todos = new Set();
    for (const rota of rotas) {
        const partes = [base, rota].join('').split('/').filter(parte => parte !== '');
        todos.add('/');
        const subidas = [];
        for (const parte of partes) {
            subidas.push(parte);
            todos.add(['', ...subidas].join('/'));
        }
    }
    return [...todos].sort();
}
