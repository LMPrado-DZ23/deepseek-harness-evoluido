/// <reference types="vite/client" />
// Sem esta linha, `tsc -b` recusa os imports de folha de estilo e o script
// `build` (`tsc -b && vite build`) morre antes de gerar qualquer coisa - o
// portão de build estava vermelho e ninguém via, porque o CI rodava só os
// testes.
