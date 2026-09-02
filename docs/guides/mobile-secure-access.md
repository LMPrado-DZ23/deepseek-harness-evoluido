# Como abrir o DZ23 STUDIO no celular com segurança

## Opção recomendada: Tailscale

1. Instale o Tailscale no computador que executa o Studio e no celular.
2. Entre na mesma conta/rede Tailscale nos dois aparelhos.
3. Dê acesso somente às pessoas autorizadas pelas regras de acesso do Tailscale.
4. Configure o domínio HTTPS fornecido pelo Tailscale no Studio.
5. No celular, abra `/login`, informe seu e-mail e digite o código recebido.

O endereço do Harness nunca deve ser aberto ou encaminhado diretamente. Somente o
endereço HTTPS do Caddy é compartilhado.

## Alternativa local: certificado interno do Caddy

O arquivo `deploy/caddy/docker-compose.local.yml` abre o Caddy apenas no próprio
computador por padrão. Para usar o endereço Tailscale da máquina, defina
`DZ23_BIND_ADDRESS` com esse endereço e mantenha as regras de acesso restritas.
Para alcançar pela rede local comum, é necessária uma regra de firewall restrita
à rede confiável e uma decisão de implantação separada. Não troque o bind do
Harness: ele continua em `127.0.0.1`.

Ao usar `tls internal`, o Caddy cria uma autoridade certificadora no volume
`caddy-data`. O celular não conhece essa autoridade e pode mostrar “conexão não
privada”. Isso não significa automaticamente que alguém invadiu o sistema; significa
que o aparelho ainda não confia naquele emissor local.

O DZ23 STUDIO não instala essa CA automaticamente. A instalação manual de uma CA
afeta a confiança do aparelho inteiro e só deve ser feita por quem entende o efeito.
Para pessoas leigas, use Tailscale com HTTPS válido.

## Regras simples

- nunca exponha a porta interna 3210;
- nunca envie `DZ23_EDGE_SECRET` por mensagem ou coloque-o no repositório;
- não ignore aviso de certificado em uma rede pública;
- não publique 443 antes de configurar domínio, ACME, firewall e backup;
- se um acesso for perdido ou suspeito, revogue o dispositivo no Studio.

O Compose é referência técnica. A imagem distribuível `DZ23_STUDIO_IMAGE` ainda
pertence à fase de empacotamento; não trate este arquivo como deploy concluído.
