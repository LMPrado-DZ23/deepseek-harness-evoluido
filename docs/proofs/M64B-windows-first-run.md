# M6.4-B — primeiro acesso e segredos no Windows

## Escopo

Fatia isolada sobre `a685301`. Foram adicionados somente:

- `deploy/windows/New-Dz23Secrets.ps1`;
- `deploy/windows/secrets.env.example`;
- `tests/m6/windows-secrets.test.mjs`;
- este guia e `docs/guides/windows-first-run.md`.

Nenhum Compose, módulo comum do lifecycle, builder-supervisor ou
Prompt-to-App foi alterado.

## Contrato implementado

- modo interativo e não interativo;
- perfis `local`, `tailscale` e `public` com host, origem e RP ID derivados de
  uma única entrada, evitando combinações divergentes;
- SMTP real obrigatório porque `docker-compose.yml` e
  `deploy/harness/edge.patch.yml` o exigem;
- somente SMTP com TLS implícito; `STARTTLS` é recusado até o consumidor poder
  exigir TLS sem downgrade;
- senha SMTP recebida como `SecureString` ou stdin, nunca como parâmetro texto;
- `wsl.exe` executado sem shell intermediário, com argumentos separados;
- Linux iniciado com `env -i`; payload somente pelo stdin;
- segredos de borda e PostgreSQL gerados em `/dev/urandom` dentro do WSL2;
- destino restrito à pasta pessoal Linux em ext2/ext3/ext4, fora de `/mnt/*`;
- criação segura do destino padrão em HOME limpo; caminhos personalizados não
  criam uma cadeia de diretórios;
- diretório `0700`, arquivo `0600`, arquivo temporário e `mv` atômico;
- lock exclusivo por destino, revalidação de filesystem e `device:inode` após
  o lock, antes do backup e imediatamente antes do commit;
- overwrite fechado por padrão, com backup exclusivo `0600` da versão travada;
- resumo mascarado e sem contato de rede.

Não existe variável separada de segredo de sessão no Compose atual. O
assistente não inventou uma: ele gera `DZ23_EDGE_SECRET`; sessões continuam sob
o mecanismo já existente do plugin de identidade.

## Gates

| Gate | Resultado |
|---|---|
| Parser PowerShell | `PASS` |
| Testes adversariais `windows-secrets.test.mjs` | **12/12 PASS** no Windows 11 + WSL2 Ubuntu |
| Prova WSL2 ext4, permissões, entropia e atomicidade | `PASS` na distribuição `Ubuntu` |
| Dry-run sem arquivo e sem geração | `PASS` |
| Saída e PowerShell transcript sem a senha recebida por stdin | `PASS` |
| Varredura direta dos cinco arquivos: chave privada e padrões comuns de credencial | `PASS`, zero achado; fixtures são valores sintéticos, não credenciais reais |
| Gate P37/licenças | `NOT_PRESENT` nesta base isolada; deve rodar na integração antes de redistribuir |
| Portabilidade com self-test negativo | `PASS`, zero achado |
| Whitespace direto dos cinco arquivos e parser Node | `PASS` |
| Diff limitado aos cinco arquivos autorizados | `PASS` |
| `third_party/**` | zero diff |

Os testes reais criaram somente diretórios descartáveis sob
`/home/<usuario>/.config/dz23-m64b-<uuid>` e os removeram ao final. Nenhum
segredo da prova foi impresso. O teste de overwrite confirmou backup com modo
`0600`, conteúdo idêntico ao arquivo anterior e novos segredos independentes.

A concorrência entre duas instâncias oficiais e a troca de inode por uma
injeção controlada são cobertas. O teste de filesystem não ext usa retorno
`tmpfs` injetado no runner sob `DZ23_M64B_TEST_MODE=1`; montar um tmpfs real na
distribuição não foi necessário e permanece `NOT_EXECUTED`. Essas fixtures e a
senha SMTP usada nos testes são deliberadamente sintéticas, nunca credenciais
reais.

## Limites honestos

- nenhum Docker foi iniciado;
- nenhuma rede, DNS, porta, ACL ou certificado foi configurado;
- SMTP foi validado apenas estruturalmente; envio real: `NOT_EXECUTED`;
- um processo hostil já comprometido com o mesmo UID Linux está fora do modelo
  de ameaça, pois já possui acesso de leitura ao segredo do usuário;
- Tailscale, domínio público, ACME e celular físico: `NOT_EXECUTED`;
- o perfil local depende do Compose local e ainda não é selecionado pelo
  `install.ps1`;
- término abrupto por `SIGKILL`/encerramento forçado pode deixar o diretório de
  lock; a recuperação assistida desse caso ainda é `NOT_PRESENT` e o lock não
  deve ser apagado manualmente sem confirmar que nenhuma instância está viva;
- instalação/update/rollback/uninstall reais no Windows: `NOT_EXECUTED`;
- a experiência para pessoas leigas permanece `NOT_VALIDATED` até a fase 0.5.
