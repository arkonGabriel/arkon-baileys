import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

type SqliteStatement = {
	get: (...params: string[]) => unknown
	run: (...params: string[]) => unknown
}

/** the part of a better-sqlite3 `Database` or a `node:sqlite` `DatabaseSync` this auth state uses */
export type SqliteDatabase = {
	exec: (sql: string) => unknown
	prepare: (sql: string) => SqliteStatement
}

export type SqliteAuthStateOptions = { dbPath: string; database?: undefined } | { database: SqliteDatabase }

const CREDS_ROW_KEY = '__creds__'
const CREATE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS signal_keys_type_idx ON signal_keys(type);
`

/** better-sqlite3 when installed, else the `node:sqlite` built into Node 22.5+ */
const openDatabase = async (dbPath: string): Promise<SqliteDatabase> => {
	try {
		// @ts-ignore optional dependency
		const mod = await import('better-sqlite3')
		const Database = mod.default ?? mod
		return new Database(dbPath)
	} catch {}

	try {
		// @ts-ignore only in Node 22.5+
		const { DatabaseSync } = await import('node:sqlite')
		return new DatabaseSync(dbPath)
	} catch (err) {
		const error = new Error(
			'useSqliteAuthState needs Node 22.5+ or the `better-sqlite3` package (`npm install better-sqlite3`)'
		)
		Object.assign(error, { cause: err })
		throw error
	}
}

/**
 * Stores the authentication state in a SQLite database: one row for the creds and one per signal key.
 * Pass `dbPath` to open (or create) the file, or an already open `database`.
 */
export const useSqliteAuthState = async (
	opts: SqliteAuthStateOptions
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
	const db = opts.database ?? (await openDatabase(opts.dbPath))
	db.exec(CREATE_SCHEMA_SQL)

	const credsSelect = db.prepare('SELECT value FROM creds WHERE key = ?')
	const credsUpsert = db.prepare(
		'INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
	)
	const keySelect = db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?')
	const keyUpsert = db.prepare(
		'INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
	)
	const keyDelete = db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?')

	const credsRow = credsSelect.get(CREDS_ROW_KEY) as { value: string } | undefined
	const creds: AuthenticationCreds = credsRow ? JSON.parse(credsRow.value, BufferJSON.reviver) : initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async (type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
					for (const id of ids) {
						const row = keySelect.get(type, id) as { value: string } | undefined
						if (row) {
							let value = JSON.parse(row.value, BufferJSON.reviver)
							if (type === 'app-state-sync-key' && value) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							data[id] = value
						}
					}

					return data
				},
				set: async data => {
					db.exec('BEGIN')
					try {
						for (const category in data) {
							for (const id in data[category as keyof SignalDataTypeMap]) {
								const value = data[category as keyof SignalDataTypeMap]![id]
								if (value) {
									keyUpsert.run(category, id, JSON.stringify(value, BufferJSON.replacer))
								} else {
									keyDelete.run(category, id)
								}
							}
						}

						db.exec('COMMIT')
					} catch (err) {
						db.exec('ROLLBACK')
						throw err
					}
				}
			}
		},
		saveCreds: async () => {
			credsUpsert.run(CREDS_ROW_KEY, JSON.stringify(creds, BufferJSON.replacer))
		}
	}
}
