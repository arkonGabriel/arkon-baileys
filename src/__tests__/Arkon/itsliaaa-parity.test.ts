/**
 * The Arkon builders must produce the same messages as @itsliaaa/baileys, which the Arkon Bot used
 * before: same input, same proto. Fields that are random or time based on every call are blanked.
 */
import {
	generateWAMessageContent as liaGenerate,
	getBizBinaryNode as liaGetBizNode,
	shouldIncludeBizBinaryNode as liaShouldIncludeBiz
} from '@itsliaaa/baileys'
import { readFileSync } from 'fs'
import { join } from 'path'
import { proto } from '../../../WAProto/index.js'
import { getBizBinaryNode, shouldIncludeBizBinaryNode } from '../../Arkon/biz-node'
import type { AnyMessageContent, MessageContentGenerationOptions } from '../../Types'
import { generateWAMessageContent } from '../../Utils/messages'
import type { BinaryNode } from '../../WABinary'

const IMAGE = readFileSync(join(process.cwd(), 'Media/cat.jpeg'))

const RANDOM_FIELDS = new Set([
	'messageSecret',
	'mediaKey',
	'fileEncSha256',
	'mediaKeyTimestamp',
	'directPath',
	'url',
	'jpegThumbnail',
	'templateId',
	'thumbnailUrl'
])

const normalize = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(normalize)
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const [key, inner] of Object.entries(value)) {
			if (RANDOM_FIELDS.has(key)) {
				out[key] = '<random>'
			} else if (key === 'buttonParamsJson' || key === 'paramsJson' || key === 'messageParamsJson') {
				out[key] = typeof inner === 'string' && inner ? JSON.parse(inner) : inner
			} else {
				out[key] = normalize(inner)
			}
		}

		return out
	}

	return value
}

const options = (): MessageContentGenerationOptions => ({
	upload: async () => ({ mediaUrl: 'https://mmg.whatsapp.net/x', directPath: '/x' }),
	getUrlInfo: async () => undefined
})

// both generators mutate their input, so each gets its own copy; structuredClone would turn Buffers into Uint8Arrays
const clone = (value: unknown): unknown => {
	if (Buffer.isBuffer(value)) return value
	if (Array.isArray(value)) return value.map(clone)
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clone(inner)]))
	}

	return value
}

const both = async (content: Record<string, unknown>) => {
	const ours = await generateWAMessageContent(clone(content) as AnyMessageContent, options())
	const theirs = await liaGenerate(clone(content) as never, options() as never)
	const toJson = (message: unknown) =>
		normalize(
			proto.Message.toObject(proto.Message.decode(proto.Message.encode(message as proto.IMessage).finish()), {
				longs: String,
				enums: String,
				bytes: String
			})
		)
	return { ours: toJson(ours), theirs: toJson(theirs) }
}

const SECTIONS = [
	{
		title: 'Atalhos',
		highlight_label: 'Top',
		rows: [
			{ header: '', title: 'Menu', description: '', id: '#menu' },
			{ header: '', title: 'Ajuda', description: 'ajuda', id: '#ajuda' }
		]
	}
]

