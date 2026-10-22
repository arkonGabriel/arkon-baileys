/**
 * Etapa 2b-2: the store, auth states and helpers brought from @itsliaaa/baileys.
 */
import {
	decryptMessageEdit as liaDecryptMessageEdit,
	hasValidAlbumMedia as liaHasValidAlbumMedia,
	hasValidCarouselHeader as liaHasValidCarouselHeader,
	hasValidInteractiveHeader as liaHasValidInteractiveHeader
} from '@itsliaaa/baileys'
import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import P from 'pino'
import { proto } from '../../../WAProto/index.js'
import { hasValidAlbumMedia, hasValidCarouselHeader, hasValidInteractiveHeader } from '../../Arkon/validators'
import { makeInMemoryStore, makeOrderedDictionary, storeChatId } from '../../Store'
import type { BaileysEventEmitter, BaileysEventMap, GroupMetadata, SignalKeyStore, WAMessage } from '../../Types'
import { addTransactionCapability, initAuthCreds } from '../../Utils/auth-utils'
import { aesEncryptGCM, hmacSign } from '../../Utils/crypto'
import { extractVideoThumb } from '../../Utils/messages-media'
import processMessage, { decryptMessageEdit } from '../../Utils/process-message'
import { useSingleFileAuthState } from '../../Utils/use-single-file-auth-state'
import { type SqliteDatabase, useSqliteAuthState } from '../../Utils/use-sqlite-auth-state'

const logger = P({ level: 'silent' })
const PN = '5511999999999@s.whatsapp.net'
const LID = '123456789@lid'

const makeEmitter = () => {
	const emitter = new EventEmitter()
	return {
		ev: emitter as unknown as BaileysEventEmitter,
		emit: <T extends keyof BaileysEventMap>(event: T, data: BaileysEventMap[T]) => emitter.emit(event, data)
	}
}

const message = (id: string, remoteJid: string, remoteJidAlt?: string, text = 'oi'): WAMessage => ({
	key: { id, remoteJid, remoteJidAlt, fromMe: false },
	message: { conversation: text },
	messageTimestamp: 1_700_000_000
})

