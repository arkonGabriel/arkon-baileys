export const ARKON_LIBRARY_NAME = 'Arkon Baileys'
/** used where a link is required by WhatsApp but the caller gave none */
export const ARKON_FALLBACK_URL = 'https://www.arkonlabs.shop'
/** pause between album items, as WhatsApp clients do */
export const ALBUM_ITEM_DELAY_MS = 1500
/** default currency for product, order and payment messages when the caller gives none */
export const ARKON_DEFAULT_CURRENCY = 'BRL'
/** support payload WhatsApp expects next to the `bot` node for the AI label */
export const AI_SUPPORT_PAYLOAD = JSON.stringify({
	version: 1,
	is_ai_message: true,
	should_upload_client_logs: false,
	should_show_system_message: false,
	ticket_id: '7004947587700716',
	citation_items: [],
	ticket_locale: 'us'
})
