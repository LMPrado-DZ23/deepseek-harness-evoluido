# Fatia — OS-107: a quinta causa da CI era a própria suíte mudando a árvore

## 1. A causa

Com a suíte de PostgreSQL corrigida (OS-105), a CI chegou ao último passo do job
Linux e reprovou ali:

```
Refuse unexpected build mutations
diff --git a/apps/studio-web/capturas/10-biblioteca.png ...
Binary files a/... and b/... differ
```

`capturas.spec.ts` escreve os PNGs da entrega dentro de `apps/studio-web/capturas/`,
que é **versionado de propósito** — as capturas acompanham o commit e são a
prova da versão nova, porque a decisão do proprietário proíbe reaproveitar
captura antiga. Só que a CI roda a mesma suíte, e um PNG é diferente a cada
execução: antialiasing, cursor, um pixel de fonte. A árvore mudava sozinha, e o
passo que protege a árvore reprovava — **com razão**.

## 2. A correção não desliga nem a captura nem a guarda

`DZ23_CAPTURAS=sim` diz que aquela execução é ENTREGA e o PNG vai para
`capturas/`. Sem a variável — o caso da CI — a jornada roda inteira e a captura
cai na pasta de resultados do Playwright, que não é versionada.

A prova de percurso continua existindo na CI; a mutação da árvore acabou.
Conferido aqui: `git status` limpo depois de rodar o projeto `gravacao` sem a
variável.

**Esta é a quinta causa de CI desta sequência, e a terceira da mesma família:**
o que passava aqui e reprovava lá era sempre o ambiente de quem roda — o
navegador (OS-104), a variável do operador (OS-105) e agora a pasta de saída.

## 3. O cabeçalho de conta nas Preferências

F04 mostra a conta no alto da coluna esquerda. Entrou: avatar com as iniciais
reais da sessão e o nome. **Não** entrou o campo de busca da referência — não há
serviço de busca, e um campo que não busca é o botão mudo que a fatia anterior
recusou.

## 4. As capturas da entrega

Catorze, do build deste commit, incluindo duas novas: `13-preferencias-conta`
(uma seção que funciona) e `14-preferencias-pendencia` (uma que declara o que
falta). A segunda é a que prova que não há botão mudo.

**Limitação da prova, de novo e por escrito:** o construtor é DUBLÊ. As capturas
provam interface e integração com o servidor de teste; não provam geração com
IA real (`EB-04`) nem o perfil Cordis.
