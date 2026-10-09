import { type ProvisionAndActivateResult } from './runtime-activation.js';
import { type BuilderRuntimeScopeId } from './runtime-scope.js';
import { type BuilderProvisionRequest } from './store-provision.js';
import { type BuilderSupervisorRootPolicy } from './supervisor-config.js';
/**
 * O INSTALADOR DO CONSTRUTOR — o fio entre as quatro peças que já existiam.
 *
 * ## Por que ele existe
 *
 * A jornada real parou em `BLOCKED_EXTERNAL` no passo `build`, em zero
 * milissegundo, porque o supervisor de construção não estava provisionado. As
 * peças existiam todas — o manifesto do store, o provisionamento da
 * configuração, a ativação no registro do gerente e o próprio gerente — e o
 * README do supervisor dizia com todas as letras que nenhuma delas "provisiona
 * volume Docker nem torna o serviço ativo". Faltava quem as ligasse.
 *
 * Este arquivo não reimplementa nenhuma delas:
 *
 * - o manifesto sai do MESMO percurso que o provisionamento confere
 *   (`inspectTemplateStoreSourceTree`);
 * - o hash da política sai da MESMA função que o adaptador atesta
 *   (`builderPolicySha256`);
 * - provisionar e ativar é `provisionAndActivateBuilderRuntime`, que já era
 *   reexecutável e já recuperava instalação interrompida;
 * - o volume do store é materializado pelo PRÓPRIO gerente ao subir o escopo.
 *
 * O que é dele: validar antes de começar, criar as raízes privadas, gerar o
 * manifesto, subir o gerente uma vez só, esperar o socket e registrar o que
 * criou. Tudo reexecutável — rodar duas vezes não duplica nada.
 */
/** Os códigos de recusa do instalador. Cada um tem teste. */
export type InstaladorErroCodigo = 'DIGEST_INVALIDO' | 'IMAGEM_AUSENTE' | 'STORE_AUSENTE' | 'RAIZ_INSEGURA' | 'MANIFESTO_DIVERGENTE' | 'PROVISIONAMENTO_RECUSADO' | 'GERENTE_NAO_SUBIU' | 'SOCKET_NAO_RESPONDEU';
export declare class InstaladorError extends Error {
    readonly code: InstaladorErroCodigo;
    readonly detalhe?: string | undefined;
    constructor(code: InstaladorErroCodigo, detalhe?: string | undefined);
}
/** O que o instalador precisa saber. */
export interface InstaladorOpcoes {
    readonly raizes: BuilderSupervisorRootPolicy;
    /** Onde ficam o manifesto gerado e a identidade da instalação — FORA das raízes. */
    readonly diretorioDaInstalacao: string;
    readonly storeDir: string;
    readonly versaoDoStore: string;
    readonly digestFixado: string;
    readonly tenantId: string;
    readonly instanceId: string;
}
/** O que o instalador faz fora de si: cada efeito é injetável, e tem dublê. */
export interface InstaladorDependencias {
    readonly imagemExiste: (digest: string) => Promise<boolean>;
    readonly provisionarEAtivar: (request: BuilderProvisionRequest) => Promise<ProvisionAndActivateResult>;
    /** O gerente já está de pé para este registro? */
    readonly gerenteVivo: (registroReferencia: string) => Promise<boolean>;
    readonly iniciarGerente: (registroReferencia: string) => Promise<{
        readonly pid: number;
    }>;
    readonly socketExiste: (caminho: string) => Promise<boolean>;
    readonly esperar: (ms: number) => Promise<void>;
    readonly uid: () => number;
}
/** O que foi feito, para o diário e para quem chamou. */
export interface ResultadoDaInstalacao {
    readonly escopo: BuilderRuntimeScopeId;
    readonly instalacaoId: string;
    readonly manifesto: {
        readonly caminho: string;
        readonly sha256: string;
        readonly treeSha256: string;
        readonly criado: boolean;
    };
    readonly politicaSha256: string;
    readonly provisionamento: ProvisionAndActivateResult['provision']['state'];
    readonly ativacao: string;
    readonly gerente: 'INICIADO' | 'JA_ESTAVA_DE_PE';
    readonly socket: string;
    readonly raizesCriadas: readonly string[];
}
/**
 * Quanto o instalador espera o socket do escopo aparecer, no total.
 *
 * É o MESMO orçamento que o gerente dá à partida de um escopo: antes do
 * socket, ele materializa o store no volume (até 10 min) e confere a imagem
 * (até 8 min). Eram 120 s, e na primeira instalação real o instalador desistiu
 * com `SOCKET_NAO_RESPONDEU` enquanto o gerente ainda copiava os 560 MB do
 * store — a espera menor que o trabalho transformava lentidão em falha.
 */
export declare const ESPERA_DO_SOCKET_MS: number;
export declare const PASSO_DA_ESPERA_MS = 1000;
/**
 * Instala o construtor, ou confere que ele já está instalado.
 * @param opcoes - o que instalar.
 * @param dependencias - os efeitos.
 * @returns o que foi feito.
 */
export declare function instalarConstrutor(opcoes: InstaladorOpcoes, dependencias: InstaladorDependencias): Promise<ResultadoDaInstalacao>;
/**
 * Cria as raízes que faltam, 0700, e confere as que existem.
 * @param raizes - a política de raízes.
 * @param uid - o usuário que instala.
 * @returns as raízes que ESTA execução criou.
 */
export declare function prepararRaizes(raizes: BuilderSupervisorRootPolicy, uid: number): Promise<readonly string[]>;
/**
 * Gera o manifesto do store pelo percurso do provisionamento.
 *
 * NUNCA sobrescreve um manifesto diferente: se o arquivo já existe com outro
 * conteúdo, o store mudou desde a última instalação, e trocar o manifesto em
 * silêncio seria trocar a autoridade do que o construtor aceita.
 * @param storeDir - o store.
 * @param versao - a versão declarada do store.
 * @param destino - onde gravar.
 * @returns o caminho, o hash dos bytes e o hash da árvore.
 */
export declare function gerarManifesto(storeDir: string, versao: string, destino: string): Promise<ResultadoDaInstalacao['manifesto']>;
/**
 * A identidade ESTÁVEL desta instalação: gerada uma vez, e relida depois.
 *
 * Sem ela, cada execução derivaria outro escopo — outro socket, outro volume,
 * outra configuração — e reexecutar duplicaria a instalação em vez de
 * conferi-la.
 * @param destino - onde ela mora.
 * @returns 64 hexadecimais.
 */
export declare function identidadeDaInstalacao(destino: string): Promise<string>;
/**
 * As raízes de DESENVOLVIMENTO do construtor, debaixo de uma base só.
 *
 * As de produção moram em `/etc`, `/run`, `/srv` e `/var/lib` e exigem
 * administrador. A instalação de quem baixou o FRIGG na própria máquina fica
 * debaixo de uma pasta DELA — e a mesma função serve ao instalador, que cria,
 * e ao produto, que procura. Duas cópias desta lista divergiriam no primeiro
 * nome trocado, e o produto procuraria o construtor onde ele não está.
 * @param base - a pasta de base, absoluta.
 * @param dockerSocketPath - o socket do Docker desta máquina.
 * @returns a política de raízes.
 */
export declare function raizesDoConstrutorEm(base: string, dockerSocketPath?: string): BuilderSupervisorRootPolicy;
//# sourceMappingURL=installer.d.ts.map