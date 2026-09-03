# P32 — Prova executável do isolamento do construtor

- Resultado: **PASS**
- Imagem: `sha256:51af5f3dbaebc1e9fa37512160a114fdd339eaffacca40e2e3a9b1a1520e5a03`
- NetworkMode: `none`
- Tentativa de conexão dentro do contêiner: `NETWORK_BLOCKED`
- Usuário: `1001:1001`
- Privileged: `false`
- CapDrop: `ALL`
- SecurityOpt: `no-new-privileges`
- Raiz somente leitura: `true`
- Montagens: workspace gravável e template-store somente leitura; sem docker.sock e sem trust store.
- SHA-256 do trust store do host antes/depois: `ecd9dc38bc3efb7dbd6431f57e29d2f8d6a0f0d211e1464b3fef2cbfe266fcd2` / `ecd9dc38bc3efb7dbd6431f57e29d2f8d6a0f0d211e1464b3fef2cbfe266fcd2` (idênticos).

A prova criou um contêiner descartável sem rede, inspecionou a configuração real com `docker inspect`, tentou conexão HTTP de dentro e removeu o contêiner ao final.
