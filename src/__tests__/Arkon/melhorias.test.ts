/**
 * Etapa 4: melhorias Arkon opcionais (fila de envio, botão→texto, cache de
 * grupo, LID→número, reconexão e logs em português).
 */
import {
	arkonButtonsToText,
	attachAutoReconnect,
	computeBackoffMs,
	createArkonGroupCache,
	createArkonSendQueue,
	describeConnectionPt,
	describeDisconnectReasonPt,
	extractButtonLabels,
	isTerminalDisconnect,
	makeLidResolverFromMap,
	phoneNumberFromJid,
	resolveToPhoneNumber,
	shouldReconnect,
	withButtonTextFallback
} from '../../Arkon'
import type { GroupMetadata } from '../../Types'
import { DisconnectReason } from '../../Types'

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

class FakeEmitter {
	private listeners = new Map<string, ((arg: unknown) => void)[]>()

	on(event: string, listener: (arg: unknown) => void) {
		const list = this.listeners.get(event) ?? []
		list.push(listener)
		this.listeners.set(event, list)
	}

	off(event: string, listener: (arg: unknown) => void) {
		this.listeners.set(
			event,
			(this.listeners.get(event) ?? []).filter(item => item !== listener)
		)
	}

	emit(event: string, arg: unknown) {
		for (const listener of this.listeners.get(event) ?? []) {
			listener(arg)
		}
	}
}

describe('fila de envio (send queue)', () => {
	it('mantém a ordem FIFO e devolve o resultado de cada tarefa', async () => {
		const queue = createArkonSendQueue({ minIntervalMs: 0 })
		const order: number[] = []
		const results = await Promise.all(
			[1, 2, 3].map(n =>
				queue.enqueue(async () => {
					order.push(n)
					return n * 10
				})
			)
		)
		expect(order).toEqual([1, 2, 3])
		expect(results).toEqual([10, 20, 30])
	})

	it('respeita o intervalo mínimo entre envios', async () => {
		const queue = createArkonSendQueue({ minIntervalMs: 30 })
		const starts: number[] = []
		await Promise.all(
			[0, 1, 2].map(() =>
				queue.enqueue(async () => {
					starts.push(Date.now())
				})
			)
		)
		const [first = 0, second = 0, third = 0] = starts
		expect(starts).toHaveLength(3)
		expect(second - first).toBeGreaterThanOrEqual(20)
		expect(third - second).toBeGreaterThanOrEqual(20)
	})

	it('clear() rejeita as tarefas ainda pendentes', async () => {
		const queue = createArkonSendQueue({ minIntervalMs: 0 })
		let release = () => {}

		const blocker = new Promise<void>(resolve => {
			release = resolve
		})
		const first = queue.enqueue(() => blocker)
		const pending = queue.enqueue(async () => 'nunca roda')
		// assina os dois lados já (síncrono): pending nunca fica "unhandled"
		const settled = pending.then(
			() => 'rodou',
			(error: unknown) => (error as Error).message
		)

		// deixa o pump pegar a 1ª tarefa (fica presa no blocker); a 2ª continua na fila
		await delay(5)
		expect(queue.size()).toBe(1)
		queue.clear()
		expect(queue.size()).toBe(0)
		release()
		await first
		await expect(settled).resolves.toContain('esvaziada')
	})
})

describe('botão → texto (fallback)', () => {
	it('extrai os rótulos de buttons, templateButtons e sections na ordem', () => {
		const content = {
			buttons: [{ buttonId: 'a', buttonText: { displayText: 'Opção A' } }],
			templateButtons: [
				{ index: 1, quickReplyButton: { displayText: 'Sim' } },
				{ index: 2, urlButton: { displayText: 'Site', url: 'https://arkon' } }
			],
			sections: [{ title: 'Menu', rows: [{ title: 'Item 1', description: 'desc' }] }]
		}
		expect(extractButtonLabels(content)).toEqual(['Opção A', 'Sim', 'Site (https://arkon)', 'Menu', 'Item 1 — desc'])
	})

	it('monta o texto com título, corpo, opções numeradas e rodapé', () => {
		const text = arkonButtonsToText({
			title: 'Título',
			text: 'Escolha:',
			footer: 'Rodapé',
			buttons: [{ buttonText: { displayText: 'Um' } }, { buttonText: { displayText: 'Dois' } }]
		})
		expect(text).toContain('Título')
		expect(text).toContain('Escolha:')
		expect(text).toContain('1. Um')
		expect(text).toContain('2. Dois')
		expect(text).toContain('Rodapé')
	})

	it('withButtonTextFallback devolve o conteúdo quando ligado e texto quando desligado', () => {
		const content = { text: 'oi', buttons: [{ buttonText: { displayText: 'X' } }] }
		expect(withButtonTextFallback(content, true)).toBe(content)
		const fallback = withButtonTextFallback(content, false)
		expect(fallback).toHaveProperty('text')
		expect((fallback as { text: string }).text).toContain('1. X')
	})
})

