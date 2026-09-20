/**
 * O QUE O CONTÊINER DE EXPORTAÇÃO RODA, num texto que o teste executa de verdade.
 *
 * Ele morava numa string de uma linha dentro do adaptador, e por isso nenhum
 * teste o executava. O defeito que isso escondeu: a saída `standalone` do Next
 * montada com pnpm traz LINKS SIMBÓLICOS (`node_modules/react` →
 * `.pnpm/react@…/node_modules/react`; 28 num aplicativo mínimo, medido em
 * 20/09/2026). A cópia os preservava, o arquivo publicado recusa link — e com
 * razão —, e toda criação que PASSOU em tudo parava no fim com
 * `EXPORT_INVALID`, que a tela contava como `FINISH_INCONCLUSIVE`. Aconteceu
 * na primeira criação real com Ollama e de novo com a Mistral.
 *
 * Agora um link é SEGUIDO e o conteúdo copiado, desde que o destino real
 * fique DENTRO do mesmo item exportado (um link para fora — `/etc`, o store,
 * outro item — é recusa). Um ciclo é recusa, e não um laço sem fim.
 *
 * No item de TOPO, `isSymbolicLink()` é redundante de propósito: `lstat` de
 * um link nunca é diretório nem arquivo, então a outra metade já recusa. A
 * sabotagem que o remove sobrevive por isso; ele fica porque diz a regra.
 *
 * O programa é TEXTO, e não uma função serializada com `toString()`: o
 * transformador de TypeScript do ambiente pode injetar ajudantes (`__name`)
 * no corpo de uma função, e o contêiner não os tem — medido em 20/09/2026, o
 * programa gerado assim morria na primeira linha. O teste roda este mesmo
 * texto num `node` de verdade.
 */
const PROGRAMA = String.raw`
const fs = require('node:fs'); const p = require('node:path');
const entries = [['.next/standalone', true, true], ['.next/static', true, true], ['public', true, false], ['evidence/appspec-report.json', false, true]];
function copyTree(from, to, bound, chain) {
  const info = fs.lstatSync(from);
  if (info.isSymbolicLink()) {
    const real = fs.realpathSync(from);
    if (real !== bound && !real.startsWith(bound + p.sep)) throw new Error('EXPORT_SOURCE_INVALID');
    return copyTree(real, to, bound, chain);
  }
  if (info.isDirectory()) {
    const real = fs.realpathSync(from);
    if (chain.includes(real)) throw new Error('EXPORT_SOURCE_CYCLE');
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyTree(p.join(from, name), p.join(to, name), bound, chain.concat([real]));
    return;
  }
  if (info.isFile()) { fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL); return; }
  throw new Error('EXPORT_SOURCE_INVALID');
}
for (const [name, isDir, required] of entries) {
  const from = p.join(ROOT, name); const to = p.join(TARGET, name);
  if (!fs.existsSync(from)) { if (required) throw new Error('EXPORT_SOURCE_MISSING'); continue; }
  const info = fs.lstatSync(from);
  if (info.isSymbolicLink() || (isDir ? !info.isDirectory() : !info.isFile())) throw new Error('EXPORT_SOURCE_INVALID');
  fs.mkdirSync(p.dirname(to), { recursive: true });
  copyTree(from, to, fs.realpathSync(from), []);
}
`

/**
 * O programa do `node -e` para uma raiz e um destino. O teste roda ESTE
 * texto, e não a função: é o texto que o contêiner recebe.
 * @param raiz - de onde exportar.
 * @param destino - para onde.
 * @returns o programa.
 */
export function programaDeExportacao(raiz: string, destino: string): string {
  return `const ROOT = ${JSON.stringify(raiz)}; const TARGET = ${JSON.stringify(destino)};${PROGRAMA}`
}

/** O programa do `node -e` no contêiner de exportação. */
export const EXPORT_SCRIPT = programaDeExportacao('/workspace', '/export')
