/**
 * The in-memory store from Baileys v6, as brought back by @itsliaaa/baileys for v7.
 * Arkon changes: one rule for the chat a message belongs to (its phone number JID when known),
 * `loadMessage` also finds a message saved under the chat's other JID, a contact update no longer
 * drops the rest of its batch, and `maxMessagesPerChat` caps memory use.
 */
import KeyedDBModule from '@adiwajshing/keyed-db'
import { createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG } from '../Defaults'
import type {
	BaileysEventEmitter,
	Chat,
	ConnectionState,
	Contact,
	GroupMetadata,
	GroupParticipant,
	PresenceData,
	WAMessage,
	WAMessageCursor,
	WAMessageKey
} from '../Types'
import type { Label } from '../Types/Label'
import { type LabelAssociation, LabelAssociationType, type MessageLabelAssociation } from '../Types/LabelAssociation'
import { toNumber } from '../Utils/generics'
import type { ILogger } from '../Utils/logger'
import { updateMessageWithReaction, updateMessageWithReceipt } from '../Utils/messages'
import { isLidUser, jidDecode, jidNormalizedUser } from '../WABinary'
import { makeOrderedDictionary, type OrderedDictionary } from './make-ordered-dictionary'
import { ObjectRepository } from './object-repository'

type KeyedDB<T, K> = import('@adiwajshing/keyed-db').default<T, K>
// the package is CommonJS: under ESM the class can sit one `default` deeper
const KeyedDB = (KeyedDBModule as unknown as { default?: typeof KeyedDBModule }).default ?? KeyedDBModule

type Comparable<T> = { key: (item: T) => string; compare: (k1: string, k2: string) => number }

type StoreSocket = {
	profilePictureUrl: (jid: string) => Promise<string | undefined>
	groupMetadata: (jid: string) => Promise<GroupMetadata>
}

export type InMemoryStoreConfig = {
	socket?: StoreSocket
	chatKey?: Comparable<Chat>
	labelAssociationKey?: Comparable<LabelAssociation>
	logger?: ILogger
	/** keep at most this many messages per chat, dropping the oldest; unlimited by default */
	maxMessagesPerChat?: number
}

export const waChatKey = (pin: boolean): Comparable<Chat> => ({
	key: c =>
		(pin ? (c.pinned ? '1' : '0') : '') +
		(c.archived ? '0' : '1') +
		(c.conversationTimestamp ? toNumber(c.conversationTimestamp).toString(16).padStart(8, '0') : '') +
		c.id,
	compare: (k1, k2) => k2.localeCompare(k1)
})

export const waMessageID = (m: WAMessage) => m.key.id || ''

export const waLabelAssociationKey: Comparable<LabelAssociation> = {
	key: la => (la.type === LabelAssociationType.Chat ? la.chatId + la.labelId : la.chatId + la.messageId + la.labelId),
	compare: (k1, k2) => k2.localeCompare(k1)
}

/** the chat a message key belongs to: its phone number JID when the key carries one */
export const storeChatId = (key: Pick<WAMessageKey, 'remoteJid' | 'remoteJidAlt'>) => {
	const jid = key.remoteJid && isLidUser(key.remoteJid) && key.remoteJidAlt ? key.remoteJidAlt : key.remoteJid
	return jidNormalizedUser(jid!)
}

const md5Base64 = (text: string) => createHash('md5').update(text, 'utf8').digest('base64')

