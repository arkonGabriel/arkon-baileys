import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { AnyMessageContent, MessageContentGenerationOptions, WAMessageContent } from '../Types'
import { prepareWAMessageMedia } from '../Utils/messages'
import { shouldIncludeReportingToken } from '../Utils/reporting-utils'
import { ARKON_FALLBACK_URL, ARKON_LIBRARY_NAME } from './constants'
import {
	type ArkonProductContent,
	EXTRA_CONTENT_KEYS,
	isArkonPoll,
	prepareExtraContent,
	prepareInvoiceMessage,
	preparePollMessage,
	prepareProductMessage,
	prepareRequestPaymentMessage
} from './extra-content'
import { prepareNativeFlowButtons } from './native-flow'
import { prepareStickerPackMessage, type StickerPackContent } from './sticker-pack'
import type { ArkonCard, ArkonMessageContent } from './types'
import { hasValidCarouselHeader, hasValidInteractiveHeader } from './validators'

const { ButtonsMessage, InteractiveMessage, ListMessage } = proto.Message
const ButtonType = ButtonsMessage.Button.Type
const ButtonHeaderType = ButtonsMessage.HeaderType

type ContentGenerator = (message: AnyMessageContent, options: MessageContentGenerationOptions) => Promise<proto.Message>
type WithContextInfo = { contextInfo?: proto.IContextInfo | null }

/** keys that make a message an Arkon message: the stock generator ignores all of them */
const ARKON_TRIGGER_KEYS = [
	'buttons',
	'sections',
	'templateButtons',
	'nativeFlow',
	'cards',
	'stickers',
	'externalAdReply',
	'groupStatus',
	'interactiveAsTemplate',
	'ephemeral',
	'viewOnceV2',
	'viewOnceV2Extension',
	'isLottie',
	'favicon',
	'requestPaymentFrom',
	'invoiceNote',
	...EXTRA_CONTENT_KEYS
] as const

/** applied by the Arkon builder itself, after the interactive wrapping, so they are kept from the stock generator */
const DECORATOR_KEYS = ['viewOnce', 'mentions', 'mentionAll', 'edit', 'contextInfo'] as const

/** stock generator branches that write their own messageContextInfo */
const OWN_CONTEXT_INFO_KEYS = ['poll', 'event', 'pin', 'albumParentKey'] as const

const has = (obj: object | null | undefined, key: string) =>
	obj !== null &&
	typeof obj === 'object' &&
	key in obj &&
	(obj as Record<string, unknown>)[key] !== null &&
	(obj as Record<string, unknown>)[key] !== undefined

const isTruthy = (obj: object, key: string) => has(obj, key) && !!(obj as Record<string, unknown>)[key]

export const isArkonMessageContent = (message: unknown): message is ArkonMessageContent =>
	typeof message === 'object' &&
	message !== null &&
	(ARKON_TRIGGER_KEYS.some(key => isTruthy(message, key)) ||
		has(message, 'paymentInviteServiceType') ||
		Array.isArray((message as { album?: unknown }).album) ||
		isArkonPoll((message as { poll?: unknown }).poll))

const firstContent = (m: WAMessageContent) => {
	const type = Object.keys(m)[0] as keyof proto.IMessage
	return m[type] as WithContextInfo | undefined
}

const generateBaseContent = async (
	message: ArkonMessageContent,
	options: MessageContentGenerationOptions,
	generate: ContentGenerator
): Promise<WAMessageContent> => {
	if (has(message, 'stickers')) {
		return { stickerPackMessage: await prepareStickerPackMessage(message as StickerPackContent, options) }
	}

	if (Array.isArray(message.album)) {
		const imageCount = message.album.filter(item => has(item, 'image')).length
		const videoCount = message.album.filter(item => has(item, 'video')).length
		if (imageCount + videoCount < 2) {
			throw new Boom('An album needs at least 2 images or videos', { statusCode: 400 })
		}

		return { albumMessage: { expectedImageCount: imageCount, expectedVideoCount: videoCount } }
	}

	const extra = await prepareExtraContent(message, options)
	if (extra) {
		return extra
	}

	if (isArkonPoll(message.poll)) {
		return preparePollMessage(message.poll)
	}

	const core: Record<string, unknown> = { ...message }
	for (const key of [...ARKON_TRIGGER_KEYS, ...DECORATOR_KEYS]) {
		delete core[key]
	}

	const m: WAMessageContent = { ...(await generate(core as AnyMessageContent, options)) }
	// a lottie sticker also carries the flag on the sticker itself
	if (message.isLottie && m.stickerMessage) {
		m.stickerMessage.isLottie = true
	}

	// the small site icon shown next to a link preview
	if (message.favicon && m.extendedTextMessage) {
		const { imageMessage } = await prepareWAMessageMedia({ image: message.favicon }, options)
		m.extendedTextMessage.faviconMMSMetadata = {
			thumbnailDirectPath: imageMessage!.directPath,
			mediaKey: imageMessage!.mediaKey,
			mediaKeyTimestamp: imageMessage!.mediaKeyTimestamp,
			thumbnailWidth: 32,
			thumbnailHeight: 32,
			thumbnailSha256: imageMessage!.fileSha256,
			thumbnailEncSha256: imageMessage!.fileEncSha256
		}
	}

	// the stock generator adds a reporting secret at the top level; it is added again once the message is wrapped
	if (!OWN_CONTEXT_INFO_KEYS.some(key => has(core, key))) {
		delete m.messageContextInfo
	}

	return m
}