describe('in-memory store', () => {
	it('keeps a LID chat under its phone number and still finds it by LID', async () => {
		const store = makeInMemoryStore({ logger })
		const { ev, emit } = makeEmitter()
		store.bind(ev)

		emit('messages.upsert', { messages: [message('A', LID, PN)], type: 'notify' })

		expect(storeChatId({ remoteJid: LID, remoteJidAlt: PN })).toBe(PN)
		expect(store.messages[PN]?.array.map(m => m.key.id)).toEqual(['A'])
		expect(store.chats.get(PN)?.unreadCount).toBe(1)
		expect((await store.loadMessage(LID, 'A'))?.key.id).toBe('A')

		// an update addressed by LID reaches the same message
		emit('messages.update', [{ key: { id: 'A', remoteJid: LID, remoteJidAlt: PN }, update: { status: 3 } }])
		expect((await store.loadMessage(PN, 'A'))?.status).toBe(3)
	})

	it('keeps at most maxMessagesPerChat messages, dropping the oldest', async () => {
		const store = makeInMemoryStore({ logger, maxMessagesPerChat: 2 })
		const { ev, emit } = makeEmitter()
		store.bind(ev)

		emit('messages.upsert', { messages: ['1', '2', '3'].map(id => message(id, PN)), type: 'append' })

		expect(store.messages[PN]?.array.map(m => m.key.id)).toEqual(['2', '3'])
		expect(await store.loadMessage(PN, '1')).toBeUndefined()
		expect((await store.mostRecentMessage(PN))?.key.id).toBe('3')
		expect((await store.loadMessages(PN, 1)).map(m => m.key.id)).toEqual(['3'])
	})

	it('tracks group participants', () => {
		const store = makeInMemoryStore({ logger })
		const { ev, emit } = makeEmitter()
		store.bind(ev)
		const group = { id: '1@g.us', subject: 'Arkon', participants: [{ id: LID, phoneNumber: PN }] } as GroupMetadata
		emit('groups.upsert', [group])

		const author = 'x@s.whatsapp.net'
		emit('group-participants.update', { id: group.id, author, participants: [{ id: LID }], action: 'promote' })
		expect(store.groupMetadata[group.id]?.participants[0]?.admin).toBe('admin')

		emit('group-participants.update', {
			id: group.id,
			author,
			participants: [{ id: '2@lid', phoneNumber: '552@s.whatsapp.net' }],
			action: 'add'
		})
		emit('group-participants.update', { id: group.id, author, participants: [{ id: LID }], action: 'remove' })
		expect(store.groupMetadata[group.id]?.participants.map(p => p.id)).toEqual(['2@lid'])
	})

	it('goes through every contact update in a batch', async () => {
		const store = makeInMemoryStore({ logger })
		const { ev, emit } = makeEmitter()
		store.bind(ev)
		emit('contacts.upsert', [
			{ id: PN, imgUrl: 'a' },
			{ id: '552@s.whatsapp.net', imgUrl: 'b' }
		])

		emit('contacts.update', [{ id: 'unknown@s.whatsapp.net' }, { id: '552@s.whatsapp.net', imgUrl: 'removed' }])
		await new Promise(resolve => setImmediate(resolve))

		expect(store.contacts['552@s.whatsapp.net']?.imgUrl).toBeUndefined()
		expect(store.contacts[PN]?.imgUrl).toBe('a')
	})

	it('saves to and loads from JSON', async () => {
		const store = makeInMemoryStore({ logger })
		const { ev, emit } = makeEmitter()
		store.bind(ev)
		emit('chats.upsert', [{ id: PN, conversationTimestamp: 1 }])
		emit('contacts.upsert', [{ id: PN, name: 'Gabriel' }])
		emit('messages.upsert', { messages: [message('A', PN)], type: 'append' })

		const copy = makeInMemoryStore({ logger })
		copy.fromJSON(JSON.parse(JSON.stringify(store.toJSON())))

		expect(copy.chats.get(PN)?.id).toBe(PN)
		expect(copy.contacts[PN]?.name).toBe('Gabriel')
		expect((await copy.loadMessage(PN, 'A'))?.message?.conversation).toBe('oi')
	})

	it('finds items by id after an ordered dictionary is loaded from JSON', () => {
		const dict = makeOrderedDictionary<{ id: string }>(item => item.id)
		dict.fromJSON([{ id: 'a' }, { id: 'b' }])
		expect(dict.get('b')).toEqual({ id: 'b' })
		expect(dict.array).toHaveLength(2)
	})
})

describe('single file auth state', () => {
	it('writes the keys and creds to one file and reads them back', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'arkon-auth-'))
		const file = join(dir, 'auth.json')
		try {
			const { state, saveCreds, flush } = await useSingleFileAuthState(file)
			await state.keys.set({ 'pre-key': { '1': { public: Buffer.from([1]), private: Buffer.from([2]) } } })
			await saveCreds()
			await flush()

			const raw = JSON.parse(await readFile(file, 'utf-8'))
			expect(Object.keys(raw).sort()).toEqual(['creds', 'pre-key1'])

			const reloaded = await useSingleFileAuthState(file)
			expect(reloaded.state.creds.registrationId).toBe(state.creds.registrationId)
			const keys = await reloaded.state.keys.get('pre-key', ['1', '2'])
			expect(Buffer.from(keys['1']!.private)).toEqual(Buffer.from([2]))
			expect(keys['2']).toBeUndefined()

			await reloaded.state.keys.set({ 'pre-key': { '1': null } })
			await reloaded.flush()
			expect(Object.keys(JSON.parse(await readFile(file, 'utf-8')))).toEqual(['creds'])
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})

