# Arkon Baileys

Versão do [Baileys](https://github.com/WhiskeySockets/Baileys) mantida pela Arkon Labs para o Arkon Bot.
O pacote se chama `@arkon/baileys` e segue a numeração do Baileys oficial com o sufixo `-arkon.N`.

## Licença e créditos

MIT, igual ao original. O aviso de copyright do Baileys continua no `LICENSE`, junto com o da Arkon Labs.

- Baileys: Rajeh Taher/WhiskeySockets e colaboradores (purpshell, jlucaso1, adiwajshing e outros).
- Recursos de mensagens trazidos do fork [@itsliaaa/baileys](https://github.com/itsliaaa/baileys) (MIT), de Lia Wynn. O pacote de figurinhas segue o trabalho de jlucaso1 no Baileys (PR #1561).

## O que muda em relação ao oficial

| Versão | Mudança |
| --- | --- |
| 7.0.0-rc14-arkon.3 | Resto das mensagens da itsliaaa (`src/Arkon/extra-content.ts`): enquete com quiz, fim, votos ocultos e opção aberta; resultado e voto de enquete; manter na conversa (`keep`); resposta de fluxo (`flowReply`); produto (também como card de carrossel), pedido, fatura, cobrança e convite de pagamento (moeda padrão BRL); figurinha lottie (`isLottie`); ícone de IA (`ai`, só no privado); mensagem crua (`raw`). Leitura dos embrulhos extras (lottie, bot, menção em status…). Não entram a resposta rica e o `secureMetaServiceLabel`: os dois fazem a mensagem parecer vir da Meta ou da Meta AI. |
| 7.0.0-rc14-arkon.4 | Funções do socket da itsliaaa: `makeInMemoryStore` (`src/Store`, com a conversa sempre guardada pelo número, `loadMessage` achando por LID ou número e `maxMessagesPerChat`); `useSingleFileAuthState` (com `flush`) e `useSqliteAuthState` (better-sqlite3 ou o `node:sqlite` do Node 22.5+); menção em status (`sendMessage([jids], …)`); `findUserId`; `groupQuery`, `communityQuery`, `updateBusinessProfile`; `newsletterSubscribed` e `newsletterFetchMessages` nas duas formas; upload de mídia de canal pelos caminhos próprios; edição criptografada recebida (`decryptMessageEdit`); `favicon` no texto com link; `additionalNodes`/`additionalAttributes`/`delayMs` no `sendMessage`; atributos de stanza para fixar, reagir, votar e responder fluxo; `@napi-rs/image` como opção de imagem; miniatura de vídeo pelo ffmpeg sem passar pelo shell; contexto de transação por store num único `AsyncLocalStorage`. Os padrões de conexão continuam os oficiais. Não entram o ID de mensagem com marca `STARFALL`, os links de doação nem a resposta rica. |
| 7.0.0-rc14-arkon.2 | Mensagens da itsliaaa que o Arkon Bot usa, em `src/Arkon/`: botões (`buttons`), listas (`sections`), modelos (`templateButtons`), interativa (`nativeFlow`, com oferta e lista de opções), carrossel (`cards`), status do grupo (`groupStatus`), álbum (`album: [...]`), pacote de figurinhas (`stickers`), anúncio com miniatura (`externalAdReply`), `interactiveAsTemplate`, `ephemeral`, `viewOnceV2` e `viewOnceV2Extension`. Envio com o nó `biz` que faz os botões aparecerem. Teste `itsliaaa-parity` confere que cada mensagem sai igual à da itsliaaa 0.3.18-final. |
| 7.0.0-rc14-arkon.1 | Nome `@arkon/baileys`. `makeWaVersionResolver`: consulta web.whatsapp.com, a lista do wppconnect e o GitHub e usa a maior versão, com cache de 30 min, para evitar o erro 405 no pareamento. |

## Usar a versão do WhatsApp automática

```js
import makeWASocket, { makeWaVersionResolver } from '@arkon/baileys'

const waVersion = makeWaVersionResolver({ fallback: [2, 3000, 1043857760] })
const { version } = await waVersion.resolve({ override: process.env.WA_VERSION })
const sock = makeWASocket({ version /* , ... */ })
// depois de um 405: waVersion.invalidate() e reconectar
```

## Manter atualizada (sincronizar com o Baileys oficial)

Como o fork tem código próprio no `master`, o botão **Sync fork** do GitHub dá
conflito. Por isso a sincronização é feita de um jeito que preserva tudo o que é
Arkon:

**Automático, todo mês.** O robô `.github/workflows/sync-fork.yml` roda no dia 1
de cada mês (e também pelo botão **Run workflow**, na aba Actions → "Sync fork
(mensal)"). Ele:

- puxa as novidades do Baileys oficial (`WhiskeySockets/Baileys`);
- se juntar sem conflito, **abre um PR automático** — é só conferir a CI (build,
  testes, lint) e aprovar o merge;
- se der conflito, **abre um aviso (issue)** listando os arquivos pra resolver à mão;
- se já estiver em dia, não faz nada.

> Pra ele conseguir abrir o PR sozinho, deixe ligada a opção
> **Settings → Actions → General → "Allow GitHub Actions to create and approve
> pull requests"**. Se estiver desligada, ele ainda envia o branch e abre uma
> issue com o link pra você abrir o PR manualmente.

**Na hora, manualmente.** Rode `node scripts/sync-upstream.mjs` (aceita
`SYNC_DRY_RUN=1` pra só simular). Ele configura o remote `upstream`, baixa o
oficial e cria o branch `arkon/sync-upstream-AAAA-MM-DD` com o merge. Depois:

```bash
yarn install
yarn lint
yarn test
yarn build
```

e abra um PR desse branch. Havendo conflito, o script avisa quais arquivos e
desfaz o merge pra você resolver com calma.
