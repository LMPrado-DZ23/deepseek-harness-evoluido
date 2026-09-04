# ADR-031 — Integration Hub v1: registro D16, SMTP por referência e pacote do protótipo (M5)

Status: aceita e implementada na etapa M5 (Claude). Numeração: a ADR-028 está
reservada à M1 (preview) do Codex.

## Contexto

O Plano Mestre v2 (D16, D17, cap. 4) pede um Integration Hub com integrações
declaradas por manifesto, tiers de aprovação T0–T3, segredos só por referência
e nenhum marketplace público antes de plugins assinados (ADR-009/ADR-013). A
pessoa leiga precisa de três coisas concretas nesta etapa: ligar o e-mail do
aplicativo gerado sem ver senha, saber se uma integração é confiável antes de
ligá-la, e levar o protótipo verificado consigo.

## Decisões

1. **Manifesto assinado, avaliação no servidor.** `plugins/integration-hub`
   avalia o manifesto (`schema_version: 1`, `id`, `name`, `version`, `kind`
   ∈ {`mcp`, `skill`, `webhook`}, `publisher`, `permissions`, `tier`,
   `endpoint?`, `signature?`) com chaves Ed25519 **públicas** dos publicadores
   (config `publisherKeys`, env `DZ23_HUB_PUBLISHER_KEYS`). A forma canônica
   assinada é o objeto **como enviado**, sem `signature`, sem defaults e sem
   `trim`, chaves em ordem de code point, JSON sem espaços, UTF-8 — cinco
   regras que qualquer biblioteca JSON reproduz. Resultado: `verified`,
   `unverified` (sem assinatura ou publicador sem chave) ou `invalid`
   (assinatura não confere → registro recusado e auditado).
2. **Tier efetivo = o mais restritivo (D16).** Piso por natureza: MCP externo,
   `network.outbound` e `email.send` nunca abaixo de **T2** (D16 exige "nunca
   abaixo de T1" para MCP externo; T2 é mais restritivo e cumpre "conflito →
   mais restritivo"); MCP local, webhook, `write.project` e `secrets.read`
   nunca abaixo de T1; tier ausente ou inválido → T2. **Qualquer coisa abaixo
   de `verified` é limitada a pelo menos T2**, independentemente do que o
   manifesto declare. No canal `stable` (padrão), uma integração não
   verificada **não pode ser ligada** (403 e evento de recusa); o canal `dev`
   (`DZ23_HUB_CHANNEL=dev`) permite ligar para desenvolvimento local e a
   interface avisa isso em palavras. `GET /integrations` devolve `channel` e
   `can_enable` decididos pelo servidor: a interface nunca adivinha política.
3. **SMTP do aplicativo gerado só por referência (D17).** A pessoa informa o
   **nome** do segredo no cofre (`^[A-Z][A-Z0-9_]{2,63}$`, ex.: `DZ23_APP_SMTP`);
   o Studio confere pelo seam `ctx.credentials` que ele existe e tem o formato
   `{host, port, secure, user, pass, from}`, e guarda **só o nome** na tabela
   `studio_integrations.integrations` (kind `smtp`, manifesto nulo, tier T2 por
   ser provedor externo). O kind `smtp` é reservado: um manifesto com esse
   kind é recusado. O teste de envio só existe quando o operador liga
   `DZ23_HUB_SMTP_TEST_ENABLED=1` depois de escolher o provedor (decisão do
   Prado em aberto); até lá responde `NOT_EXECUTED` com explicação. Erros do
   provedor nunca chegam crus à pessoa nem ao audit (só a classe do erro):
   mensagens de SMTP e de `JSON.parse` podem carregar trechos do segredo.
4. **Pacote do protótipo reproduzível e sem dados.** Só projeto em
   `VERIFIED_PROTOTYPE` com a última run `PASSED` cujos arquivos ainda existam.
   O ZIP (escritor/leitor próprio, sem dependência, timestamps fixos, bits
   Unix de tipo de arquivo) leva `app/**` do `.next/standalone`,
   `app/.next/static`, `app/public`, `evidence/appspec-report.json`, um
   `README.md` em linguagem comum e `.env.example` só com nomes. Ficam de fora:
   `data/` e caches **na raiz do app** (o `data/` de bibliotecas entra),
   `.env*`, `*.sqlite*`, `studio-capture.json`, `studio-auth-state.json`,
   `*.pem`, `*.key`, links simbólicos e `.git`. Orçamento de 200 MB → recusa em
   palavras (413). Mesma run e mesmos bytes → o mesmo registro é devolvido, sem
   arquivo gêmeo. Arquivo em `~/.dz23-studio/exports/<org>/<tenant>/` com 0600;
   o caminho nunca sai pela API; download com `Content-Disposition` saneado e
   `x-dz23-sha256`.
5. **Fronteira HTTP igual à do Prompt-to-App.** `/api/studio/hub` exige host e
   origem permitidos, sessão do Studio, CSRF em toda escrita, membro do espaço
   (`authorizationFor`) e permissão por rota (`HUB_ROUTE_CONTRACTS`, conferido
   por `assertRouteContracts` na subida). Só erros conhecidos levam sua
   mensagem ao cliente; qualquer outro vira uma frase fixa (nada de caminho,
   `ENOENT`, `URIError` ou texto de biblioteca).
6. **Auditoria também das recusas.** Tabela `studio_integrations.events`
   (org + tenant + ator): registro, ligação/desligamento, SMTP configurado e
   testado (`not-executed` incluso), pacote gerado — e as recusas: manifesto
   inválido, assinatura adulterada, kind reservado, exportação negada.
7. **Painel próprio em `/studio/hub`.** `apps/studio-web/src/hub/*`, roteado
   por `main.tsx` sem tocar em `App.tsx` (o Codex edita esse arquivo na M1),
   catálogo `src/i18n/hub.pt-BR.json`. Quatro cartões: e-mail do aplicativo,
   integrações, baixar o protótipo, histórico. Sem rede, o 503 do service
   worker vira frase do catálogo.
8. **Sem marketplace.** Não há catálogo remoto, busca nem instalação a partir
   da internet: estado `NOT_PRESENT` até haver plugins assinados e decisão do
   Prado sobre publicação (ADR-009/ADR-013).

## Consequências

- Domínio novo `studio_integrations` (versão 1) roteado para Postgres nos dois
  patches; gates `domain-scopes` e `domain-routes` passam com 21 domínios.
- O gate de i18n passou a varrer de fato os plugins (havia um bug que pulava
  todos); 19 literais pré-existentes de outros plugins ficam contados como
  pendência que não pode crescer.
- Pendências fora desta etapa: provedor de e-mail (Prado), exportação de um
  standalone real produzido pelo pipeline (integração com M1/fatia 3),
  licença do repositório (P37 aponta ausência de `license` em todos os
  plugins — decisão do Prado).