/** a stand-in for SQLite that understands only the statements the auth state uses */
const fakeSqlite = () => {
	const creds = new Map<string, string>()
	const keys = new Map<string, string>()
	const statements: Record<string, { get?: (...p: string[]) => unknown; run?: (...p: string[]) => unknown }> = {
		'SELECT value FROM creds WHERE key = ?': { get: k => (creds.has(k) ? { value: creds.get(k) } : undefined) },
		'INSERT INTO creds': { run: (k, v) => creds.set(k, v) },
		'SELECT value FROM signal_keys': { get: (t, i) => (keys.has(t + i) ? { value: keys.get(t + i) } : undefined) },
		'INSERT INTO signal_keys': { run: (t, i, v) => keys.set(t + i, v) },
		'DELETE FROM signal_keys': { run: (t, i) => keys.delete(t + i) }
	}
	const db: SqliteDatabase = {
		exec: () => undefined,
		prepare: sql => {
			const statement = Object.entries(statements).find(([prefix]) => sql.startsWith(prefix))?.[1]
			if (!statement) throw new Error('unexpected sql: ' + sql)
			return { get: statement.get || (() => undefined), run: statement.run || (() => undefined) }
		}
	}
	return { db, creds, keys }
}

describe('sqlite auth state', () => {
	it('stores creds and keys as rows', async () => {
		const { db, creds, keys } = fakeSqlite()
		const { state, saveCreds } = await useSqliteAuthState({ database: db })
		await saveCreds()
		await state.keys.set({ 'sender-key': { a: Buffer.from('x') } })
		expect(creds.size).toBe(1)
		expect(keys.size).toBe(1)

		const reloaded = await useSqliteAuthState({ database: db })
		expect(reloaded.state.creds.registrationId).toBe(state.creds.registrationId)
		expect(Buffer.from((await reloaded.state.keys.get('sender-key', ['a'])).a!)).toEqual(Buffer.from('x'))

		await reloaded.state.keys.set({ 'sender-key': { a: null } })
		expect(keys.size).toBe(0)
	})
})

describe('signal key transactions', () => {
	const memoryStore = (): SignalKeyStore => {
		const data: Record<string, unknown> = {}
		return {
			get: async (type, ids) => Object.fromEntries(ids.map(id => [id, data[type + id]])) as never,
			set: async set => {
				for (const type in set) {
					for (const id in set[type as keyof typeof set]) {
						data[type + id] = set[type as keyof typeof set]![id]
					}
				}
			}
		}
	}

	it('keeps each store in its own transaction, even when nested', async () => {
		const options = { maxCommitRetries: 1, delayBetweenTriesMs: 1 }
		const first = addTransactionCapability(memoryStore(), logger, options)
		const second = addTransactionCapability(memoryStore(), logger, options)

		await first.transaction(async () => {
			expect(first.isInTransaction()).toBe(true)
			expect(second.isInTransaction()).toBe(false)
			await second.transaction(async () => {
				expect(second.isInTransaction()).toBe(true)
				await second.set({ 'sender-key': { b: Buffer.from('2') } })
			}, 'b')
			await first.set({ 'sender-key': { a: Buffer.from('1') } })
		}, 'a')

		expect((await first.get('sender-key', ['a', 'b'])).b).toBeUndefined()
		expect((await second.get('sender-key', ['b'])).b).toBeDefined()
	})
})

describe('encrypted message edits', () => {
	it('decrypts an edit like @itsliaaa/baileys', () => {
		const ctx = {
			originalSenderJid: PN,
			originalMsgId: 'ORIGINAL',
			editEncKey: randomBytes(32),
			editorJid: PN
		}
		const sign = Buffer.concat([
			Buffer.from(ctx.originalMsgId),
			Buffer.from(ctx.originalSenderJid),
			Buffer.from(ctx.editorJid),
			Buffer.from('Message Edit'),
			new Uint8Array([1])
		])
		const key = hmacSign(sign, hmacSign(ctx.editEncKey, new Uint8Array(32), 'sha256'), 'sha256')
		const encIv = randomBytes(12)
		const edited = proto.Message.encode({
			protocolMessage: { editedMessage: { conversation: 'texto novo' } }
		}).finish()
		const encPayload = aesEncryptGCM(edited, key, encIv, Buffer.alloc(0))

		const ours = decryptMessageEdit({ encPayload, encIv }, ctx)
		expect(ours.protocolMessage?.editedMessage?.conversation).toBe('texto novo')
		expect(proto.Message.encode(ours).finish()).toEqual(
			proto.Message.encode(liaDecryptMessageEdit({ encPayload, encIv }, ctx) as proto.IMessage).finish()
		)
	})
})

