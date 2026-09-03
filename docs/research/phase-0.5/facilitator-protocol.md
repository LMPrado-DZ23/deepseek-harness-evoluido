# Protocolo do facilitador

> **E4:** protocolo preservado como base metodológica. Não executar estas
> instruções do OmniSeek no gate final. Depois da fase 9, o preflight e os
> lançadores serão adaptados para o DZ23 STUDIO completo.

## Finalidade e duração

Cada sessão dura até 45 minutos. O objetivo é observar compreensão, não ensinar
o produto nem convencer a pessoa de que ele funciona.

## Antes da primeira sessão

1. Use um notebook de teste, sem projetos, documentos ou contas pessoais.
2. Use WSL2 com Python 3.12+, Docker disponível dentro do WSL2 e uma IA local
   já baixada e rodando em `localhost`.
3. Não configure chaves de nuvem, MCP, skills, conectores, mensageria, login
   social ou contas de deploy.
4. Confirme que o checkout separado do OmniSeek está limpo e exatamente em
   `d9a8109528839a9f6c691cab9d71f3fce7e91e02`.
5. Informe ao lançador o Python do ambiente P40 já auditado. O kit não instala
   dependências automaticamente porque ainda não existe lock/SBOM aprovado.
6. Execute o lançador com um identificador anônimo e confira o aviso permanente
   “Protótipo de pesquisa supervisionada — não é uma aplicação pronta e não
   faz deploy”. Se o aviso não aparecer, cancele a sessão.
7. Faça login antes de entregar o notebook. O participante não deve ver nem
   copiar o token administrativo local.
8. Feche outras abas, notificações e aplicativos.

## Início da sessão

1. Registre apenas `P01`, `P02`, `P03`, `P04` ou `P05`; não escreva nome,
   e-mail, telefone, CPF ou empresa.
2. Explique que o protótipo pode falhar, que nada será publicado e que a pessoa
   pode parar quando quiser.
3. Peça autorização específica antes de gravar áudio, vídeo ou tela. Quando
   houver gravação, use o termo de consentimento separado, identificado apenas
   como `P01` a `P05`, e guarde-o fora do diretório de dados do protótipo. Sem
   autorização, registre somente notas anônimas.
4. Leia o [`participant-card.md`](participant-card.md) literalmente.
5. Inicie o cronômetro e permaneça em silêncio.

## Durante a sessão

Registre o horário e a tela sempre que ocorrer um destes eventos:

- a pessoa fica parada por mais de 30 segundos;
- pede ajuda;
- volta para uma etapa anterior;
- recusa ou aprova uma ação;
- interpreta preview como aplicação publicada;
- vê uma mensagem de erro;
- tenta inserir dado pessoal ou credencial;
- o sistema usa linguagem que parece prometer algo não comprovado.

Se a pessoa tentar informar dado real, interrompa a digitação e peça um exemplo
fictício. Isso não conta como ajuda de interface; registre como intervenção de
segurança.

Não corrija termos, não indique onde clicar e não explique as cinco etapas. Se
for indispensável ajudar para a sessão continuar, use a menor instrução possível
e registre a frase exata.

## Perguntas finais, nesta ordem

1. “Conte com suas palavras o que aconteceu desde a sua ideia até esta tela.”
2. “Você publicaria isso para clientes agora? Por quê?”
3. “O que o sistema fez de verdade?”
4. “Que palavra, pergunta ou botão ficou confuso?”
5. “De 1 a 5, quanto você confiou no que viu?”
6. Somente agora: “O que ainda falta para isso poder ser usado por outras
   pessoas?”

Não cite as cinco etapas nem explique o significado de preview antes de
encerrar e registrar as respostas às cinco primeiras perguntas.

## Sessão válida ou inválida

Uma sessão é `VALID` quando o participante teve oportunidade de percorrer o
fluxo e responder às perguntas finais.

Use `INVALID_TECHNICAL` quando falta de IA local, Docker, travamento ou defeito
de ambiente impediu a observação. Não conte essa sessão no denominador; corrija
o ambiente e use uma nova execução identificada como `P01-R1`, preservando o
registro da tentativa.

Use `BLOCKED_SAFETY` para credencial coletada, ação externa, exposição de dado,
perda de arquivo ou linguagem enganosa crítica. Esse resultado bloqueia piloto
e release público até correção e nova rodada.

## Encerramento

1. Pare o servidor com `Ctrl+C`.
2. Confirme que não houve deploy, publicação, push ou chamada de provedor
   externo.
3. Preserve as notas anônimas e os artefatos que o participante autorizou.
4. Não reutilize o diretório de dados de um participante em outra sessão.
5. Não apague evidência de falha. Não grave por padrão; gravação consentida é
   apagada em até 30 dias, preservando somente resultados anônimos.
