# P37 — ui-ux-pro-max-skill

Inventário de referência externa, produzido ANTES de a skill entrar no
repositório, como o produto exige. Diferente dos outros seis inventários, este
terminou em cópia: a licença permite, e as obrigações dela foram cumpridas em
`dsh-home/skills/NOTICE`.

- projeto: ui-ux-pro-max — skill de inteligência de UI/UX com dados locais pesquisáveis (79 estilos, 192 paletas e perfis de raciocínio, 74 pares de fontes, 119 diretrizes de UX, 105 ícones, 17 presets GSAP, 25 tipos de gráfico, 22 pilhas de tecnologia), publicada por Next Level Builder
- url: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (declarada no campo `metadata.source` do próprio SKILL.md da cópia instalada)
- licenca: MIT
- evidencia_licenca: arquivo LICENSE da própria distribuição instalada, lido em 2026-09-08 — texto integral da MIT com "Copyright (c) 2024 Next Level Builder". A API pública do GitHub respondeu 403 pelo proxy deste ambiente, então a evidência é o artefato distribuído, e não a página do repositório; NAO_VERIFICADO para o commit exato de origem — motivo: a distribuição instalada não carrega SHA de origem e a API do repositório não foi alcançável daqui.
- redistribuivel: sim — a MIT permite copiar, modificar e redistribuir, com a condição de manter o aviso de direito autoral e o texto da licença. Cumprido em dsh-home/skills/NOTICE e no LICENSE preservado junto da cópia.
- marcas: "ui-ux-pro-max" e "Next Level Builder" são nome e identidade de terceiro. A MIT NÃO concede direito de marca. Uso permitido: citar a origem, como este inventário e o NOTICE fazem. Uso proibido: apresentar a skill como produto DZ23, ou sugerir origem ou endosso.
- dependencias_e_lockfiles: a skill não tem lockfile nem dependência de tempo de execução própria — são 71 arquivos entre Markdown, CSV e JSON, mais scripts de consulta. Conteúdo transitivo: não se aplica.
- rede_filesystem_segredos: rede — nenhuma; os dados são locais e a skill não busca nada. Filesystem — leitura dos próprios arquivos de dados. Segredos — nenhum; a varredura de segredo deste repositório (gate:secrets) passa com a cópia dentro da árvore. NAO_VERIFICADO para o comportamento dos scripts de consulta sob entrada hostil — motivo: eles não foram executados com entrada adversária nesta rodada, e são lidos sob demanda pelo agente, não pelo produto em execução.
- cves_conhecidas: nenhuma CVE localizada para esta skill. Ausência de resultado em busca não é prova de ausência de vulnerabilidade — e, sendo dados e Markdown sem dependência executável no caminho do produto, a superfície é a leitura desses arquivos.
- sbom: não há SBOM próprio. O inventário funcional são os arquivos de proveniência que a própria skill traz: data/data-provenance.json (origem e data de verificação de cada registro), data/google-font-licenses.json (licença por família de fonte, com a revisão do repositório google/fonts) e data/phosphor-icons-upstream.json.
- sast: não executado sobre os scripts da skill — motivo objetivo: eles não entram no caminho de execução do produto; são consultados pelo agente durante o trabalho de interface. Os arquivos entram no alcance de gate:secrets e gate:no-caveman deste repositório, que passam com a cópia dentro da árvore.
- poc_isolado: não foi necessário PoC isolado — a skill é dado e texto, não código que o produto executa. O uso é a leitura pelo agente ao desenhar interface, que é exatamente o que ela existe para fazer.
- veredito: sim, pode copiar e usar — MIT com obrigações cumpridas (aviso de direito autoral e texto da licença preservados em dsh-home/skills/NOTICE e no LICENSE junto da cópia). Nenhuma marca de terceiro é usada, e nenhum arquivo de fonte ou de ícone de terceiro é redistribuído: o que existe são metadados e referências.
- data_da_consulta: 2026-09-08