const buildButtonsMessage = (message: ArkonMessageContent, m: WAMessageContent): WAMessageContent => {
	const buttonsMessage: proto.Message.IButtonsMessage = {
		buttons: message.buttons!.map(button => {
			const buttonText = button.text || button.buttonText
			if (has(button, 'sections')) {
				return {
					nativeFlowInfo: {
						name: 'single_select',
						paramsJson: JSON.stringify({ title: buttonText, sections: button.sections })
					},
					type: ButtonType.NATIVE_FLOW
				}
			}

			if (has(button, 'name')) {
				return {
					nativeFlowInfo: { name: button.name, paramsJson: button.paramsJson },
					type: ButtonType.NATIVE_FLOW
				}
			}

			return {
				buttonId: button.id || button.buttonId,
				buttonText: typeof buttonText === 'string' ? { displayText: buttonText } : buttonText,
				type: button.type || ButtonType.RESPONSE
			}
		})
	}

	if (has(message, 'text')) {
		buttonsMessage.contentText = message.text
		buttonsMessage.headerType = ButtonHeaderType.EMPTY
	} else {
		if (has(message, 'caption')) {
			buttonsMessage.contentText = message.caption
		}

		const type = Object.keys(m)[0]!.replace('Message', '').toUpperCase() as keyof typeof ButtonHeaderType
		buttonsMessage.headerType = ButtonHeaderType[type]
		Object.assign(buttonsMessage, m)
	}

	if (has(message, 'footer')) {
		buttonsMessage.footerText = message.footer
	}

	return { buttonsMessage }
}

const buildListMessage = (message: ArkonMessageContent): WAMessageContent => ({
	listMessage: {
		sections: message.sections as proto.Message.ListMessage.ISection[],
		buttonText: message.buttonText,
		title: message.title,
		footerText: message.footer,
		description: message.text,
		listType: ListMessage.ListType.SINGLE_SELECT
	}
})

const buildTemplateMessage = (message: ArkonMessageContent, m: WAMessageContent): WAMessageContent => {
	const hydrated: proto.Message.TemplateMessage.IHydratedFourRowTemplate = {
		hydratedButtons: message.templateButtons!.map((button, index) => {
			const buttonText = button.text || button.buttonText
			if (has(button, 'id')) {
				return { index, quickReplyButton: { displayText: buttonText || '👉🏻 Click', id: button.id } }
			}

			if (has(button, 'url')) {
				return { index, urlButton: { displayText: buttonText || '🌐 Visit', url: button.url } }
			}

			if (has(button, 'call')) {
				return { index, callButton: { displayText: buttonText || '📞 Call', phoneNumber: button.call } }
			}

			return { ...button, index: button.index || index } as proto.IHydratedTemplateButton
		})
	}

	if (has(message, 'text')) {
		hydrated.hydratedContentText = message.text
	} else {
		if (has(message, 'caption')) {
			hydrated.hydratedTitleText = message.title
			hydrated.hydratedContentText = message.caption
		}

		Object.assign(hydrated, m)
	}

	if (has(message, 'footer')) {
		hydrated.hydratedFooterText = message.footer
	}

	// WhatsApp only checks that a template id is present
	hydrated.templateId = message.id || 'template-' + Date.now()
	return { templateMessage: { hydratedFourRowTemplate: hydrated, hydratedTemplate: hydrated } }
}

