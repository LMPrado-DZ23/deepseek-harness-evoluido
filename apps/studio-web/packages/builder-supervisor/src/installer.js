import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { posix } from 'node:path';
import { builderPolicySha256 } from './docker-adapter.js';
import { builderRuntimeRegistryPath } from './manager-registry.js';
import { DEFAULT_SLOT_STARTUP_TIMEOUT_MS } from './manager-timeouts.js';
import { provisionAndActivateBuilderRuntime } from './runtime-activation.js';
import { builderRuntimeSocketPath, deriveBuilderRuntimeScopeId } from './runtime-scope.js';
import { canonicalTemplateStoreManifestBytes, computeTemplateTreeSha256 } from './store-security.js';
import { BuilderProvisionError, inspectTemplateStoreSourceTree } from './store-provision.js';
import { validateBuilderSupervisorRootPolicy } from './supervisor-config.js';
export class InstaladorError extends Error {
    code;
    detalhe;
    constructor(code, detalhe) {
        super(detalhe === undefined ? code : `${code}: ${detalhe}`);
        this.code = code;
        this.detalhe = detalhe;
        this.name = 'InstaladorError';
    }
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
export const ESPERA_DO_SOCKET_MS = DEFAULT_SLOT_STARTUP_TIMEOUT_MS;
export const PASSO_DA_ESPERA_MS = 1_000;
/**
 * Instala o construtor, ou confere que ele já está instalado.
 * @param opcoes - o que instalar.
 * @param dependencias - os efeitos.
 * @returns o que foi feito.
 */
export async function instalarConstrutor(opcoes, dependencias) {
    // 1. PRÉ-CONDIÇÕES, antes do primeiro efeito. Nada é criado se uma delas faltar.
    if (!/^sha256:[a-f0-9]{64}$/u.test(opcoes.digestFixado))
        throw new InstaladorError('DIGEST_INVALIDO');
    validateBuilderSupervisorRootPolicy(opcoes.raizes);
    if (!(await dependencias.imagemExiste(opcoes.digestFixado)))
        throw new InstaladorError('IMAGEM_AUSENTE', opcoes.digestFixado);
    const store = await lstat(opcoes.storeDir).catch(() => undefined);
    if (store === undefined || !store.isDirectory())
        throw new InstaladorError('STORE_AUSENTE', opcoes.storeDir);
    // 2. RAÍZES PRIVADAS. Criadas 0700 quando faltam; as que existem são
    // CONFERIDAS, e nunca afrouxadas nem corrigidas: uma raiz de outro dono ou
    // aberta para o grupo é recusa, porque consertá-la seria mexer em algo que
    // não sabemos de quem é.
    const raizesCriadas = await prepararRaizes(opcoes.raizes, dependencias.uid());
    // 3. MANIFESTO, pelo percurso do provisionamento.
    await mkdir(opcoes.diretorioDaInstalacao, { recursive: true, mode: 0o700 });
    const manifesto = await gerarManifesto(opcoes.storeDir, opcoes.versaoDoStore, opcoes.diretorioDaInstalacao);
    const instalacaoId = await identidadeDaInstalacao(opcoes.diretorioDaInstalacao);
    // 4. POLÍTICA, pela conta do adaptador.
    const escopo = deriveBuilderRuntimeScopeId({ installationId: instalacaoId, tenantId: opcoes.tenantId, instanceId: opcoes.instanceId });
    const politicaSha256 = builderPolicySha256({
        imageDigest: opcoes.digestFixado, scopeId: escopo,
        templateStoreVersion: opcoes.versaoDoStore, templateStoreSha256: manifesto.treeSha256,
    });
    // 5. PROVISIONAR E ATIVAR — reexecutável por construção.
    let provisionado;
    try {
        provisionado = await dependencias.provisionarEAtivar({
            installationId: instalacaoId, tenantId: opcoes.tenantId, instanceId: opcoes.instanceId,
            sourceRoot: opcoes.storeDir, manifestReference: `file:${manifesto.caminho}`, manifestSha256: manifesto.sha256,
            imageDigest: opcoes.digestFixado, policySha256: politicaSha256, roots: opcoes.raizes,
        });
    }
    catch (erro) {
        // O código do provisionamento VIAJA: `ALREADY_PROVISIONED` com outra
        // imagem é substituição, e substituir exige decisão — não é este
        // instalador que decide.
        const codigo = erro instanceof BuilderProvisionError ? erro.code : erro.message;
        throw new InstaladorError('PROVISIONAMENTO_RECUSADO', codigo);
    }
    // 6. O GERENTE, uma vez só.
    const registro = `file:${builderRuntimeRegistryPath(opcoes.raizes)}`;
    let gerente = 'JA_ESTAVA_DE_PE';
    if (!(await dependencias.gerenteVivo(registro))) {
        try {
            await dependencias.iniciarGerente(registro);
        }
        catch (erro) {
            throw new InstaladorError('GERENTE_NAO_SUBIU', erro.message);
        }
        gerente = 'INICIADO';
    }
    // 7. O SOCKET do escopo. É ele que o produto usa — gerente de pé sem socket
    // não constrói nada.
    const socket = builderRuntimeSocketPath(opcoes.raizes.socketRoot, escopo);
    let esperado = 0;
    while (!(await dependencias.socketExiste(socket))) {
        if (esperado >= ESPERA_DO_SOCKET_MS)
            throw new InstaladorError('SOCKET_NAO_RESPONDEU', socket);
        await dependencias.esperar(PASSO_DA_ESPERA_MS);
        esperado += PASSO_DA_ESPERA_MS;
    }
    const resultado = {
        escopo, instalacaoId, manifesto, politicaSha256,
        provisionamento: provisionado.provision.state,
        ativacao: provisionado.activation.state,
        gerente, socket, raizesCriadas,
    };
    await registrarNoDiario(opcoes.diretorioDaInstalacao, resultado);
    return resultado;
}
/**
 * Cria as raízes que faltam, 0700, e confere as que existem.
 * @param raizes - a política de raízes.
 * @param uid - o usuário que instala.
 * @returns as raízes que ESTA execução criou.
 */
export async function prepararRaizes(raizes, uid) {
    const criadas = [];
    const diretorios = [raizes.configRoot, raizes.secretRoot, raizes.socketRoot, raizes.artifactRoot, raizes.exportRoot, raizes.stateRoot];
    for (const diretorio of diretorios) {
        const antes = await lstat(diretorio).catch(() => undefined);
        if (antes === undefined) {
            await mkdir(diretorio, { recursive: true, mode: 0o700 });
            criadas.push(diretorio);
        }
        const depois = await lstat(diretorio);
        if (!depois.isDirectory() || depois.isSymbolicLink() || depois.uid !== uid || (depois.mode & 0o077) !== 0) {
            throw new InstaladorError('RAIZ_INSEGURA', diretorio);
        }
    }
    return criadas;
}
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
export async function gerarManifesto(storeDir, versao, destino) {
    const entradas = await inspectTemplateStoreSourceTree(storeDir);
    const treeSha256 = computeTemplateTreeSha256(versao, entradas);
    const bytes = canonicalTemplateStoreManifestBytes({ version: 1, template_store_version: versao, tree_sha256: treeSha256, entries: entradas });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const caminho = posix.join(destino, `template-store-${versao}.manifest.json`);
    const existente = await readFile(caminho).catch(() => undefined);
    if (existente !== undefined) {
        if (!existente.equals(bytes))
            throw new InstaladorError('MANIFESTO_DIVERGENTE', caminho);
        return { caminho, sha256, treeSha256, criado: false };
    }
    await gravarSemSobrescrever(caminho, bytes);
    return { caminho, sha256, treeSha256, criado: true };
}
/**
 * A identidade ESTÁVEL desta instalação: gerada uma vez, e relida depois.
 *
 * Sem ela, cada execução derivaria outro escopo — outro socket, outro volume,
 * outra configuração — e reexecutar duplicaria a instalação em vez de
 * conferi-la.
 * @param destino - onde ela mora.
 * @returns 64 hexadecimais.
 */
export async function identidadeDaInstalacao(destino) {
    const caminho = posix.join(destino, 'installation-id');
    const existente = (await readFile(caminho, 'utf8').catch(() => '')).trim();
    if (/^[a-f0-9]{64}$/u.test(existente))
        return existente;
    // O detalhe é o CAMINHO, e não uma frase: o texto para a pessoa sai do
    // código do erro, onde a tradução mora.
    if (existente !== '')
        throw new InstaladorError('RAIZ_INSEGURA', caminho);
    const nova = randomBytes(32).toString('hex');
    await gravarSemSobrescrever(caminho, Buffer.from(`${nova}\n`));
    return nova;
}
async function gravarSemSobrescrever(caminho, bytes) {
    // `wx`: falha se o arquivo aparecer entre a leitura e a escrita, em vez de
    // escrever por cima de quem chegou primeiro.
    const alvo = await open(caminho, 'wx', 0o600);
    try {
        await alvo.writeFile(bytes);
    }
    finally {
        await alvo.close();
    }
}
async function registrarNoDiario(destino, resultado) {
    const registro = { em: new Date().toISOString(), ...resultado };
    const linha = JSON.stringify(registro) + '\n';
    await writeFile(posix.join(destino, 'instalacoes.jsonl'), linha, { flag: 'a', mode: 0o600 });
}
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
export function raizesDoConstrutorEm(base, dockerSocketPath = '/var/run/docker.sock') {
    if (!posix.isAbsolute(base) || base.includes('\0'))
        throw new InstaladorError('RAIZ_INSEGURA', base);
    return Object.freeze({
        configRoot: posix.join(base, 'config'),
        secretRoot: posix.join(base, 'secrets'),
        socketRoot: posix.join(base, 'run'),
        artifactRoot: posix.join(base, 'artifacts'),
        exportRoot: posix.join(base, 'exports'),
        stateRoot: posix.join(base, 'state'),
        dockerSocketPath,
    });
}
//# sourceMappingURL=installer.js.map