import { Mutex } from 'async-mutex'
import { readFile, rename, stat, writeFile } from 'fs/promises'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

const FLUSH_TIMEOUT_MS = 3000

/**
 * Stores the whole authentication state in one JSON file, kept in memory and written at most once
 * every few seconds (atomically, through a temp file). Call `flush` before the process exits so
 * the last changes are not lost.
 */
export const useSingleFileAuthState = async (
	fileName: string
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void>; flush: () => Promise<void> }> => {
	const mutex = new Mutex()
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	let fileData: Record<string, any> = {}
	let flushTimeout: NodeJS.Timeout | undefined

	const fileInfo = await stat(fileName).catch(() => undefined)
	if (!fileInfo) {
		await writeFile(fileName, '{}')
	} else if (!fileInfo.isFile()) {
		throw new Error(
			`found something that is not a file at ${fileName}, either delete it or specify a different location`
		)
	}

	try {
		fileData = JSON.parse(await readFile(fileName, 'utf-8'), BufferJSON.reviver) || {}
	} catch {
		fileData = {}
	}

	const flush = async () => {
		if (flushTimeout) {
			clearTimeout(flushTimeout)
			flushTimeout = undefined
		}

		await mutex.runExclusive(async () => {
			const tempFile = fileName + '.temp'
			await writeFile(tempFile, JSON.stringify(fileData, BufferJSON.replacer))
			await rename(tempFile, fileName)
		})
	}

	const scheduleFlush = () => {
		if (flushTimeout) {
			return
		}

		flushTimeout = setTimeout(() => {
			flushTimeout = undefined
			flush().catch(() => {})
		}, FLUSH_TIMEOUT_MS)
	}

	const creds: AuthenticationCreds = fileData.creds || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					for (const id of ids) {
						let value = fileData[type + id]
						if (type === 'app-state-sync-key' && value) {
							value = proto.Message.AppStateSyncKeyData.fromObject(value)
						}

						data[id] = value
					}

					return data
				},
				set: async data => {
					for (const category in data) {
						for (const id in data[category as keyof SignalDataTypeMap]) {
							const value = data[category as keyof SignalDataTypeMap]![id]
							if (value) {
								fileData[category + id] = value
							} else {
								delete fileData[category + id]
							}
						}
					}

					scheduleFlush()
				}
			}
		},
		saveCreds: async () => {
			fileData.creds = creds
			scheduleFlush()
		},
		flush
	}
}
