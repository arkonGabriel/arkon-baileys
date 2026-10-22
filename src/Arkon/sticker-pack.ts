import { Boom } from '@hapi/boom'
import { zip, type Zippable } from 'fflate'
import { promises as fs } from 'fs'
import { proto } from '../../WAProto/index.js'
import type { MessageContentGenerationOptions, WAMediaUpload } from '../Types'
import { sha256 } from '../Utils/crypto'
import { generateMessageIDV2, unixTimestampSeconds } from '../Utils/generics'
import { encryptedStream, getStream, toBuffer } from '../Utils/messages-media'
import type { ArkonSticker } from './types'

const CONCURRENCY_LIMIT = 15
const MAX_STICKERS = 60
const MAX_STICKER_BYTES = 1024 * 1024

export type StickerPackContent = {
	cover: WAMediaUpload
	stickers: ArkonSticker[]
	name?: string
	publisher?: string
	description?: string
}

const isWebPBuffer = (buffer: Buffer) =>
	buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP'

const isAnimatedWebP = (buffer: Buffer) => {
	if (!isWebPBuffer(buffer)) {
		return false
	}

	let offset = 12
	while (offset < buffer.length - 8) {
		const chunk = buffer.toString('ascii', offset, offset + 4)
		const size = buffer.readUInt32LE(offset + 4)
		if (chunk === 'VP8X') {
			// bit 1 of the VP8X flags byte marks an animated file
			if (offset + 8 < buffer.length && buffer[offset + 8]! & 0x02) {
				return true
			}
		} else if (chunk === 'ANIM' || chunk === 'ANMF') {
			return true
		}

		offset += 8 + size + (size % 2)
	}

	return false
}

type SharpLike = (input: Buffer) => {
	resize: (w: number, h?: number, o?: { fit?: string }) => ReturnType<SharpLike>
	webp: (o: { quality: number }) => ReturnType<SharpLike>
	jpeg: () => ReturnType<SharpLike>
	toBuffer: () => Promise<Buffer>
}

const loadSharp = async (): Promise<SharpLike | undefined> => {
	try {
		// @ts-ignore optional dependency
		const mod = await import('sharp')
		return (mod.default || mod) as SharpLike
	} catch {
		return undefined
	}
}

/**
 * Builds and uploads a sticker pack: every sticker is converted to a 512px WebP, zipped with the
 * cover as tray icon, encrypted and uploaded; the cover also becomes the pack thumbnail.
 */