const CASES: [string, Record<string, unknown>][] = [
	[
		'buttons with text and a single select (!botoes, !menubotoes)',
		{
			text: 'Escolha uma opção:',
			footer: 'Arkon',
			buttons: [
				{ text: 'Opção A', id: '#a' },
				{ text: 'Opção B', id: '#b' },
				{ text: 'Mais', sections: SECTIONS }
			]
		}
	],
	[
		'buttons with an image header',
		{ image: IMAGE, caption: 'legenda', footer: 'Arkon', buttons: [{ text: 'A', id: '#a' }] }
	],
	['list message', { text: 'descrição', title: 'Título', buttonText: 'Abrir', footer: 'Arkon', sections: SECTIONS }],
	[
		'interactive with image, offer and bottom sheet (!interativa)',
		{
			image: IMAGE,
			caption: 'Interativa!',
			footer: 'Arkon',
			optionText: 'Selecionar opções',
			optionTitle: 'Opções',
			offerText: 'Oferta!',
			offerCode: 'ARKON10',
			offerUrl: 'https://www.arkonlabs.shop',
			offerExpiration: 1_900_000_000_000,
			nativeFlow: [
				{ text: 'Olá', id: '#hello' },
				{ text: 'Ligar', call: '5516999999999' },
				{ text: 'Copiar', copy: 'ARKON' },
				{ text: 'Link', url: 'https://wa.me' },
				{ text: 'Seções', sections: SECTIONS }
			]
		}
	],
	[
		'interactive with text body',
		{ text: 'corpo', footer: 'rodapé', nativeFlow: [{ text: 'A', id: '#a', icon: 'review' }] }
	],
	[
		'carousel with image cards (!carrossel)',
		{
			text: 'Carrossel',
			footer: 'Arkon',
			cards: [
				{ image: IMAGE, caption: 'Slide 1', footer: 'Card 1', nativeFlow: [{ text: 'Abrir', url: 'https://wa.me' }] },
				{
					image: IMAGE,
					caption: 'Slide 2',
					footer: 'Card 2',
					offerText: 'Oferta',
					offerCode: 'ARKON20',
					offerUrl: 'https://www.arkonlabs.shop',
					nativeFlow: [{ text: 'Copiar', copy: 'ARKON20' }]
				},
				{
					image: IMAGE,
					caption: 'Slide 3',
					optionText: 'Escolher',
					nativeFlow: [
						{ text: 'Comprar', id: '#comprar' },
						{ text: 'Ligar', call: '5516999999999' }
					]
				}
			]
		}
	],
	[
		'template buttons',
		{
			text: 'modelo',
			footer: 'Arkon',
			templateButtons: [
				{ text: 'A', id: '#a' },
				{ text: 'Site', url: 'https://www.arkonlabs.shop' },
				{ text: 'Ligar', call: '5516999999999' }
			]
		}
	],
	['interactive as template', { text: 't', nativeFlow: [{ text: 'A', id: '#a' }], interactiveAsTemplate: true }],
	['group status with image (!statusgrupo)', { image: IMAGE, caption: 'Status do grupo', groupStatus: true }],
	['group status with text', { text: 'Status', groupStatus: true }],
	[
		'external ad reply on text',
		{
			text: 'anúncio',
			externalAdReply: { title: 'Arkon', body: 'corpo', url: 'https://www.arkonlabs.shop', largeThumbnail: true }
		}
	],
	['mentions on buttons', { text: 'oi @1', mentions: ['1@s.whatsapp.net'], buttons: [{ text: 'A', id: '#a' }] }],
	['mention all on interactive', { text: 'todos', mentionAll: true, nativeFlow: [{ text: 'A', id: '#a' }] }],
	['ephemeral wrapper', { text: 'some', ephemeral: true }],
	['view once v2 image', { image: IMAGE, caption: 'uma vez', viewOnceV2: true }],
	['view once v2 extension', { image: IMAGE, viewOnceV2Extension: true }],
	[
		'album header',
		{
			album: [
				{ image: IMAGE, caption: '1' },
				{ image: IMAGE, caption: '2' },
				{ video: IMAGE, caption: '3' }
			]
		}
	]
]

describe('Arkon builders match @itsliaaa/baileys', () => {
	it.each(CASES)('%s', async (_, content) => {
		const { ours, theirs } = await both(content)
		expect(ours).toEqual(theirs)
	})

	it('leaves plain messages to the stock generator', async () => {
		const message = await generateWAMessageContent({ text: 'oi' }, options())
		expect(message.extendedTextMessage?.text).toBe('oi')
		expect(message.buttonsMessage).toBeFalsy()
	})
})

describe('sticker pack matches @itsliaaa/baileys', () => {
	it('builds the same pack metadata', async () => {
		const content = {
			cover: IMAGE,
			stickers: [{ data: IMAGE }, { data: IMAGE, emojis: ['😺'], accessibilityLabel: 'gato' }],
			name: 'Pack Arkon',
			publisher: 'Arkon Bot',
			description: 'teste'
		}
		const { ours, theirs } = await both(content)
		const blank = (message: unknown) => {
			const pack = (message as { stickerPackMessage: Record<string, unknown> }).stickerPackMessage
			// the pack id is random and is also the tray icon name inside the zip, so the zip size and hash vary with it
			for (const key of [
				'stickerPackId',
				'trayIconFileName',
				'fileSha256',
				'fileLength',
				'stickerPackSize',
				'thumbnailSha256',
				'thumbnailEncSha256',
				'imageDataHash'
			]) {
				pack[key] = '<random>'
			}

			return message
		}

		expect(blank(ours)).toEqual(blank(theirs))
		expect((ours as { stickerPackMessage: { stickers: unknown[] } }).stickerPackMessage.stickers).toHaveLength(2)
	})
})

describe('biz node matches @itsliaaa/baileys', () => {
	const blankNode = (node: BinaryNode): BinaryNode => ({
		...node,
		attrs: { ...node.attrs, privacy_mode_ts: '<ts>', ...(node.attrs.decision_id ? { decision_id: '<id>' } : {}) },
		content: Array.isArray(node.content) ? node.content.map(blankNode) : node.content
	})

	const MESSAGES: [string, proto.IMessage][] = [
		['buttons', { buttonsMessage: { contentText: 'x' } }],
		['list', { listMessage: { title: 'x' } }],
		['template', { templateMessage: {} }],
		['mixed native flow', { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'quick_reply' }] } } }],
		['catalog native flow', { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'cta_catalog' }] } } }],
		['payment native flow', { interactiveMessage: { nativeFlowMessage: { buttons: [{ name: 'review_and_pay' }] } } }],
		['plain text', { conversation: 'oi' }]
	]

	it.each(MESSAGES)('%s', (_, message) => {
		expect(shouldIncludeBizBinaryNode(message)).toBe(liaShouldIncludeBiz(message as never))
		if (shouldIncludeBizBinaryNode(message)) {
			expect(blankNode(getBizBinaryNode(message))).toEqual(blankNode(liaGetBizNode(message as never) as BinaryNode))
		}
	})
})