export const makeInMemoryStore = (config: InMemoryStoreConfig = {}) => {
	const { socket, maxMessagesPerChat } = config
	const chatKey = config.chatKey || waChatKey(true)
	const labelAssociationKey = config.labelAssociationKey || waLabelAssociationKey
	const logger = config.logger || DEFAULT_CONNECTION_CONFIG.logger.child({ stream: 'in-mem-store' })

	const chats = new KeyedDB<Chat, string>(chatKey, c => c.id!)
	const messages: { [jid: string]: OrderedDictionary<WAMessage> } = {}
	const contacts: { [id: string]: Contact } = {}
	const groupMetadata: { [id: string]: GroupMetadata } = {}
	const presences: { [id: string]: { [participant: string]: PresenceData } } = {}
	const state: ConnectionState = { connection: 'close' }
	const labels = new ObjectRepository<Label>()
	const labelAssociations = new KeyedDB<LabelAssociation, string>(labelAssociationKey, labelAssociationKey.key)

	const assertMessageList = (jid: string) => {
		if (!messages[jid]) {
			messages[jid] = makeOrderedDictionary(waMessageID)
		}

		return messages[jid]
	}

	const trimMessageList = (list: OrderedDictionary<WAMessage>) => {
		if (maxMessagesPerChat && list.array.length > maxMessagesPerChat) {
			const keep = new Set(list.array.slice(-maxMessagesPerChat))
			list.filter(m => keep.has(m))
		}
	}

	const findMessage = (jid: string, id: string) => {
		const direct = messages[jidNormalizedUser(jid)]?.get(id)
		if (direct) {
			return direct
		}

		// the message may be saved under the other JID of the chat (LID vs phone number)
		for (const list of Object.values(messages)) {
			const msg = list.get(id)
			if (msg) {
				return msg
			}
		}

		return undefined
	}

	const contactsUpsert = (newContacts: Contact[]) => {
		const oldContacts = new Set(Object.keys(contacts))
		for (const contact of newContacts) {
			oldContacts.delete(contact.id)
			contacts[contact.id] = Object.assign(contacts[contact.id] || {}, contact)
		}

		return oldContacts
	}

	const labelsUpsert = (newLabels: Label[]) => {
		for (const label of newLabels) {
			labels.upsertById(label.id, label)
		}
	}

	/**
	 * binds to a BaileysEventEmitter.
	 * It listens to all events and constructs a state that you can query accurate data from.
	 * Eg. can use the store to fetch chats, contacts, messages etc.
	 * @param ev typically the event emitter from the socket connection
	 */
	const bind = (ev: BaileysEventEmitter) => {
		ev.on('connection.update', update => {
			Object.assign(state, update)
		})

		ev.on(
			'messaging-history.set',
			({ chats: newChats, contacts: newContacts, messages: newMessages, isLatest, syncType }) => {
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					return // FOR NOW,
					//TODO: HANDLE
				}

				if (isLatest) {
					chats.clear()
					for (const id in messages) {
						delete messages[id]
					}
				}

				const chatsAdded = chats.insertIfAbsent(...newChats).length
				logger.debug({ chatsAdded }, 'synced chats')

				const oldContacts = contactsUpsert(newContacts)
				if (isLatest) {
					for (const jid of oldContacts) {
						delete contacts[jid]
					}
				}

				logger.debug({ deletedContacts: isLatest ? oldContacts.size : 0, newContacts }, 'synced contacts')

				for (const msg of newMessages) {
					const list = assertMessageList(storeChatId(msg.key))
					list.upsert(msg, 'prepend')
					trimMessageList(list)
				}

				logger.debug({ messages: newMessages.length }, 'synced messages')
			}
		)

		ev.on('contacts.upsert', contacts => {
			contactsUpsert(contacts)
		})

		ev.on('contacts.update', async updates => {
			for (const update of updates) {
				let contact: Contact | undefined
				if (contacts[update.id!]) {
					contact = contacts[update.id!]
				} else {
					// find the contact by its hash, sent when the user is not saved as a contact
					const match = Object.keys(contacts).find(contactId => {
						const user = jidDecode(contactId)?.user
						return user && md5Base64(user + 'WA_ADD_NOTIF').slice(0, 3) === update.id
					})
					contact = match ? contacts[match] : undefined
				}

				if (!contact) {
					logger.debug({ update }, 'got update for non-existant contact')
					continue
				}

				if (update.imgUrl === 'changed') {
					contact.imgUrl = socket ? await socket.profilePictureUrl(contact.id) : undefined
				} else if (update.imgUrl === 'removed') {
					delete contact.imgUrl
				}
			}
		})

		ev.on('chats.upsert', newChats => {
			chats.upsert(...newChats)
		})

		ev.on('chats.update', updates => {
			for (let update of updates) {
				const result = chats.update(update.id!, chat => {
					if (update.unreadCount! > 0) {
						update = { ...update }
						update.unreadCount = (chat.unreadCount || 0) + update.unreadCount!
					}

					Object.assign(chat, update)
				})
				if (!result) {
					logger.debug({ update }, 'got update for non-existant chat')
				}
			}
		})

		ev.on('labels.edit', (label: Label) => {
			if (label.deleted) {
				return labels.deleteById(label.id)
			}

			// WhatsApp can store only up to 20 labels
			if (labels.count() < 20) {
				return labels.upsertById(label.id, label)
			}

			logger.error('Labels count exceed')
		})

		ev.on('labels.association', ({ type, association }) => {
			switch (type) {
				case 'add':
					labelAssociations.upsert(association)
					break
				case 'remove':
					labelAssociations.delete(association)
					break
				default:
					logger.error(`unknown operation type [${type}]`)
			}
		})

		ev.on('presence.update', ({ id, presences: update }) => {
			presences[id] = presences[id] || {}
			Object.assign(presences[id], update)
		})

		ev.on('chats.delete', deletions => {
			for (const item of deletions) {
				if (chats.get(item)) {
					chats.deleteById(item)
				}
			}
		})

		ev.on('messages.upsert', ({ messages: newMessages, type }) => {
			if (type !== 'append' && type !== 'notify') {
				return
			}

			for (const msg of newMessages) {
				const jid = storeChatId(msg.key)
				const list = assertMessageList(jid)
				list.upsert(msg, 'append')
				trimMessageList(list)

				if (type === 'notify' && !chats.get(jid)) {
					ev.emit('chats.upsert', [
						{
							id: jid,
							conversationTimestamp: toNumber(msg.messageTimestamp),
							unreadCount: 1
						}
					])
				}
			}
		})

		ev.on('messages.update', updates => {
			for (const { update, key } of updates) {
				const list = assertMessageList(storeChatId(key))
				if (update?.status) {
					const listStatus = list.get(key.id!)?.status
					if (listStatus && update.status <= listStatus) {
						logger.debug({ update, storedStatus: listStatus }, 'status stored newer then update')
						delete update.status
						logger.debug({ update }, 'new update object')
					}
				}

				const result = list.updateAssign(key.id!, update)
				if (!result) {
					logger.debug({ update }, 'got update for non-existent message')
				}
			}
		})

		ev.on('messages.delete', item => {
			if ('all' in item) {
				messages[jidNormalizedUser(item.jid)]?.clear()
			} else {
				const list = messages[storeChatId(item.keys[0]!)]
				if (list) {
					const idSet = new Set(item.keys.map(k => k.id))
					list.filter(m => !idSet.has(m.key.id))
				}
			}
		})

		ev.on('groups.upsert', newGroups => {
			for (const group of newGroups) {
				groupMetadata[group.id] = group
			}
		})

		ev.on('groups.update', updates => {
			for (const update of updates) {
				const id = update.id!
				if (groupMetadata[id]) {
					Object.assign(groupMetadata[id], update)
				} else {
					logger.debug({ update }, 'got update for non-existant group metadata')
				}
			}
		})

		ev.on('group-participants.update', ({ id, participants, action }) => {
			const metadata = groupMetadata[id]
			if (!metadata) {
				return
			}

			const isSameParticipant = (a: GroupParticipant, b: GroupParticipant) =>
				a.id === b.id || (!!a.phoneNumber && a.phoneNumber === b.phoneNumber)
			switch (action) {
				case 'add':
					metadata.participants.push(
						...participants.map(({ id, phoneNumber, admin }) => ({ id, phoneNumber, admin: admin ?? null }))
					)
					break
				case 'demote':
				case 'promote':
					for (const participant of metadata.participants) {
						if (participants.some(p => isSameParticipant(p, participant))) {
							participant.admin = action === 'promote' ? 'admin' : null
						}
					}

					break
				case 'remove':
					metadata.participants = metadata.participants.filter(
						participant => !participants.some(p => isSameParticipant(p, participant))
					)
					break
			}
		})

		ev.on('message-receipt.update', updates => {
			for (const { key, receipt } of updates) {
				const msg = findMessage(storeChatId(key), key.id!)
				if (msg) {
					updateMessageWithReceipt(msg, receipt)
				}
			}
		})

		ev.on('messages.reaction', reactions => {
			for (const { key, reaction } of reactions) {
				const msg = findMessage(storeChatId(key), key.id!)
				if (msg) {
					updateMessageWithReaction(msg, reaction)
				}
			}
		})
	}

	const toJSON = () => ({
		chats,
		contacts,
		messages,
		labels,
		labelAssociations
	})

	const fromJSON = (json: {
		chats: Chat[]
		contacts: { [id: string]: Contact }
		messages: { [id: string]: WAMessage[] }
		labels?: { [labelId: string]: Label } | Label[]
		labelAssociations?: LabelAssociation[]
	}) => {
		chats.upsert(...json.chats)
		labelAssociations.upsert(...(json.labelAssociations || []))
		contactsUpsert(Object.values(json.contacts))
		labelsUpsert(Object.values(json.labels || {}))
		for (const jid in json.messages) {
			const list = assertMessageList(jid)
			for (const msg of json.messages[jid]!) {
				list.upsert(proto.WebMessageInfo.fromObject(msg) as WAMessage, 'append')
			}
		}
	}

	return {
		chats,
		contacts,
		messages,
		groupMetadata,
		state,
		presences,
		labels,
		labelAssociations,
		bind,
		/** loads messages from the store, if not found -- uses the legacy connection */
		loadMessages: async (jid: string, count: number, cursor?: WAMessageCursor) => {
			const list = assertMessageList(jidNormalizedUser(jid))
			const mode = !cursor || 'before' in cursor ? 'before' : 'after'
			const cursorKey = cursor ? ('before' in cursor ? cursor.before : cursor.after) : undefined
			const cursorValue = cursorKey ? list.get(cursorKey.id!) : undefined

			let messages: WAMessage[]
			if (list && mode === 'before' && (!cursorKey || cursorValue)) {
				if (cursorValue) {
					const msgIdx = list.array.findIndex(m => m.key.id === cursorKey?.id)
					messages = list.array.slice(0, msgIdx)
				} else {
					messages = list.array
				}

				const diff = count - messages.length
				if (diff < 0) {
					messages = messages.slice(-count) // get the last X messages
				}
			} else {
				messages = []
			}

			return messages
		},
		/**
		 * Get all available labels for profile
		 *
		 * Keep in mind that the list is formed from predefined tags and tags
		 * that were "caught" during their editing.
		 */
		getLabels: () => {
			return labels
		},
		/**
		 * Get labels for chat
		 *
		 * @returns Label IDs
		 **/
		getChatLabels: (chatId: string) => {
			return labelAssociations.filter(la => la.chatId === chatId).all()
		},
		/**
		 * Get labels for message
		 *
		 * @returns Label IDs
		 **/
		getMessageLabels: (messageId: string) => {
			const associations = labelAssociations.filter(la => (la as MessageLabelAssociation).messageId === messageId).all()
			return associations.map(({ labelId }) => labelId)
		},
		loadMessage: async (jid: string, id: string) => findMessage(jid, id),
		mostRecentMessage: async (jid: string) => {
			return messages[jidNormalizedUser(jid)]?.array.slice(-1)[0]
		},
		fetchImageUrl: async (jid: string, sock: StoreSocket | undefined) => {
			const contact = contacts[jid]
			if (!contact) {
				return sock?.profilePictureUrl(jid)
			}

			if (typeof contact.imgUrl === 'undefined') {
				contact.imgUrl = await sock?.profilePictureUrl(jid)
			}

			return contact.imgUrl
		},
		fetchGroupMetadata: async (jid: string, sock: StoreSocket | undefined) => {
			if (!groupMetadata[jid]) {
				const metadata = await sock?.groupMetadata(jid)
				if (metadata) {
					groupMetadata[jid] = metadata
				}
			}

			return groupMetadata[jid]
		},
		fetchMessageReceipts: async ({ remoteJid, id }: WAMessageKey) => {
			return findMessage(remoteJid!, id!)?.userReceipt
		},
		toJSON,
		fromJSON,
		writeToFile: (path: string) => {
			writeFileSync(path, JSON.stringify(toJSON()))
		},
		readFromFile: (path: string) => {
			if (existsSync(path)) {
				logger.debug({ path }, 'reading from file')
				const jsonStr = readFileSync(path, { encoding: 'utf-8' })
				const json = JSON.parse(jsonStr)
				fromJSON(json)
			}
		}
	}
}

export type InMemoryStore = ReturnType<typeof makeInMemoryStore>
