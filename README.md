# Programa Afinar · App de Mentoria (Vercel + Upstash)

App de mentoria interna da hit.hammers. Migrado de HTML/localStorage para a Vercel
com banco compartilhado (Upstash Redis), no mesmo padrão dos radares Hithammers.

## Estrutura
- `index.html` — o app (mesma UI/design do v8; só a camada de dados e o login do gestor mudaram)
- `sync.js` — espelha o localStorage na nuvem (hidrata no boot, POST com debounce, poll 6s in-place)
- `api/state.js` — GET/POST do estado no Upstash, com **merge por campo** (colaborador vs gestor)
- `api/gestor-login.js` — valida a senha do gestor no servidor (env `SYNC_PASSWORD`)
- `assets/imagens/` — imagens (nomes normalizados: minúsculo, sem espaço/acento)
- `vercel.json`, `package.json`

## Modelo de dados (inalterado)
localStorage, uma chave por registro: `afinar_v4::<nome>::<ano>-<mês>`, mais
`afinar_v4_colaboradores`. Cada registro: `{nome,ano,mes,funcao,data,mentor,self,ment,
pdi,roteiro,reuniao,updatedAt,selfUpdatedAt,mentUpdatedAt}`. O `sync.js` torna isso
compartilhado sem tocar em `loadForm`/`saveForm`.

Merge no servidor: campos do colaborador (`funcao/data/self/pdi/selfCompleto`) e do
gestor (`ment/mentor/roteiro/reuniao/mentCompleto`) são mesclados por `selfUpdatedAt`/
`mentUpdatedAt`, então salvar de um lado nunca apaga o outro no mesmo mês.

## Deploy (etapas no navegador — GitHub / Vercel / Upstash)
1. Criar o repositório **`afinar-mentoria`** na conta GitHub `diegofaury2-ux` (privado ou público).
2. Publicar este diretório:
   ```
   git remote add origin https://github.com/diegofaury2-ux/afinar-mentoria.git   # se ainda não houver
   git push -u origin main
   ```
   (commit author = `diegofaury2@gmail.com`, senão a Vercel bloqueia o deploy.)
3. No painel Vercel: **New Project** → importar o repo `afinar-mentoria` (deploy automático a cada push).
4. Provisionar **Upstash Redis** (pode ser a mesma conta dos radares) e cadastrar as env vars no projeto:
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
   - `SYNC_PASSWORD` = `hithammers2026`  (senha do gestor)
   - (opcional) `REDIS_KEY` = `afinar:state:v1` (já é o padrão no código)
5. Redeploy. Abrir o link, testar login de colaborador (só nome) e de gestor (senha).

## Teste local (sem Upstash)
Servidor de teste com Upstash falso em memória em
`…/scratchpad/afinar-dev-server.js` (launch config `afinar-dev`, porta 8811).
O fluxo colaborador → gestor → sincronização já foi validado por aqui.

O app nasce em branco (nenhum formulário pré-preenchido); a lista de colaboradores,
os mentores (Val/Luiz) e as fotos já vêm prontos.
