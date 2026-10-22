import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import type { MessageContentGenerationOptions, WAMediaUpload, WAMessageContent } from '../Types'
import { generateMessageIDV2 } from '../Utils/generics'
import { prepareWAMessageMedia } from '../Utils/messages'
import { ARKON_DEFAULT_CURRENCY, ARKON_LIBRARY_NAME } from './constants'
import type { ArkonMessageContent } from './types'

type MediaInput = Parameters<typeof prepareWAMessageMedia>[0]

export type ArkonPollOptions = {
	name: string
	values: string[]
	selectableCount?: number
	toAnnouncementGroup?: boolean
	messageSecret?: Uint8Array
	endDate?: Date
	hideVoter?: boolean
	canAddOption?: boolean
	/** 1 = quiz, only accepted in newsletters */
	pollType?: proto.Message.PollType
	correctAnswer?: string | number
}

export type ArkonProductContent = {
	product: proto.Message.IProductMessage['product'] & { productImage?: WAMediaUpload }
	businessOwnerJid: string
	image?: WAMediaUpload
} & Record<string, unknown>

/** a poll with any option the stock generator does not know (quiz, end date, hidden voters, open options) */
export const isArkonPoll = (poll: unknown): poll is ArkonPollOptions =>
	!!poll &&
	typeof poll === 'object' &&
	['pollType', 'endDate', 'hideVoter', 'canAddOption', 'correctAnswer'].some(key => key in poll)

export const preparePollMessage = (poll: ArkonPollOptions): WAMessageContent => {
	poll.selectableCount ||= 0
	poll.toAnnouncementGroup ||= false
	if (!Array.isArray(poll.values)) {
		throw new Boom('Invalid poll values', { statusCode: 400 })
	}

	if (poll.selectableCount < 0 || poll.selectableCount > poll.values.length) {
		throw new Boom(`poll.selectableCount in poll should be >= 0 and <= ${poll.values.length}`, { statusCode: 400 })
	}

	const pollCreationMessage = {
		name: poll.name,
		selectableOptionsCount: poll.selectableCount,
		options: poll.values.map(optionName => ({ optionName })),
		endTime: poll.endDate ? poll.endDate.getTime() : undefined,
		hideParticipantName: poll.hideVoter ?? false,
		allowAddOption: poll.canAddOption ?? false
	}
	const m: WAMessageContent = {}
	if (poll.toAnnouncementGroup) {
		m.pollCreationMessageV2 = pollCreationMessage
	} else if (poll.pollType === proto.Message.PollType.QUIZ) {
		if (poll.correctAnswer === undefined || poll.correctAnswer === null || poll.correctAnswer === '') {
			throw new Boom('No "correctAnswer" provided for quiz', { statusCode: 400 })
		}

		m.pollCreationMessageV5 = {
			...pollCreationMessage,
			correctAnswer: { optionName: poll.correctAnswer.toString() },
			pollType: proto.Message.PollType.QUIZ,
			selectableOptionsCount: 1
		}
	} else if (poll.selectableCount === 1) {
		m.pollCreationMessageV3 = pollCreationMessage
	} else {
		m.pollCreationMessage = pollCreationMessage
	}

	m.messageContextInfo = { messageSecret: poll.messageSecret || randomBytes(32) }
	return m
}

export const prepareProductMessage = async (message: ArkonProductContent, options: MessageContentGenerationOptions) => {
	if (!message.businessOwnerJid) {
		throw new Boom('"businessOwnerJid" is missing from the content', { statusCode: 400 })
	}

	const { imageMessage } = await prepareWAMessageMedia(
		{ image: message.image || message.product?.productImage } as MediaInput,
		options
	)
	const content: Record<string, unknown> = { ...message }
	delete content.image
	return {
		...content,
		product: {
			currencyCode: ARKON_DEFAULT_CURRENCY,
			priceAmount1000: 1000,
			title: ARKON_LIBRARY_NAME,
			...message.product,
			productImage: imageMessage
		}
	} as proto.Message.IProductMessage
}

type ExtraContent = ArkonMessageContent

/** keys of the content types this module builds; the stock generator ignores all of them */
export const EXTRA_CONTENT_KEYS = [
	'raw',
	'keep',
	'flowReply',
	'pollResult',
	'pollUpdate',
	'paymentInviteServiceType',
	'orderText',
	'product'
] as const

/**
 * Message types from @itsliaaa/baileys that have no stock equivalent.
 * Returns undefined when none of them applies, so the stock generator handles the message.
 */
