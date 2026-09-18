/**
 * Onde o servidor monta a identidade.
 *
 * Este endereço já morava escrito à mão em três lugares — no registro da rota,
 * na fatia que descobre qual rota foi pedida e na lista de caminhos que a
 * remoção de cookie sombra alcança. Três cópias do mesmo fato divergem no
 * primeiro conserto de uma delas, e a que diverge em silêncio é justamente a
 * que ninguém lê. Agora ele existe UMA vez.
 */
export declare const BASE_DA_IDENTIDADE = "/api/studio/identity";
export declare const IDENTITY_ROUTE_CONTRACTS: readonly [{
    readonly method: "POST";
    readonly path: "/magic/start";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "POST";
    readonly path: "/magic/verify";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "POST";
    readonly path: "/passkey/login/options";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "POST";
    readonly path: "/passkey/login/verify";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "none";
}, {
    readonly method: "GET";
    readonly path: "/session";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "identity";
}, {
    readonly method: "GET";
    readonly path: "/csrf";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "GET";
    readonly path: "/harness/session";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/logout";
    readonly access: "public";
    readonly permission: null;
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/register/options";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/register/verify";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/step-up/options";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/passkey/step-up/verify";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "GET";
    readonly path: "/devices";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/devices/revoke";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}, {
    readonly method: "POST";
    readonly path: "/devices/revoke-all";
    readonly access: "authorized";
    readonly permission: "identity.self";
    readonly scope: "identity";
}];
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
export declare function caminhosAlcancaveis(base: string, rotas: readonly string[]): readonly string[];
//# sourceMappingURL=rotas.d.ts.map