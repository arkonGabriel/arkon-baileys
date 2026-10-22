# Arkon Baileys

Versão do [Baileys](https://github.com/WhiskeySockets/Baileys) mantida pela Arkon Labs para o Arkon Bot.
O pacote se chama `@arkon/baileys` e segue a numeração do Baileys oficial com o sufixo `-arkon.N`.

## Licença e créditos

MIT, igual ao original. O aviso de copyright do Baileys continua no `LICENSE`, junto com o da Arkon Labs.

- Baileys: Rajeh Taher/WhiskeySockets e colaboradores (purpshell, jlucaso1, adiwajshing e outros).
- Recursos de mensagens trazidos do fork [@itsliaaa/baileys](https://github.com/itsliaaa/baileys) (MIT), de Lia Wynn, a partir da Etapa 2.

## O que muda em relação ao oficial

| Versão | Mudança |
| --- | --- |
| 7.0.0-rc14-arkon.1 | Nome `@arkon/baileys`. `makeWaVersionResolver`: consulta web.whatsapp.com, a lista do wppconnect e o GitHub e usa a maior versão, com cache de 30 min, para evitar o erro 405 no pareamento. |

## Usar a versão do WhatsApp automática

```js
import makeWASocket, { makeWaVersionResolver } from '@arkon/baileys'

const waVersion = makeWaVersionResolver({ fallback: [2, 3000, 1043857760] })
const { version } = await waVersion.resolve({ override: process.env.WA_VERSION })
const sock = makeWASocket({ version /* , ... */ })
// depois de um 405: waVersion.invalidate() e reconectar
```

## Manter atualizada

No GitHub, botão **Sync fork** puxa o oficial. Depois rode `yarn lint`, `yarn test` e `yarn build`.
