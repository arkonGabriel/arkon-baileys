import type { proto } from '../../WAProto/index.js'

/** true when `obj` has `key` set to something other than null or undefined */
export const hasOptionalProperty = <K extends PropertyKey>(obj: unknown, key: K): obj is Record<K, unknown> =>
	obj !== null &&
	obj !== undefined &&
	typeof obj === 'object' &&
	key in obj &&
	(obj as Record<K, unknown>)[key] !== null &&
	(obj as Record<K, unknown>)[key] !== undefined

/** album items can only be images or videos */
export const hasValidAlbumMedia = (message: proto.IMessage) => !!(message.imageMessage || message.videoMessage)

/** media an interactive message accepts as header */
export const hasValidInteractiveHeader = (message: proto.IMessage) =>
	!!(
		message.imageMessage ||
		message.videoMessage ||
		message.documentMessage ||
		message.productMessage ||
		message.locationMessage
	)

/** media a carousel card accepts as header */
export const hasValidCarouselHeader = (message: proto.IMessage) =>
	!!(message.imageMessage || message.videoMessage || message.productMessage)
