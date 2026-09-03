# Assistentes de código — explicação simples

Texto principal da interface:

> O assistente Codex vai trabalhar numa cópia separada do seu projeto. Você
> aprova antes de começar e aprova novamente antes de aplicar qualquer mudança.

Estados mostrados à pessoa:

- **Aguardando sua aprovação:** nada começou.
- **Trabalhando numa cópia:** seu projeto principal não está sendo alterado.
- **Proposta pronta:** veja os arquivos e aceite ou recuse.
- **Limite atingido:** o trabalho parou e nada foi aplicado.
- **Conflito encontrado:** seu arquivo mudou; o Studio não sobrescreveu nada.
- **Falha do assistente:** a cópia foi preservada para inspeção.

Para rotas de IA:

> A conexão com a inteligência artificial falhou. Nada foi aplicado; tente
> novamente ou escolha outra rota.

O produto não deve usar “pronto” para uma proposta ainda não aplicada e nunca
deve chamar preview, mock ou teste focado de aplicação terminada.

