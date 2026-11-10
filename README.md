# PulseLink

Acesso remoto de baixa latência para Windows, P2P via WebRTC, com integração ao Moonlight/Sunshine para jogos.

- **Hospedar e conectar.** Compartilhe a tela ou uma janela com um código de acesso. O host aprova cada convidado e libera teclado e mouse individualmente.
- **Controle remoto real.** Mouse, roda e teclado do convidado são injetados no host via `SendInput`, com scancodes, então funcionam em jogos e respeitam o layout de teclado do host (ex.: ABNT2).
- **Moonlight.** Descobre hosts Sunshine na rede (mDNS), pareia por PIN, lista os apps, liga o PC por Wake-on-LAN e abre a transmissão no cliente oficial Moonlight.
- **PlayStation (PS4/PS5).** Encontra consoles na rede pelo protocolo de descoberta da Sony e abre o Remote Play no chiaki-ng.
- **Telemetria.** Latência, FPS, taxa, perda de pacotes, codec e rota (LAN, P2P ou TURN), medidas de verdade via `getStats()`.

## Rodar

```bash
npm install
npm start
```

Ou clique duas vezes em `Iniciar-PulseLink.cmd`. O servidor de sinalização local sobe junto com o app.

**Testar host e convidado no mesmo PC:** em Ajustes › Sobre, abra a *Janela de convidado de teste*. No host, ative **Hospedar** e clique em **Compartilhar com código**. Na janela de convidado, digite o código e aceite no host. O convidado começa só assistindo; libere teclado e mouse no painel do host.

## Instalador (como o do Parsec)

```bash
npm run dist
```

Gera `apps/desktop/release/PulseLink-Setup-<versão>.exe`. É um instalador por usuário, com atalhos na área de trabalho e no Menu Iniciar e um desinstalador. O servidor de sinalização vai embutido e roda com o Node do próprio Electron, então quem instala não precisa de Node.js.

- **Sem segredos no instalador:** o app só leva a URL do Supabase e a anon key (pública). Quem instala não precisa de `.env`; basta criar uma conta no próprio app.
- **Variáveis `VITE_*`** (URL do Supabase, anon key e TURN) são lidas de `apps/desktop/.env` **no momento do build** e ficam dentro do instalador. Gere o instalador de novo sempre que trocar essas chaves.
- **Release automática:** crie uma tag com a versão (`git tag v0.3.0 && git push origin v0.3.0`). O workflow `Release` gera o instalador no Windows e publica a release com o `.exe`. Antes, cadastre `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` em Settings › Secrets and variables › Actions.
- **Sem assinatura de código:** o Windows SmartScreen avisa na primeira execução. Para distribuir publicamente, assine com um certificado de code signing.

## Nuvem (contas, amigos e conexão entre redes)

Com conta, tudo passa pelo Supabase usando **só a anon key** e o login do usuário:

- **Leitura:** as regras de acesso por linha (RLS) do banco decidem o que cada usuário vê. Você enxerga os seus PCs, os PCs de quem adicionou você como amigo e as sessões de que participa.
- **Escrita:** o que envolve outras pessoas (resgatar código, aprovar convidado, liberar teclado e mouse) passa por funções SQL `pl_*`. Elas conferem quem está chamando.
- **Conexão WebRTC:** as mensagens que estabelecem a conexão vão por canais **privados** do Realtime, que só membros da sessão acessam, e ainda são cifradas com AES-GCM.
- **Sem conta:** o app funciona no modo local, só na mesma rede, pelo serviço embutido.

**Configurar uma vez (só você, como desenvolvedor):**

1. No Supabase, em Authentication › Providers, deixe Email ativado.
2. Coloque `DATABASE_URL` no `.env` da raiz e rode:

   ```bash
   npm run cloud:migrate
   ```

   Isso cria as tabelas `pl_*`, as regras de acesso, as funções e as permissões dos canais privados. Pode rodar de novo sem problema.
