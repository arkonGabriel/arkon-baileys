/**
 * Arkon: cache de metadados de grupo.
 *
 * Guarda os dados dos grupos por um tempo pra não ficar pedindo ao WhatsApp a
 * cada mensagem (mais rápido e com menos risco de limite). É independente e
 * sem dependência externa. Use passando `cachedGroupMetadata` ao criar o
 * socket e chamando `listen(sock.ev)` pra invalidar sozinho quando o grupo muda.
 */

import type { GroupMetadata } from '../Types'

export interface ArkonGroupCacheOptions {
	/** por quanto tempo um grupo fica em cache, em ms (padrão 5 min). 0 = nunca expira */
	ttlMs?: number
}

/** emissor mínimo de eventos (compatível com `sock.ev`), pra facilitar os testes */
interface MinimalEventEmitter {
	on(event: string, listener: (arg: unknown) => void): void
	off?(event: string, listener: (arg: unknown) => void): void
}

export interface ArkonGroupCache {
	get(jid: string): GroupMetadata | undefined
	set(jid: string, metadata: GroupMetadata): void
	delete(jid: string): void
	clear(): void
	size(): number
	/** getter pronto pra passar em `makeWASocket({ cachedGroupMetadata })` */
	cachedGroupMetadata(jid: string): Promise<GroupMetadata | undefined>
	/** liga a invalidação automática aos eventos de grupo do socket; devolve o "desligar" */
	listen(ev: MinimalEventEmitter): () => void
}

interface CacheEntry {
	value: GroupMetadata
	expires: number
}

const readJid = (obj: unknown): string => {
	if (obj === null || typeof obj !== 'object') {
		return ''
	}

	const id = (obj as Record<string, unknown>).id
	return typeof id === 'string' ? id : ''
}

export const createArkonGroupCache = (options: ArkonGroupCacheOptions = {}): ArkonGroupCache => {
	const ttlMs = Math.max(0, options.ttlMs ?? 5 * 60 * 1000)
	const store = new Map<string, CacheEntry>()

	const get = (jid: string): GroupMetadata | undefined => {
		const entry = store.get(jid)
		if (!entry) {
			return undefined
		}

		if (entry.expires !== 0 && entry.expires <= Date.now()) {
			store.delete(jid)
			return undefined
		}

		return entry.value
	}

	const set = (jid: string, metadata: GroupMetadata): void => {
		if (!jid) {
			return
		}

		store.set(jid, { value: metadata, expires: ttlMs === 0 ? 0 : Date.now() + ttlMs })
	}

	const remove = (jid: string): void => {
		store.delete(jid)
	}

	return {
		get,
		set,
		delete: remove,
		clear: () => store.clear(),
		size: () => store.size,
		cachedGroupMetadata: (jid: string) => Promise.resolve(get(jid)),
		listen(ev: MinimalEventEmitter): () => void {
			const onUpsert = (arg: unknown) => {
				for (const meta of Array.isArray(arg) ? arg : []) {
					const jid = readJid(meta)
					if (jid) {
						set(jid, meta as GroupMetadata)
					}
				}
			}

			const onUpdate = (arg: unknown) => {
				for (const update of Array.isArray(arg) ? arg : []) {
					const jid = readJid(update)
					if (jid) {
						remove(jid)
					}
				}
			}

			const onParticipants = (arg: unknown) => {
				const jid = readJid(arg)
				if (jid) {
					remove(jid)
				}
			}

			ev.on('groups.upsert', onUpsert)
			ev.on('groups.update', onUpdate)
			ev.on('group-participants.update', onParticipants)

			return () => {
				ev.off?.('groups.upsert', onUpsert)
				ev.off?.('groups.update', onUpdate)
				ev.off?.('group-participants.update', onParticipants)
			}
		}
	}
}
