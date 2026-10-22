import { jest } from '@jest/globals'
import type { WAVersion } from '../../Types'
import { makeWaVersionResolver, parseWaVersion, type WaVersionSource } from '../../Utils/wa-version'

const FALLBACK: WAVersion = [2, 3000, 1000000000]

const source = (name: string, version: WAVersion | null, isLatest = true): WaVersionSource => ({
	source: name,
	fn: jest.fn(async () => ({ version, isLatest }))
})

const failing = (name: string): WaVersionSource => ({
	source: name,
	fn: jest.fn(async () => {
		throw new Error('offline')
	})
})

describe('parseWaVersion', () => {
	it('accepts dotted, comma and array forms', () => {
		expect(parseWaVersion('2.3000.1045340097')).toEqual([2, 3000, 1045340097])
		expect(parseWaVersion('2,3000,1045340097')).toEqual([2, 3000, 1045340097])
		expect(parseWaVersion([2, 3000, 1045340097])).toEqual([2, 3000, 1045340097])
	})

	it('rejects malformed or truncated versions', () => {
		expect(parseWaVersion(undefined)).toBeNull()
		expect(parseWaVersion('')).toBeNull()
		expect(parseWaVersion('2.3000')).toBeNull()
		expect(parseWaVersion('2.3000.12345')).toBeNull()
		expect(parseWaVersion('a.b.c')).toBeNull()
	})
})

describe('makeWaVersionResolver', () => {
	it('picks the highest version among the sources', async () => {
		const { resolve } = makeWaVersionResolver({
			fallback: FALLBACK,
			sources: [source('old', [2, 3000, 1035194821]), source('new', [2, 3000, 1045340097]), failing('down')]
		})

		await expect(resolve()).resolves.toEqual({ version: [2, 3000, 1045340097], source: 'new', fromCache: false })
	})

	it('ignores results not marked as latest', async () => {
		const { resolve } = makeWaVersionResolver({
			fallback: FALLBACK,
			sources: [source('stale', [2, 3000, 1099999999], false), source('ok', [2, 3000, 1045340097])]
		})

		await expect(resolve()).resolves.toMatchObject({ source: 'ok' })
	})

	it('falls back to the default and does not cache it when every source fails', async () => {
		const down = failing('down')
		const { resolve } = makeWaVersionResolver({ fallback: FALLBACK, sources: [down] })

		await expect(resolve()).resolves.toEqual({ version: FALLBACK, source: 'default', fromCache: false })
		await resolve()
		expect(down.fn).toHaveBeenCalledTimes(2)
	})

	it('caches a found version until invalidated or forced', async () => {
		const web = source('web', [2, 3000, 1045340097])
		const { resolve, invalidate } = makeWaVersionResolver({ fallback: FALLBACK, sources: [web] })

		await resolve()
		await expect(resolve()).resolves.toMatchObject({ fromCache: true })
		expect(web.fn).toHaveBeenCalledTimes(1)

		invalidate()
		await expect(resolve()).resolves.toMatchObject({ fromCache: false })
		await resolve({ force: true })
		expect(web.fn).toHaveBeenCalledTimes(3)
	})

	it('a manual override wins without touching the network', async () => {
		const web = source('web', [2, 3000, 1045340097])
		const { resolve } = makeWaVersionResolver({ fallback: FALLBACK, sources: [web] })

		await expect(resolve({ override: '2.3000.1050000000' })).resolves.toEqual({
			version: [2, 3000, 1050000000],
			source: 'override',
			fromCache: false
		})
		expect(web.fn).not.toHaveBeenCalled()
	})
})
