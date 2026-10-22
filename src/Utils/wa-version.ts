import type { WAVersion } from '../Types'
import { fetchLatestBaileysVersion, fetchLatestWaWebVersion } from './generics'

const WPP_VERSIONS_URL = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json'
const DEFAULT_CACHE_MS = 30 * 60_000

export type WaVersionResult = { version: WAVersion | null; isLatest: boolean }

export type WaVersionSource = {
	source: string
	fn: (options?: RequestInit) => Promise<WaVersionResult>
}

export type ResolvedWaVersion = {
	version: WAVersion
	source: string
	fromCache: boolean
}

/** Accepts "2.3000.1045340097", "2,3000,1045340097" or [2, 3000, 1045340097] */
export const parseWaVersion = (raw: unknown): WAVersion | null => {
	const text = Array.isArray(raw) ? raw.join('.') : String(raw ?? '')
	const parts = text
		.trim()
		.split(/[.,\s]+/)
		.filter(Boolean)
		.map(Number)
	// every real WA Web client revision is a 10-digit build number; anything shorter is a typo
	if (parts.length !== 3 || parts.some(n => !Number.isInteger(n) || n < 0) || parts[2]! < 1_000_000_000) {
		return null
	}

	return parts as WAVersion
}

const compareWaVersions = (a: WAVersion, b: WAVersion) => {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i]! - b[i]!
	}

	return 0
}

/** Current WA Web version from the public wppconnect list, used as a second opinion to web.whatsapp.com */
export const fetchWppConnectVersion = async (options: RequestInit = {}): Promise<WaVersionResult> => {
	const response = await fetch(WPP_VERSIONS_URL, { signal: options.signal })
	if (!response.ok) {
		throw new Error(`wa-version HTTP ${response.status}`)
	}

	const data = (await response.json()) as { currentVersion?: string }
	const version = parseWaVersion(String(data?.currentVersion || '').replace(/-.*$/, ''))
	return { version, isLatest: !!version }
}

// wrapped in arrow functions: generics.ts and this file are both loaded through the Utils barrel,
// so the fetchers may not be initialised yet when this module is evaluated
export const DEFAULT_WA_VERSION_SOURCES: WaVersionSource[] = [
	{ source: 'web.whatsapp.com', fn: options => fetchLatestWaWebVersion(options) },
	{ source: 'wppconnect/wa-version', fn: options => fetchWppConnectVersion(options) },
	{ source: 'github', fn: options => fetchLatestBaileysVersion(options) }
]

/**
 * Builds a resolver for the WA Web version to connect with.
 * WhatsApp answers 405 on pairing when the client version is too old, and any single source
 * can lag behind, so every source is asked and the highest version wins: a stale source
 * can only ever report a lower number.
 */
export const makeWaVersionResolver = ({
	sources = DEFAULT_WA_VERSION_SOURCES,
	fallback,
	cacheMs = DEFAULT_CACHE_MS,
	timeoutMs = 10_000
}: {
	sources?: WaVersionSource[]
	fallback: WAVersion
	cacheMs?: number
	timeoutMs?: number
}) => {
	let cached: { version: WAVersion; source: string; at: number } | undefined

	const resolve = async ({ force = false, override }: { force?: boolean; override?: unknown } = {}) => {
		const manual = parseWaVersion(override)
		if (manual) {
			return { version: manual, source: 'override', fromCache: false } satisfies ResolvedWaVersion
		}

		if (!force && cached && Date.now() - cached.at < cacheMs) {
			return { version: cached.version, source: cached.source, fromCache: true } satisfies ResolvedWaVersion
		}

		const results = await Promise.all(
			sources.map(async ({ source, fn }) => {
				try {
					const result = await fn({ signal: AbortSignal.timeout(timeoutMs) })
					const version = result?.isLatest ? parseWaVersion(result.version) : null
					return version ? { version, source } : undefined
				} catch {
					return undefined
				}
			})
		)

		let best: { version: WAVersion; source: string } = { version: fallback, source: 'default' }
		for (const result of results) {
			if (result && compareWaVersions(result.version, best.version) > 0) {
				best = result
			}
		}

		// never cache the fallback, so the next call retries the network
		cached = best.source === 'default' ? undefined : { ...best, at: Date.now() }
		return { ...best, fromCache: false } satisfies ResolvedWaVersion
	}

	/** drop the cached version, e.g. after a 405 */
	const invalidate = () => {
		cached = undefined
	}

	return { resolve, invalidate }
}
