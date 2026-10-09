# Consolidação V7 — o que o pacote do titular manda, e onde isso mora aqui

**Pacote:** `DZ23-MASTER-EXECUCAO-INTEGRAL-20260917-V7.0.0`
**SHA-256 do MASTER:** `7805689a4886fc9afe3aa8cf3009f219d69b97981e2b3a69febfd5df705fe0d6`
— conferido nesta máquina, e o verificador do próprio pacote responde
`package_check=PASS` com 102 arquivos.

## 1. Esta consolidação é registrada UMA vez

O MASTER pede, na primeira ação, "registre a consolidação de escopo uma única
vez no Ledger/DAG existentes, preservando a base Coerente e todos os adendos".
É isto. O que ela **não** é:

- **não é um segundo banco de status.** O estado de cada entrega continua em
  `docs/MASTER_REQUIREMENTS_LEDGER.md` e `docs/status/TASK_DAG.md`. Duas
  descrições do mesmo fato divergem no primeiro conserto de uma delas — o
  defeito mais caro deste repositório, e o pacote proíbe criá-lo por escrito;
- **não é um reinício.** A branch é `integ`, o HEAD é o desta sessão, nada foi
  revertido, e nenhum requisito foi renumerado;
- **não é uma contagem de conclusão.** 114 requisitos, 148 cenários, 36
  contratos D7 e 36 jornadas E7 identificam a base documental. O próprio pacote
  diz que esses números "não descrevem implementação ou testes já realizados".

## 2. Precedência, como o pacote a define

1. decisões explícitas atuais do titular e limites de autorização;
2. o MASTER V7;
3. vídeo, frames e contrato visual, com a identidade DZ23;
4. matriz e cenários Coerentes, mais os adendos de mobile e de uso/custos;
5. ADRs e a Constituição deste repositório, sem afrouxar proteção nenhuma;
6. relatórios e estudos, como evidência **datada**, nunca como estado do HEAD;
7. prompts em `historico/`, só para rastrear origem.

A leitura que isso muda aqui: **o parecer do Manus não é autoridade sobre este
código**, e o adendo móvel já decidiu Capacitor — a sugestão de outra stack no
relatório não revoga a decisão.

## 3. A correspondência

`docs/inventory/master-v7.json` guarda a identidade do pacote e os 36 contratos
D7 e 36 jornadas E7 com o texto de aceite original, mais um campo dizendo onde
cada um está **aqui**. O valor padrão é `A_REVALIDAR_PELO_EXECUTOR`, e ele quer
dizer **não conferido** — que é resposta diferente de "ausente" e de "pronto".
Transformar ausência de prova em veredito é exatamente o que o pacote proíbe.

Três já têm resposta com prova nesta sessão:

| contrato | estado | prova |
| --- | --- | --- |
| D7-001 continuidade | COBERTO | mesma branch e mesmo checkpoint; entradas 32 a 34 de `PROJECT_STATUS.md` |
| D7-003 workspace fiel | PARCIAL | nove divergências fechadas na OS-103, **onze nomeadas e abertas**; aceite visual do titular NÃO declarado |
| D7-004 semântica da conversa | COBERTO nesta fatia | OS-105: perguntar deixou de virar critério de aceite |

## 4. O que a V7 acrescenta ao DAG

Os contratos D7 sem dono viraram tarefas no DAG, na ordem dos marcos M0–M7 do
próprio MASTER. Nenhuma tarefa existente foi removida, e nenhuma obrigação da
base Coerente foi retirada para acelerar conclusão — o pacote proíbe as duas.

## 5. O que este pacote NÃO autoriza

Publicação, deploy, despesa, mudança de acesso ou distribuição em loja. Cripto
e trading seguem fora. As imagens e o vídeo de referência são material privado
do titular e **não entram no bundle público** — por isso o pacote não foi
copiado inteiro para dentro da árvore: o que entrou é a correspondência, em
texto.
