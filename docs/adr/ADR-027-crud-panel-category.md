# ADR-027 — Categoria painel CRUD

- Estado: Aceita
- Data: 2026-09-03
- Ressalva: implementada como BETA no bloco 6 da fatia 2

O identificador físico é `crud-panel`. Na interface, a pessoa escolhe “um
painel para minha equipe criar, editar e excluir cadastros”. O painel sempre
usa o acesso do ADR-024 e não oferece rota pública de dados.

O Studio gera ações de criar, atualizar e excluir, componentes de gestão e a
confirmação de exclusão. Essas partes consomem os repositórios do ADR-023,
exigem sessão e CSRF e entram na foto de integridade antes de o modelo escrever
layout ou texto. O modelo pode compor o painel, mas não alterar a regra de
acesso ou as ações.

Referências entre entidades estão recusadas nesta versão. Expor um campo de ID
técnico para uma pessoa leiga seria inseguro; a categoria só aceitará relações
quando existir um seletor com autorização e rótulos compreensíveis.

O critério executável abre o aplicativo sem sessão, confirma 401, entra com
código, lista registros, cria um item, edita o mesmo item e só o exclui depois
de confirmação no navegador. O golden set executa três painéis, incluindo um
caso sensível com CPF e informação financeira já confirmados no intake.

Isso não é um portal SaaS: não há espaço separado por cliente final, cobrança,
passkey, preview nem publicação. Esses itens mantêm seus estados próprios.