describe('cache de grupo', () => {
	const meta = (id: string) => ({ id, subject: 'grupo', participants: [] }) as unknown as GroupMetadata

	it('guarda, devolve e apaga', async () => {
		const cache = createArkonGroupCache({ ttlMs: 0 })
		cache.set('g1@g.us', meta('g1@g.us'))
		expect(cache.get('g1@g.us')?.id).toBe('g1@g.us')
		expect(cache.size()).toBe(1)
		await expect(cache.cachedGroupMetadata('g1@g.us')).resolves.toHaveProperty('id', 'g1@g.us')
		cache.delete('g1@g.us')
		expect(cache.get('g1@g.us')).toBeUndefined()
	})

	it('expira depois do TTL', async () => {
		const cache = createArkonGroupCache({ ttlMs: 20 })
		cache.set('g2@g.us', meta('g2@g.us'))
		expect(cache.get('g2@g.us')).toBeDefined()
		await delay(35)
		expect(cache.get('g2@g.us')).toBeUndefined()
	})

	it('invalida sozinho pelos eventos do socket', () => {
		const cache = createArkonGroupCache({ ttlMs: 0 })
		const ev = new FakeEmitter()
		const stop = cache.listen(ev)
		ev.emit('groups.upsert', [meta('g3@g.us')])
		expect(cache.get('g3@g.us')).toBeDefined()
		ev.emit('groups.update', [{ id: 'g3@g.us' }])
		expect(cache.get('g3@g.us')).toBeUndefined()
		stop()
	})
})

describe('LID → número', () => {
	it('extrai dígitos de um JID de telefone e ignora @lid', () => {
		expect(phoneNumberFromJid('5583991540171@s.whatsapp.net')).toBe('5583991540171')
		expect(phoneNumberFromJid('123456789@lid')).toBe('')
		expect(phoneNumberFromJid(undefined)).toBe('')
	})

	it('resolve número direto e via @lid com resolvedor', async () => {
		await expect(resolveToPhoneNumber('5583991540171@s.whatsapp.net')).resolves.toBe('5583991540171')
		await expect(resolveToPhoneNumber('123456789@lid')).resolves.toBe('')
		const resolver = makeLidResolverFromMap({ '123456789@lid': '5583991540171@s.whatsapp.net' })
		await expect(resolveToPhoneNumber('123456789@lid', resolver)).resolves.toBe('5583991540171')
	})
})

describe('logs em português', () => {
	it('descreve motivos de desconexão e estados', () => {
		expect(describeDisconnectReasonPt(DisconnectReason.loggedOut)).toContain('deslogado')
		expect(describeDisconnectReasonPt(405)).toContain('405')
		expect(describeConnectionPt('open')).toBe('Conectado.')
	})

	it('marca como terminal só o que precisa de ação', () => {
		expect(isTerminalDisconnect(DisconnectReason.loggedOut)).toBe(true)
		expect(isTerminalDisconnect(DisconnectReason.connectionLost)).toBe(false)
	})
})

describe('reconexão automática', () => {
	it('backoff cresce e respeita o teto', () => {
		expect(computeBackoffMs(1, { baseMs: 1000, maxMs: 30_000 })).toBe(1000)
		expect(computeBackoffMs(2, { baseMs: 1000, maxMs: 30_000 })).toBe(2000)
		expect(computeBackoffMs(10, { baseMs: 1000, maxMs: 30_000 })).toBe(30_000)
	})

	it('reconecta em queda passageira e para em queda terminal', async () => {
		const ev = new FakeEmitter()
		let starts = 0
		const stop = attachAutoReconnect(ev, {
			start: () => {
				starts += 1
			},
			baseMs: 10,
			maxMs: 20
		})

		ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } })
		await delay(40)
		expect(starts).toBe(1)

		ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } })
		await delay(40)
		expect(starts).toBe(1)

		stop()
	})

	it('shouldReconnect é false só pra status terminal', () => {
		expect(shouldReconnect(DisconnectReason.connectionClosed)).toBe(true)
		expect(shouldReconnect(DisconnectReason.loggedOut)).toBe(false)
	})
})
