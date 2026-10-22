/**
 * Arkon: reconexão automática.
 *
 * Quando a conexão cai por algo passageiro (internet, instabilidade), tenta
 * reconectar sozinho com um intervalo que vai aumentando (backoff). Quando a
 * queda é "terminal" (deslogado etc.), ele NÃO insiste, pra proteger a sessão.
 * É opcional e você fornece a função que recria o socket.
 */

import { describeDisconnectReasonPt, isTerminalDisconnect } from './logs-pt'

export interface ArkonBackoffOptions {
	/** intervalo inicial, em ms (padrão 1000) */
	baseMs?: number
	/** intervalo máximo, em ms (padrão 30000) */
	maxMs?: number
	/** fator de crescimento a cada tentativa (padrão 2) */
	factor?: number
}

/** intervalo (ms) da enésima tentativa, com crescimento exponencial limitado */
export const computeBackoffMs = (attempt: number, options: ArkonBackoffOptions = {}): number => {
	const base = Math.max(1, options.baseMs ?? 1000)
	const max = Math.max(base, options.maxMs ?? 30_000)
	const factor = Math.max(1, options.factor ?? 2)
	const raw = base * factor ** Math.max(0, attempt - 1)
	return Math.min(max, Math.round(raw))
}

/** true quando vale a pena reconectar sozinho (a queda não é terminal) */
export const shouldReconnect = (statusCode: number | undefined): boolean => !isTerminalDisconnect(statusCode)

const statusFromError = (error: unknown): number | undefined => {
	if (error === null || typeof error !== 'object') {
		return undefined
	}

	const err = error as Record<string, unknown>
	const output = err.output as Record<string, unknown> | undefined
	const data = err.data as Record<string, unknown> | undefined
	const code = output?.statusCode ?? err.statusCode ?? data?.statusCode
	return typeof code === 'number' ? code : undefined
}

interface ConnectionUpdateLike {
	connection?: string
	lastDisconnect?: { error?: unknown } | null
}

/** emissor mínimo de eventos (compatível com `sock.ev`) */
interface MinimalEventEmitter {
	on(event: string, listener: (arg: unknown) => void): void
	off?(event: string, listener: (arg: unknown) => void): void
}

export interface ArkonAutoReconnectOptions extends ArkonBackoffOptions {
	/** recria o socket (chamado em cada tentativa de reconexão) */
	start: () => void | Promise<void>
	/** número máximo de tentativas seguidas (padrão: sem limite) */
	maxAttempts?: number
	/** recebe mensagens informativas em português pra você registrar como quiser */
	onInfo?: (message: string, meta: { attempt: number; statusCode?: number; delayMs?: number }) => void
}

/**
 * Liga a reconexão automática aos eventos de conexão do socket. Devolve uma
 * função que desliga e cancela qualquer tentativa agendada.
 */
export const attachAutoReconnect = (ev: MinimalEventEmitter, options: ArkonAutoReconnectOptions): (() => void) => {
	const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY
	let attempts = 0
	let timer: ReturnType<typeof setTimeout> | undefined
	let stopped = false

	const listener = (arg: unknown) => {
		const update = (arg ?? {}) as ConnectionUpdateLike

		if (update.connection === 'open') {
			attempts = 0
			return
		}

		if (update.connection !== 'close' || stopped) {
			return
		}

		const statusCode = statusFromError(update.lastDisconnect?.error)

		if (!shouldReconnect(statusCode)) {
			options.onInfo?.(describeDisconnectReasonPt(statusCode), { attempt: attempts, statusCode })
			return
		}

		attempts += 1
		if (attempts > maxAttempts) {
			options.onInfo?.(`Parando as tentativas de reconexão (limite de ${maxAttempts} atingido).`, {
				attempt: attempts,
				statusCode
			})
			return
		}

		const delayMs = computeBackoffMs(attempts, options)
		options.onInfo?.(`Reconectando em ${Math.round(delayMs / 1000)}s (tentativa ${attempts})...`, {
			attempt: attempts,
			statusCode,
			delayMs
		})

		timer = setTimeout(() => {
			void Promise.resolve(options.start()).catch(() => {
				/* o próximo evento de 'close' agenda a tentativa seguinte */
			})
		}, delayMs)
	}

	ev.on('connection.update', listener)

	return () => {
		stopped = true
		if (timer) {
			clearTimeout(timer)
		}

		ev.off?.('connection.update', listener)
	}
}
