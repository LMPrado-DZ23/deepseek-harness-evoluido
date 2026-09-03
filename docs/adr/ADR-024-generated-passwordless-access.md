# ADR-024 — Acesso sem senha no aplicativo gerado

Status: aceito e implementado como BETA no bloco 6 da fatia 2.

Painéis CRUD e a consulta de qualquer lista de cadastros sempre exigem acesso.
Formulários comuns continuam aceitando envio anônimo; formulários com
informação sensível exigem acesso também para enviar.
O DZ23 STUDIO gera essa camada de modo determinístico; o modelo não escreve
autenticação, sessão, papéis, cookies, CSRF, migração ou entrega de código.

O primeiro proprietário é exclusivamente `APP_OWNER_EMAIL`. Ele pode convidar
membros, mas membros não podem convidar nem elevar o próprio papel. O acesso usa
um código aleatório de seis dígitos, válido por dez minutos e bloqueado depois
de cinco erros. Cada emissão recebe um `request_id` aleatório em cookie
`HttpOnly`; a verificação aceita apenas o código ligado ao navegador que o
pediu. Bloquear um pedido não bloqueia outro. Por e-mail, são permitidos no
máximo três códigos em quinze minutos, com intervalo mínimo de sessenta
segundos; excesso recebe a mesma resposta genérica. Códigos expirados são
limpos na emissão seguinte.
No banco, cada código usa sal aleatório e derivação `scrypt`; o valor em texto
aberto existe somente no canal de entrega.

A sessão usa segredo opaco de 256 bits, guarda somente o SHA-256 no SQLite e
expira em 14 dias. O cookie de sessão é `HttpOnly`, `Secure` e `SameSite=Lax`.
Operações de escrita também exigem o token CSRF aleatório presente no cookie
legível pelo cliente e no formulário. Logout revoga a sessão no servidor.

`APP_EMAIL_MODE=smtp` exige `APP_SMTP_URL` e `APP_EMAIL_FROM` por variável de
ambiente. `studio-capture` grava os códigos apenas no diretório de dados do
protótipo, com permissão 0600, e é recusado sem
`DZ23_STUDIO_VERIFICATION=1`. O gate isolado usa `NODE_ENV=production` e a flag
somente no arquivo protegido do Playwright. Produção e desenvolvimento sem a
flag têm testes negativos próprios.

O backend do Studio só devolve códigos capturados para o projeto autorizado
quando a execução e o projeto já estão verificados. A interface os apresenta
somente na tela Verificação e informa que os códigos da prova automática já
foram consumidos. Códigos novos e utilizáveis durante um preview dependem do
P34, que ainda não existe.

As provas cobrem owner e member, convite, sessão válida, expirada e revogada,
CSRF ausente, cinco tentativas isoladas por pedido, limite de emissão, modo de
captura fora do verificador e a rota de sessão respondendo 401 antes e 200
depois do login. Passkeys no aplicativo gerado permanecem `NOT_PRESENT` até
existir domínio real.

As migrações de acesso usam `auth_schema_migrations`; elas não avançam
`PRAGMA user_version`, reservado à camada de dados. Assim, uma versão de auth
não pode fazer uma futura migração de dados ser pulada.