describe('encrypted message edits in processMessage', () => {
	it('emits the decrypted edit as a messages.update', async () => {
		const messageSecret = randomBytes(32)
		const original = { key: { id: 'ORIGINAL', remoteJid: PN, fromMe: false } }
		const sign = Buffer.concat([
			Buffer.from('ORIGINAL'),
			Buffer.from(PN),
			Buffer.from(PN),
			Buffer.from('Message Edit'),
			new Uint8Array([1])
		])
		const key = hmacSign(sign, hmacSign(messageSecret, new Uint8Array(32), 'sha256'), 'sha256')
		const encIv = randomBytes(12)
		const plaintext = proto.Message.encode({
			protocolMessage: { editedMessage: { conversation: 'editado' }, timestampMs: 1_700_000_005_000 }
		}).finish()

		const updates: BaileysEventMap['messages.update'][] = []
		const { ev } = makeEmitter()
		;(ev as unknown as EventEmitter).emit = ((event: string, data: unknown) => {
			if (event === 'messages.update') updates.push(data as BaileysEventMap['messages.update'])
			return true
		}) as never

		await processMessage(
			{
				key: { id: 'EDIT', remoteJid: PN, fromMe: false },
				message: {
					secretEncryptedMessage: {
						targetMessageKey: original.key,
						encPayload: aesEncryptGCM(plaintext, key, encIv, Buffer.alloc(0)),
						encIv,
						secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
					}
				},
				messageTimestamp: 1_700_000_005
			},
			{
				ev,
				creds: { ...initAuthCreds(), me: { id: '5511888888888@s.whatsapp.net' } },
				signalRepository: { lidMapping: { getPNForLID: async () => undefined } } as never,
				keyStore: {} as never,
				logger,
				options: {},
				getMessage: async () => ({ messageContextInfo: { messageSecret } })
			} as never
		)

		expect(updates).toHaveLength(1)
		expect(updates[0]![0]!.key.id).toBe('ORIGINAL')
		expect(updates[0]![0]!.update.message?.editedMessage?.message?.conversation).toBe('editado')
		expect(updates[0]![0]!.update.messageTimestamp).toBe(1_700_000_005)
	})
})

describe('helpers match @itsliaaa/baileys', () => {
	const messages: proto.IMessage[] = [
		{ imageMessage: {} },
		{ videoMessage: {} },
		{ documentMessage: {} },
		{ productMessage: {} },
		{ locationMessage: {} },
		{ conversation: 'oi' }
	]

	it.each(messages.map(m => [Object.keys(m)[0], m] as const))('validates %s the same way', (_, m) => {
		expect(hasValidAlbumMedia(m)).toBe(liaHasValidAlbumMedia(m as never))
		expect(hasValidInteractiveHeader(m)).toBe(liaHasValidInteractiveHeader(m as never))
		expect(hasValidCarouselHeader(m)).toBe(liaHasValidCarouselHeader(m as never))
	})
})

describe('video thumbnail', () => {
	it('never runs a file name through a shell', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'arkon-thumb-'))
		const marker = join(dir, 'pwned')
		try {
			await expect(extractVideoThumb(`x.mp4; touch ${marker}`, '00:00:00', { width: 32, height: 32 })).rejects.toThrow()
			await expect(readFile(marker)).rejects.toThrow()
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
})
