/**
 * Arkon: fila de envio (send queue).
 *
 * Serializa os envios e garante um intervalo mínimo entre eles, pra não
 * disparar rápido demais e arriscar bloqueio do WhatsApp. É totalmente
 * opcional: o comportamento padrão do socket só muda se você acoplar a fila
 * com `attachArkonSendQueue`.
 */

export interface ArkonSendQueueOptions {
	/** intervalo mínimo, em ms, entre o início de dois envios seguidos (padrão 350) */
	minIntervalMs?: number
	/** quantos envios no máximo por janela (burst). 0 ou ausente = sem limite */
	maxPerWindow?: number
	/** tamanho da janela, em ms, usada por `maxPerWindow` (padrão 60000) */
	windowMs?: number
}

export interface ArkonSendQueue {
	/** enfileira uma tarefa; resolve ou rejeita com o resultado dela, na ordem FIFO */
	enqueue<T>(task: () => Promise<T>): Promise<T>
	/** quantas tarefas ainda estão na fila (sem contar a que está rodando) */
	size(): number
	/** descarta as tarefas pendentes, rejeitando cada uma com `reason` */
	clear(reason?: Error): void
}

interface QueueItem {
	run: () => Promise<unknown>
	resolve: (value: unknown) => void
	reject: (reason: unknown) => void
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** cria uma fila de envio independente do socket (fácil de testar) */
export const createArkonSendQueue = (options: ArkonSendQueueOptions = {}): ArkonSendQueue => {
	const minIntervalMs = Math.max(0, options.minIntervalMs ?? 350)
	const maxPerWindow = Math.max(0, options.maxPerWindow ?? 0)
	const windowMs = Math.max(1, options.windowMs ?? 60_000)

	const items: QueueItem[] = []
	const windowStamps: number[] = []
	let running = false
	let lastStart = 0

	const waitForWindowSlot = async () => {
		if (!maxPerWindow) {
			return
		}

		for (;;) {
			const now = Date.now()
			let oldest = windowStamps[0]
			while (oldest !== undefined && now - oldest >= windowMs) {
				windowStamps.shift()
				oldest = windowStamps[0]
			}

			if (windowStamps.length < maxPerWindow) {
				return
			}

			await delay(Math.max(1, windowMs - (now - (oldest ?? now))))
		}
	}

	const pump = async () => {
		if (running) {
			return
		}

		running = true
		try {
			while (items.length > 0) {
				const sinceLast = Date.now() - lastStart
				if (sinceLast < minIntervalMs) {
					await delay(minIntervalMs - sinceLast)
				}

				await waitForWindowSlot()

				const item = items.shift()
				if (!item) {
					break
				}

				lastStart = Date.now()
				if (maxPerWindow) {
					windowStamps.push(lastStart)
				}

				try {
					item.resolve(await item.run())
				} catch (error) {
					item.reject(error)
				}
			}
		} finally {
			running = false
		}
	}

	return {
		enqueue<T>(task: () => Promise<T>): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				items.push({
					run: task as () => Promise<unknown>,
					resolve: resolve as (value: unknown) => void,
					reject
				})
				void pump()
			})
		},
		size: () => items.length,
		clear: (reason = new Error('fila de envio esvaziada')) => {
			while (items.length > 0) {
				items.shift()?.reject(reason)
			}
		}
	}
}

/** qualquer objeto parecido com socket que tenha um `sendMessage` assíncrono */
type SendCapable = { sendMessage: (...args: never[]) => Promise<unknown> }

/**
 * Acopla a fila de envio a um socket: todo `sendMessage` passa a respeitar o
 * intervalo e o limite configurados. Retorna uma função que desfaz o acople.
 */
export const attachArkonSendQueue = <S extends SendCapable>(sock: S, options?: ArkonSendQueueOptions): (() => void) => {
	const queue = createArkonSendQueue(options)
	const original = sock.sendMessage.bind(sock) as S['sendMessage']

	sock.sendMessage = ((...args: Parameters<S['sendMessage']>) =>
		queue.enqueue(() => original(...args))) as S['sendMessage']

	return () => {
		sock.sendMessage = original
	}
}
