# M92 — a skill empacotada com o produto está VISÍVEL para o agente

## O que se afirma

A skill `ui-ux-pro-max` está dentro do repositório, montada no perfil e
**descoberta pelo agente da conversa em tempo de execução**, com a ferramenta
que permite abri-la.

Prova: `node scripts/prove-assistant-session-runtime.mjs`

```
"tools": 16,
"governedTools": 14,
"bundledSkill": "visible",
"status": "PASS"
```

## Por que a prova existe

Copiar a pasta para dentro do repositório e escrever uma linha no perfil
**não** faz a skill existir para quem usa o produto. Sem esta afirmação, a
skill pode estar no disco, listada no YAML, e mesmo assim invisível — e
ninguém saberia até alguém pedir por ela e não receber nada.

Foi exatamente o que aconteceu aqui, três vezes seguidas.

## O que a investigação encontrou

1. **A linha de host `skill-filesystem` está DESLIGADA de propósito.** O bundle
   upstream `dsh-web-app` desliga `skill-filesystem` e `tool-skill` no plano de
   host porque, nesta composição, quem faz a descoberta local de skills é o
   PRESET do agente. Configurar a linha de host no perfil do Studio não tinha
   efeito nenhum e ainda parecia ter: a entrada continuava `disabled: true` e a
   expressão `!!js` nem chegava a ser avaliada. A montagem foi para
   `dsh-home/.agent-presets/dz23-assistant/agent.cordis.yml`.

2. **`customSkillDirs` não serve para skill empacotada.** Toda raiz comum é
   lida pelo `ctx.fs`, que é o filesystem SANDBOXADO da sessão, e
   `$DSH_HOME/skills` fica fora do workspace. A raiz certa é `bundledSkillDir`:
   o upstream a marca `trustedHost` e a lê pelo Node, fora do sandbox.
   `includeDefaultRoots` continua verdadeiro — as skills que a pessoa tem na
   própria instalação não são apagadas por esta.

3. **A leitura da prova tem de ser no escopo do AGENTE.** O registro de skills
   é dividido em camadas por escopo. `ctx.skills.list({ cwd })` sem `scope` lê
   só a camada global, vazia por desenho nesta composição — a prova acusaria
   ausência onde há montagem correta. A prova lê como o `tool-skill` lê:
   `{ cwd, scope: agent }`.

4. **Descoberta não é uso.** Sem `tool-skill` no preset, o agente vê o nome no
   catálogo e não tem como abrir o corpo da skill. A prova afirma as duas
   coisas: `bundledSkill: "visible"` e a presença da ferramenta `skill` no
   catálogo do agente (`tools` foi de 15 para 16).

## Licença e marca

MIT, © 2024 Next Level Builder. A licença viaja junto da cópia em
`dsh-home/skills/ui-ux-pro-max/LICENSE`, e as obrigações estão em
`dsh-home/skills/NOTICE`. Inventário P37 em
`docs/inventory/p37/ui-ux-pro-max-skill.md`, exigido pelo portão
`scripts/check-p37-inventory.mjs` (`REQUIRED_SLUGS`), que reprova se o
inventário sumir.

Marca não é concedida por licença de software: o nome de quem escreveu
continua sendo de quem escreveu.