export const prepareExtraContent = async (
	message: ExtraContent,
	options: MessageContentGenerationOptions
): Promise<WAMessageContent | undefined> => {
	if (message.keep) {
		return {
			keepInChatMessage: { key: message.keep, keepType: message.type, timestampMs: Date.now() }
		}
	}

	if (message.flowReply) {
		return {
			interactiveResponseMessage: {
				body: {
					format: message.flowReply.format || proto.Message.InteractiveResponseMessage.Body.Format.DEFAULT,
					text: message.flowReply.text
				},
				nativeFlowResponseMessage: {
					name: message.flowReply.name,
					paramsJson: message.flowReply.paramsJson || '{}',
					version: message.flowReply.version || 1
				}
			}
		}
	}

	if (message.product) {
		return { productMessage: await prepareProductMessage(message as unknown as ArkonProductContent, options) }
	}

	if (message.pollResult) {
		const isQuiz = message.pollResult.pollType === proto.Message.PollType.QUIZ
		const snapshot = {
			name: message.pollResult.name,
			pollVotes: message.pollResult.votes.map(vote => ({
				optionName: vote.name,
				optionVoteCount: parseInt(String(vote.voteCount))
			})),
			pollType: isQuiz ? proto.Message.PollType.QUIZ : proto.Message.PollType.POLL
		}
		return isQuiz ? { pollResultSnapshotMessageV3: snapshot } : { pollResultSnapshotMessage: snapshot }
	}

	if (message.pollUpdate) {
		if (!message.pollUpdate.key) {
			throw new Boom('Message key is required', { statusCode: 400 })
		}

		if (!message.pollUpdate.vote) {
			throw new Boom('Encrypted vote payload is required', { statusCode: 400 })
		}

		return {
			pollUpdateMessage: {
				metadata: message.pollUpdate.metadata,
				pollCreationMessageKey: message.pollUpdate.key,
				senderTimestampMs: Date.now(),
				vote: message.pollUpdate.vote
			}
		}
	}

	if (message.paymentInviteServiceType !== undefined && message.paymentInviteServiceType !== null) {
		return {
			paymentInviteMessage: { expiryTimestamp: Date.now(), serviceType: message.paymentInviteServiceType }
		}
	}

	if (message.orderText) {
		if (!Buffer.isBuffer(message.thumbnail)) {
			throw new Boom('Must provide thumbnail buffer in order message', { statusCode: 400 })
		}

		const { orderText, ...rest } = message
		return {
			orderMessage: {
				itemCount: 1,
				messageVersion: 1,
				orderTitle: ARKON_LIBRARY_NAME,
				status: proto.Message.OrderMessage.OrderStatus.INQUIRY,
				surface: proto.Message.OrderMessage.OrderSurface.CATALOG,
				token: generateMessageIDV2(),
				totalAmount1000: 1000,
				totalCurrencyCode: ARKON_DEFAULT_CURRENCY,
				...rest,
				message: orderText
			} as proto.Message.IOrderMessage
		}
	}

	return undefined
}

/** wraps the note built so far into a payment request */
export const prepareRequestPaymentMessage = (
	message: Record<string, unknown> & { requestPaymentFrom: string },
	note: WAMessageContent
): WAMessageContent => {
	if (!note.extendedTextMessage && !note.stickerMessage) {
		throw new Boom('Invalid message type for request payment note message', { statusCode: 400 })
	}

	const { requestPaymentFrom, ...rest } = message
	return {
		requestPaymentMessage: {
			amount: { currencyCode: ARKON_DEFAULT_CURRENCY, offset: 1000, value: 1000 },
			amount1000: 1000,
			currencyCodeIso4217: ARKON_DEFAULT_CURRENCY,
			expiryTimestamp: Date.now(),
			noteMessage: note,
			requestFrom: requestPaymentFrom,
			...rest
		} as proto.Message.IRequestPaymentMessage
	}
}

/** turns the uploaded image or document built so far into an invoice attachment */
export const prepareInvoiceMessage = (invoiceNote: string, attachmentContent: WAMessageContent): WAMessageContent => {
	const attachment = attachmentContent.imageMessage || attachmentContent.documentMessage
	if (!attachment) {
		throw new Boom('Invalid media type for invoice message', { statusCode: 400 })
	}

	const isDocument = !!attachmentContent.documentMessage
	return {
		invoiceMessage: {
			attachmentType: isDocument
				? proto.Message.InvoiceMessage.AttachmentType.PDF
				: proto.Message.InvoiceMessage.AttachmentType.IMAGE,
			note: invoiceNote,
			attachmentDirectPath: attachment.directPath,
			attachmentFileEncSha256: attachment.fileEncSha256,
			attachmentFileSha256: attachment.fileSha256,
			attachmentJpegThumbnail: attachment.jpegThumbnail,
			attachmentMediaKey: attachment.mediaKey,
			attachmentMediaKeyTimestamp: attachment.mediaKeyTimestamp,
			attachmentMimetype: attachment.mimetype,
			token: generateMessageIDV2()
		}
	}
}