export const prepareStickerPackMessage = async (
	message: StickerPackContent,
	options: MessageContentGenerationOptions
): Promise<proto.Message.IStickerPackMessage> => {
	const {
		cover,
		stickers = [],
		name = '📦 Sticker Pack',
		publisher = 'Arkon Bot',
		description = '🏷️ Arkon Labs'
	} = message
	if (stickers.length > MAX_STICKERS) {
		throw new Boom(`Sticker pack exceeds the maximum limit of ${MAX_STICKERS} stickers`, { statusCode: 400 })
	}

	if (!stickers.length) {
		throw new Boom('Sticker pack must contain at least one sticker', { statusCode: 400 })
	}

	if (!cover) {
		throw new Boom('Sticker pack must contain a cover', { statusCode: 400 })
	}

	const { logger, mediaCache } = options
	const urls = stickers
		.map(sticker => (typeof sticker.data === 'object' && 'url' in sticker.data ? String(sticker.data.url) : undefined))
		.filter(Boolean)
	const cacheKey = mediaCache && urls.length ? 'sticker:' + urls.join('@') : undefined
	if (cacheKey) {
		const cached = await mediaCache!.get<Buffer>(cacheKey)
		if (cached) {
			logger?.debug({ cacheKey }, 'got media cache hit')
			return proto.Message.StickerPackMessage.decode(cached)
		}
	}

	const sharp = await loadSharp()
	const toWebP = async (buffer: Buffer) => {
		if (isWebPBuffer(buffer)) {
			return buffer
		}

		if (!sharp) {
			throw new Boom('sharp is required to convert stickers to WebP', { statusCode: 400 })
		}

		return sharp(buffer).resize(512, 512, { fit: 'inside' }).webp({ quality: 80 }).toBuffer()
	}

	const packId = generateMessageIDV2()
	const files: Zippable = {}
	const metadata: proto.Message.StickerPackMessage.ISticker[] = new Array(stickers.length)
	for (let start = 0; start < stickers.length; start += CONCURRENCY_LIMIT) {
		await Promise.all(
			stickers.slice(start, start + CONCURRENCY_LIMIT).map(async (sticker, offset) => {
				const index = start + offset
				const { stream } = await getStream(sticker.data, options.options)
				const raw = await toBuffer(stream)
				const webp = await toWebP(raw)
				if (webp.length > MAX_STICKER_BYTES) {
					throw new Boom(`Sticker at index ${index} exceeds the 1MB size limit`, { statusCode: 400 })
				}

				const fileName = `${sha256(webp).toString('base64').replace(/\//g, '-')}.webp`
				files[fileName] = [new Uint8Array(webp), { level: 0 }]
				metadata[index] = {
					fileName,
					mimetype: 'image/webp',
					isAnimated: isAnimatedWebP(raw),
					emojis: sticker.emojis || ['✨'],
					accessibilityLabel: sticker.accessibilityLabel || '‎'
				}
			})
		)
	}

	const trayIconFileName = `${packId}.webp`
	const coverBuffer = await toBuffer((await getStream(cover, options.options)).stream)
	files[trayIconFileName] = [new Uint8Array(await toWebP(coverBuffer)), { level: 0 }]

	const zipBuffer = await new Promise<Buffer>((resolve, reject) =>
		zip(files, (error, data) => (error ? reject(error) : resolve(Buffer.from(data))))
	)

	const pack = await encryptedStream(zipBuffer, 'sticker-pack', { logger, opts: options.options })
	let packUpload
	try {
		packUpload = await options.upload(pack.encFilePath, {
			fileEncSha256B64: pack.fileEncSha256.toString('base64'),
			mediaType: 'sticker-pack',
			timeoutMs: options.mediaUploadTimeoutMs
		})
	} finally {
		fs.unlink(pack.encFilePath).catch(() => logger?.warn('failed to remove tmp file'))
	}

	const obj: proto.Message.IStickerPackMessage = {
		name,
		publisher,
		stickerPackId: packId,
		packDescription: description,
		stickerPackOrigin: proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
		stickerPackSize: zipBuffer.length,
		stickers: metadata,
		fileSha256: pack.fileSha256,
		fileEncSha256: pack.fileEncSha256,
		mediaKey: pack.mediaKey,
		directPath: packUpload.directPath,
		fileLength: pack.fileLength,
		mediaKeyTimestamp: unixTimestampSeconds(),
		trayIconFileName
	}

	// a pack without thumbnail still works, so a failure here only loses the preview
	if (sharp) {
		try {
			const thumbnail = await sharp(coverBuffer).resize(252, 252).jpeg().toBuffer()
			const thumb = await encryptedStream(thumbnail, 'thumbnail-sticker-pack', {
				logger,
				opts: options.options,
				mediaKey: pack.mediaKey
			})
			let thumbUpload
			try {
				thumbUpload = await options.upload(thumb.encFilePath, {
					fileEncSha256B64: thumb.fileEncSha256.toString('base64'),
					mediaType: 'thumbnail-sticker-pack',
					timeoutMs: options.mediaUploadTimeoutMs
				})
			} finally {
				fs.unlink(thumb.encFilePath).catch(() => logger?.warn('failed to remove tmp file'))
			}

			Object.assign(obj, {
				thumbnailDirectPath: thumbUpload.directPath,
				thumbnailSha256: thumb.fileSha256,
				thumbnailEncSha256: thumb.fileEncSha256,
				thumbnailHeight: 252,
				thumbnailWidth: 252,
				imageDataHash: sha256(thumbnail).toString('base64')
			})
		} catch (err) {
			logger?.warn({ err }, 'sticker pack thumbnail generation failed')
		}
	}

	if (cacheKey) {
		await mediaCache!.set(cacheKey, Buffer.from(proto.Message.StickerPackMessage.encode(obj).finish()))
	}

	return proto.Message.StickerPackMessage.fromObject(obj)
}