const buildNativeFlowMessage = async (
	message: ArkonMessageContent,
	m: WAMessageContent,
	options: MessageContentGenerationOptions
): Promise<WAMessageContent> => {
	const interactiveMessage: proto.Message.IInteractiveMessage = {
		nativeFlowMessage: prepareNativeFlowButtons(message)
	}

	if (has(message, 'bizJid')) {
		interactiveMessage.collectionMessage = { bizJid: message.bizJid, id: message.id, messageVersion: 1 }
	} else if (has(message, 'shopSurface')) {
		interactiveMessage.shopStorefrontMessage = { surface: message.shopSurface, id: message.id, messageVersion: 1 }
	}

	if (has(message, 'text')) {
		interactiveMessage.body = { text: message.text }
	} else {
		if (has(message, 'caption')) {
			const isValidHeader = hasValidInteractiveHeader(m)
			if (!isValidHeader) {
				throw new Boom('Invalid media type for interactive message header', { statusCode: 400 })
			}

			interactiveMessage.header = {
				title: message.title || '',
				subtitle: message.subtitle || '',
				hasMediaAttachment: isValidHeader
			}
			interactiveMessage.body = { text: message.caption }
		}

		if (isTruthy(message, 'thumbnail')) {
			;(interactiveMessage as { jpegThumbnail?: unknown }).jpegThumbnail = message.thumbnail
		}

		interactiveMessage.header = Object.assign(interactiveMessage.header || {}, m)
	}

	const footer = await buildFooter(message, options)
	if (footer) {
		interactiveMessage.footer = footer
	}

	return { interactiveMessage }
}

const buildFooter = async (
	source: { footer?: string; audioFooter?: unknown },
	options: MessageContentGenerationOptions
): Promise<proto.Message.InteractiveMessage.IFooter | undefined> => {
	if (has(source, 'audioFooter')) {
		const { audioMessage } = await prepareWAMessageMedia(
			{ audio: source.audioFooter } as Parameters<typeof prepareWAMessageMedia>[0],
			options
		)
		return { audioMessage, hasMediaAttachment: true }
	}

	if (has(source, 'footer')) {
		return { text: source.footer }
	}

	return undefined
}

const buildCard = async (
	card: ArkonCard,
	options: MessageContentGenerationOptions
): Promise<proto.Message.IInteractiveMessage> => {
	let header: WAMessageContent = {}
	if (has(card, 'product')) {
		header.productMessage = await prepareProductMessage(card as unknown as ArkonProductContent, options)
	} else {
		header = await prepareWAMessageMedia(card as Parameters<typeof prepareWAMessageMedia>[0], options).catch(() => ({}))
	}

	const isValidHeader = hasValidCarouselHeader(header)
	if (!isValidHeader) {
		throw new Boom('Invalid media type for carousel card', { statusCode: 400 })
	}

	const result: proto.Message.IInteractiveMessage = {
		nativeFlowMessage: prepareNativeFlowButtons(card.nativeFlow ? card : {})
	}

	if (has(card, 'text')) {
		result.body = { text: card.text }
	} else {
		if (has(card, 'caption')) {
			result.header = { title: card.title || '', subtitle: card.subtitle || '', hasMediaAttachment: isValidHeader }
			result.body = { text: card.caption }
		}

		if (isTruthy(card, 'thumbnail')) {
			;(result as { jpegThumbnail?: unknown }).jpegThumbnail = card.thumbnail
		}

		result.header = Object.assign(result.header || {}, header)
	}

	const footer = await buildFooter(card, options)
	if (footer) {
		result.footer = footer
	}

	return result
}

const buildCarouselMessage = async (
	message: ArkonMessageContent,
	options: MessageContentGenerationOptions
): Promise<WAMessageContent> => {
	const interactiveMessage: proto.Message.IInteractiveMessage = {
		carouselMessage: {
			cards: await Promise.all(message.cards!.map(card => buildCard(card, options))),
			carouselCardType: InteractiveMessage.CarouselMessage.CarouselCardType.UNKNOWN,
			messageVersion: 1
		}
	}
	if (has(message, 'text')) {
		interactiveMessage.body = { text: message.text }
	}

	if (has(message, 'footer')) {
		interactiveMessage.footer = { text: message.footer }
	}

	return { interactiveMessage }
}

const applyExternalAdReply = (message: ArkonMessageContent, m: WAMessageContent) => {
	const key = firstContent(m)
	const content = { ...message.externalAdReply! }
	if ('thumbnail' in content && content.thumbnail !== undefined && !Buffer.isBuffer(content.thumbnail)) {
		throw new Boom('externalAdReply.thumbnail must be a Buffer', { statusCode: 400 })
	}

	const url = typeof content.url === 'string' && content.url ? content.url : ARKON_FALLBACK_URL
	const externalAdReply: Record<string, unknown> = {
		...content,
		body: content.body,
		mediaType: content.mediaType || 1,
		mediaUrl: url,
		renderLargerThumbnail: content.largeThumbnail,
		sourceUrl: url,
		thumbnail: content.thumbnail,
		thumbnailUrl: url + '?update=' + Date.now(),
		title: content.title || ARKON_LIBRARY_NAME
	}
	delete externalAdReply.subTitle
	delete externalAdReply.largeThumbnail
	delete externalAdReply.url

	if (key?.contextInfo) {
		key.contextInfo.externalAdReply = { ...key.contextInfo.externalAdReply, ...externalAdReply }
	} else if (key) {
		key.contextInfo = { externalAdReply }
	}
}

