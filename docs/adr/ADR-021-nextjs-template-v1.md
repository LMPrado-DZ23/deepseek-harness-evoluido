# ADR-021 — Template Next.js v1 fixado e offline

Status: aceito na fatia 2.

O template principal do Prompt-to-App é `templates/nextjs-app@1`, com Next.js
16.3.4 App Router, React 19.2.8, TypeScript estrito, Tailwind CSS 4.3.3, Zod,
React Hook Form, Vitest e Playwright com axe. O build produz saída
`standalone`. A fonte Geist vem do pacote local `geist` (SIL OFL); não há
Google Fonts nem requisição externa em runtime.

As versões são exatas e o lockfile passou pelas políticas de idade mínima da
cadeia de suprimentos. Pacotes publicados no mesmo dia foram recusados e
substituídos por versões maduras. O setup T2 baixa as dependências uma vez e
prepara `runtime/template-store-v2`; geração, instalação, build, teste e E2E
usam somente esse store, com `--offline`, lockfile congelado e scripts de
pacote desativados.

Cada comando roda em contêiner descartável com `NetworkMode=none`, usuário
não-root, raiz somente leitura, `CapDrop=ALL`, `no-new-privileges` e limites de
recursos. O `playwright.config.ts` inicia `next start` dentro do mesmo
contêiner do teste. A prova inspeciona a configuração Docker e tenta uma
conexão de saída, que deve falhar.

Os componentes em `src/components/ui` são cópias adaptadas e reduzidas do
registro oficial `new-york-v4` do shadcn/ui 4.20.1 (MIT); não há cliente do
registro ou download em runtime. A origem está registrada em
`SHADCN_PROVENANCE.md`.

O template estático do ADR-019 permanece apenas como fallback explícito de
manutenção. Erro de Next.js nunca provoca troca silenciosa de template.