3. Em Realtime › Settings, desative **Allow public access**, para que só canais privados sejam aceitos.
4. Coloque `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` em `apps/desktop/.env` e gere o instalador.

O schema e as regras ficam em [supabase/migrations](supabase/migrations). Os testes em [supabase/test](supabase/test) rodam o SQL num Postgres local (PGlite) e verificam as regras com três usuários.

## Configuração

| O quê | Para quê |
| --- | --- |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | Contas e conexão entre redes. Valores públicos, embutidos no build. |
| `VITE_TURN_*` | Relay TURN para quando não há caminho direto (NAT simétrico, CGNAT, 4G). |
| `DATABASE_URL` | **Só para desenvolvedor:** usado pelo `npm run cloud:migrate`. O app nunca lê. |
| `MOONLIGHT_PATH`, `CHIAKI_PATH` | Caminhos dos clientes, se não estiverem no local padrão. |

### Moonlight

Instale o [Moonlight](https://moonlight-stream.org/) neste PC e o [Sunshine](https://github.com/LizardByte/Sunshine) no PC que vai transmitir. O PulseLink controla o cliente Moonlight pela linha de comando (`pair`, `list`, `stream`); ele não reimplementa o protocolo GameStream.

### PlayStation

1. Instale o [chiaki-ng](https://streetpea.github.io/chiaki-ng/).
2. No console, ative o Uso Remoto em Configurações › Configurações de conexão do Uso Remoto.
3. Registre o console uma vez no chiaki-ng, usando o PIN mostrado pelo console e o ID da sua conta PSN.
4. Na tela PlayStation do PulseLink, o console aparece sozinho; clique em Jogar.

Ligar um console que está em repouso é feito pelo próprio chiaki-ng. Fora de casa, use a conexão remota via PSN do chiaki-ng.

## Segurança

- **Serviço local:** escuta só em `127.0.0.1`. Toda rota verifica dono ou participante. CORS fica restrito ao próprio app e os payloads são limitados.
- **Nuvem:** nenhuma credencial de administrador fica nos PCs. O acesso é controlado por RLS e pelas funções `pl_*`, e a conexão usa canais privados do Realtime, com cifra AES-GCM e uma chave por sessão.
- **Input remoto:** passa pelo canal de dados do WebRTC (DTLS). O host confere as permissões de cada convidado antes de aplicar qualquer evento. Aprovar uma conexão não dá controle: amigos recebem as permissões salvas para eles, e os demais começam só assistindo.
- **Electron:** renderers com `sandbox`, `contextIsolation`, CSP no build, navegação travada e captura de tela concedida só às telas do app.

## Desenvolvimento

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run typecheck
```

`npm run dev` sobe o signal server e a UI no navegador. `npm test` roda os testes de integração do signal server (autorização, isolamento e limites). `npm run typecheck` checa os tipos de todos os workspaces.

```text
apps/desktop        App desktop (Electron + React 19 + Vite)
  electron/         Processo principal, preload, injeção de input (input-injector.mjs)
  src/state/        Estado da aplicação (AppState)
  src/stream/       Sessão WebRTC, sinalização cifrada, canal de dados
  src/views/        Telas: Computadores, Moonlight, Amigos, Transmissão, Ajustes
packages/protocol   Tipos compartilhados (REST, WebSocket, mensagens P2P)
services/signal     Servidor de sinalização (HTTP + WebSocket + SQLite, sync opcional com Supabase)
  src/routes/       Rotas por domínio
  test/             Testes de integração (node --test)
replica/schema.sql  Schema SQLite do serviço local
```

## Limitações conhecidas

- **Controle (gamepad) remoto:** ainda não implementado. Exige um driver de controle virtual (ViGEmBus).
- **Display virtual:** não existe. Seria preciso um driver IDD; hoje o app transmite telas ou janelas existentes.
- **Injeção de input:** só funciona no Windows.
