import type { proto } from '../../WAProto/index.js'
import type { WAMediaUpload, WAMessageKey } from '../Types'

/** A row of a single-select section, as WhatsApp expects it inside native flow params */
export type ArkonSectionRow = {
	header?: string
	title: string
	description?: string
	id: string
}

export type ArkonSection = {
	title?: string
	highlight_label?: string
	rows: ArkonSectionRow[]
}

/**
 * One native flow button. The first property found decides its kind:
 * `id` quick reply, `copy` copy code, `url` link, `call` phone call, `sections` single select.
 * Anything else is passed through as a raw `{ name, buttonParamsJson }` button.
 */
export type ArkonNativeFlowButton = {
	text?: string
	buttonText?: string
	icon?: string
	id?: string
	copy?: string
	url?: string
	useWebview?: boolean
	call?: string
	sections?: ArkonSection[]
	name?: string
	buttonParamsJson?: string
}

/** A legacy `buttonsMessage` button; `sections` or `name` turns it into a native flow button */
export type ArkonButton = {
	text?: string
	buttonText?: string | { displayText?: string }
	id?: string
	buttonId?: string
	type?: proto.Message.ButtonsMessage.Button.Type
	sections?: ArkonSection[]
	name?: string
	paramsJson?: string
}

export type ArkonTemplateButton = {
	text?: string
	buttonText?: string
	id?: string
	url?: string
	call?: string
	index?: number
} & Record<string, unknown>

export type ArkonNativeFlowOptions = {
	nativeFlow?: ArkonNativeFlowButton[] | { buttons: ArkonNativeFlowButton[] }
	/** limited time offer shown above the buttons */
	offerText?: string
	offerUrl?: string
	offerCode?: string
	offerExpiration?: number
	/** collapses the buttons into a bottom sheet opened by this button */
	optionText?: string
	optionTitle?: string
}

export type ArkonCard = ArkonNativeFlowOptions & {
	image?: WAMediaUpload
	video?: WAMediaUpload
	product?: Record<string, unknown>
	text?: string
	caption?: string
	title?: string
	subtitle?: string
	footer?: string
	thumbnail?: Buffer | string
	audioFooter?: WAMediaUpload
} & Record<string, unknown>

export type ArkonExternalAdReply = {
	title?: string
	body?: string
	url: string
	thumbnail?: Buffer
	largeThumbnail?: boolean
	mediaType?: number
} & Record<string, unknown>

export type ArkonSticker = {
	data: WAMediaUpload
	emojis?: string[]
	accessibilityLabel?: string
}

/** Extra keys the Arkon builders understand on top of the regular message content */
export type ArkonMessageContent = ArkonNativeFlowOptions & {
	text?: string
	caption?: string
	title?: string
	subtitle?: string
	footer?: string
	buttonText?: string
	id?: string
	thumbnail?: Buffer | string
	audioFooter?: WAMediaUpload
	bizJid?: string
	shopSurface?: proto.Message.InteractiveMessage.ShopMessage.Surface

	buttons?: ArkonButton[]
	sections?: ArkonSection[]
	templateButtons?: ArkonTemplateButton[]
	cards?: ArkonCard[]

	/** image/video items sent one after another as a single album */
	album?: (Record<string, unknown> & ({ image: WAMediaUpload } | { video: WAMediaUpload }))[]

	cover?: WAMediaUpload
	stickers?: ArkonSticker[]
	name?: string
	publisher?: string
	description?: string

	externalAdReply?: ArkonExternalAdReply
	groupStatus?: boolean
	interactiveAsTemplate?: boolean
	ephemeral?: boolean
	viewOnce?: boolean
	viewOnceV2?: boolean
	viewOnceV2Extension?: boolean

	mentions?: string[]
	mentionAll?: boolean
	contextInfo?: proto.IContextInfo
	edit?: WAMessageKey

	/** media header/body, handled by the stock media preparation */
	image?: WAMediaUpload
	video?: WAMediaUpload
	document?: WAMediaUpload
	audio?: WAMediaUpload
	sticker?: WAMediaUpload
	mimetype?: string
	fileName?: string
	ptv?: boolean
	gifPlayback?: boolean

	/** send the rest of the object as the message proto, untouched */
	raw?: boolean
	isLottie?: boolean
	/** AI icon on the message; private chats only */
	ai?: boolean
	keep?: WAMessageKey
	type?: number
	flowReply?: { format?: number; text?: string; name?: string; paramsJson?: string; version?: number }
	poll?: import('./extra-content').ArkonPollOptions
	pollResult?: { name: string; votes: { name: string; voteCount: number | string }[]; pollType?: number }
	pollUpdate?: {
		key: WAMessageKey
		vote: proto.Message.IPollEncValue
		metadata?: proto.Message.IPollUpdateMessageMetadata
	}
	product?: Record<string, unknown>
	businessOwnerJid?: string
	paymentInviteServiceType?: proto.Message.PaymentInviteMessage.ServiceType
	orderText?: string
	requestPaymentFrom?: string
	invoiceNote?: string
}
