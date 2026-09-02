# ADR-006 — Identidade fina com passkeys e código temporário

- Status: Aceito
- Data: 2026-09-02
- Escopo: P29-A do DZ23 STUDIO

## Contexto

O DZ23 STUDIO é destinado também a pessoas leigas. Senhas permanentes criariam
recuperação, armazenamento e risco de phishing. Um IdP completo adicionaria um
serviço operacional antes de existir necessidade comprovada.

## Decisão

O Studio mantém uma camada fina de identidade própria:

- passkeys WebAuthn são o mecanismo principal;
- código numérico temporário por e-mail é o fallback e nunca prova identidade
  forte;
- OIDC não faz parte do P29-A e poderá ser apenas um provedor adicional;
- não existem senhas;
- no modo pessoal, somente em `127.0.0.1` e antes do primeiro cadastro, a pessoa
  recebe a identidade canônica `org_local`/`tenant_local` sem tela de login;
- qualquer bind não loopback exige identidade e um provedor real de e-mail;
- o capturador de e-mail em memória existe apenas para desenvolvimento/teste,
  nunca escreve código ou link em log e é recusado no modo servidor.

O servidor WebAuthn usa `@simplewebauthn/server` 13.3.2, versão que contém a
correção de validação de cadeia de confiança publicada no advisory
GHSA-6hxq-p678-4hr2. O cliente de navegador ainda é `NOT_PRESENT`; por isso uma
cerimônia com autenticador físico não foi reivindicada nesta fatia.

## Consequências

O login fica simples e resistente a phishing sem operar um IdP. A entrega de
e-mail real permanece `NOT_CONFIGURED` até o proprietário escolher/configurar
SMTP por referência de segredo. Login social permanece fora do escopo.