/**
 * Builds the message types and wrappers the stock generator does not know: buttons, lists,
 * templates, native flows, carousels, albums, sticker packs, group status, ad replies and the
 * ephemeral/view-once-v2 wrappers. Message shapes follow @itsliaaa/baileys so existing bot code keeps working.
 */
export const generateArkonMessageContent = async (
	message: ArkonMessageContent,
	options: MessageContentGenerationOptions,
	generate: ContentGenerator
) => {
	if (message.raw) {
		// the caller built the proto by hand; it is sent as given
		const content: Record<string, unknown> = { ...message }
		delete content.raw
		return proto.Message.create(content as proto.IMessage)
	}

	let m = await generateBaseContent(message, options, generate)

	if (has(message, 'buttons')) {
		m = buildButtonsMessage(message, m)
	} else if (has(message, 'sections')) {
		m = buildListMessage(message)
	} else if (has(message, 'templateButtons')) {
		m = buildTemplateMessage(message, m)
	} else if (has(message, 'nativeFlow')) {
		m = await buildNativeFlowMessage(message, m, options)
	} else if (has(message, 'cards')) {
		m = await buildCarouselMessage(message, options)
	} else if (has(message, 'requestPaymentFrom')) {
		m = prepareRequestPaymentMessage(message as ArkonMessageContent & { requestPaymentFrom: string }, m)
	} else if (has(message, 'invoiceNote')) {
		m = prepareInvoiceMessage(message.invoiceNote as string, m)
	}

	if (isTruthy(message, 'externalAdReply')) {
		applyExternalAdReply(message, m)
	}

	if (message.mentions?.length || message.mentionAll) {
		const key = firstContent(m)
		if (key && 'contextInfo' in key) {
			key.contextInfo = key.contextInfo || {}
			if (message.mentions?.length) {
				key.contextInfo.mentionedJid = message.mentions
			}

			if (message.mentionAll) {
				key.contextInfo.nonJidMentions = 1
			}
		} else if (key) {
			key.contextInfo = { mentionedJid: message.mentions, nonJidMentions: message.mentionAll ? 1 : 0 }
		}
	}

	if (isTruthy(message, 'contextInfo')) {
		const key = firstContent(m)
		if (key?.contextInfo) {
			key.contextInfo = { ...key.contextInfo, ...message.contextInfo }
		} else if (key) {
			key.contextInfo = message.contextInfo
		}
	}

	if (message.groupStatus) {
		const key = firstContent(m)
		if (key?.contextInfo) {
			key.contextInfo.isGroupStatus = true
		} else if (key) {
			key.contextInfo = { isGroupStatus: true }
		}

		m = { groupStatusMessageV2: { message: m } }
	}

	if (message.interactiveAsTemplate) {
		if (!m.interactiveMessage) {
			throw new Boom('interactiveAsTemplate needs an interactive message', { statusCode: 400 })
		}

		m = {
			templateMessage: {
				interactiveMessageTemplate: m.interactiveMessage,
				templateId: message.id || 'template-' + Date.now()
			}
		}
	}

	if (message.ephemeral) {
		m = { ephemeralMessage: { message: m } }
	}

	if (message.isLottie) {
		m = { lottieStickerMessage: { message: m } }
	} else if (message.viewOnce) {
		m = { viewOnceMessage: { message: m } }
	} else if (message.viewOnceV2) {
		m = { viewOnceMessageV2: { message: m } }
	} else if (message.viewOnceV2Extension) {
		m = { viewOnceMessageV2Extension: { message: m } }
	}

	if (has(message, 'edit')) {
		m = {
			protocolMessage: {
				key: message.edit,
				editedMessage: m,
				timestampMs: Date.now(),
				type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT
			}
		}
	}

	if (shouldIncludeReportingToken(m)) {
		m.messageContextInfo = m.messageContextInfo || {}
		if (!m.messageContextInfo.messageSecret) {
			m.messageContextInfo.messageSecret = randomBytes(32)
		}
	}

	return proto.Message.create(m)
}
