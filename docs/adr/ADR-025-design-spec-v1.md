# ADR-025 — DesignSpec v1 e logotipos sanitizados

Status: aceito e implementado como BETA na fatia 2.

Cada projeto pode ter versões imutáveis de um `DesignSpec` no domínio físico
`studio_design_specs`. O registro recebe `org_id`, `tenant_id`, `project_id`,
versão, autor, data e SHA-256 do contrato validado por Zod. A interface oferece
quatro estilos neutros próprios: moderno, profissional, colorido e minha
marca. Nenhum estilo reproduz identidade visual de terceiros.

O contrato contém seis papéis de cor — principal, secundária, neutra,
sucesso, aviso e perigo — cada um com primeiro plano que precisa atingir
contraste WCAG AA de 4,5:1. A tipografia escolhe Geist Sans ou Source Serif 4,
ambas locais, com pesos 400/500/600/700. Também fixa raio, densidade e tom
acolhedor ou formal.

O Studio transforma o contrato de modo determinístico em
`src/styles/tokens.css`. Esse arquivo é gravado antes da saída do modelo e é
protegido contra alteração. O modelo apenas consome as variáveis CSS.

Logotipos aceitam somente PNG ou JPEG de até 2 MB. A assinatura e o conteúdo
são conferidos, a imagem é rotacionada conforme orientação, limitada a
1.600 px, reencodada como PNG sem metadados e armazenada por hash em diretório
separado por organização e tenant. SVG é recusado nesta versão. A cor dominante
é extraída, mas a pessoa também pode informar a cor principal de sua marca.

Estado BETA significa que contrato, persistência, API, interface, isolamento e
processamento foram testados. Ainda faltam uso por pessoas leigas, LLM real,
preview e publicação; nenhum desses itens é inferido por este ADR.
