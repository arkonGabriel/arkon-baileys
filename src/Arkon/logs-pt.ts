/**
 * Arkon: logs em português.
 *
 * Traduz os códigos e estados de conexão do WhatsApp para mensagens curtas em
 * português, pra ficar fácil de entender no terminal/painel. São funções puras
 * (só devolvem texto); você decide onde e como registrar.
 */

import { DisconnectReason } from '../Types'

/** mensagem em PT para o código de desconexão (status code do WhatsApp) */
export const describeDisconnectReasonPt = (statusCode: number | undefined): string => {
	switch (statusCode) {
		case DisconnectReason.loggedOut:
			return 'Sessão encerrada no WhatsApp (deslogado). Precisa parear de novo.'
		case DisconnectReason.forbidden:
			return 'Conexão proibida pelo WhatsApp (número pode estar restrito/banido).'
		case DisconnectReason.connectionReplaced:
			return 'A conexão foi substituída por outra sessão aberta com o mesmo número.'
		case DisconnectReason.badSession:
			return 'Sessão corrompida. Pode ser preciso parear de novo.'
		case DisconnectReason.multideviceMismatch:
			return 'Incompatibilidade de multi-dispositivo. Precisa parear de novo.'
		case DisconnectReason.restartRequired:
			return 'O WhatsApp pediu para reiniciar a conexão (normal após o pareamento).'
		case DisconnectReason.connectionClosed:
			return 'Conexão fechada. Vamos tentar reconectar.'
		case DisconnectReason.connectionLost:
			return 'Conexão perdida (internet/instabilidade). Vamos tentar reconectar.'
		case DisconnectReason.unavailableService:
			return 'Serviço do WhatsApp indisponível no momento. Vamos tentar de novo.'
		case 405:
			return 'O WhatsApp recusou a conexão (405). A versão do WhatsApp Web pode estar desatualizada.'
		default:
			return statusCode ? `Desconectado (código ${statusCode}).` : 'Desconectado (motivo desconhecido).'
	}
}

/** estado de conexão em PT ('open' | 'connecting' | 'close') */
export const describeConnectionPt = (connection: string | undefined): string => {
	switch (connection) {
		case 'open':
			return 'Conectado.'
		case 'connecting':
			return 'Conectando...'
		case 'close':
			return 'Desconectado.'
		default:
			return 'Status de conexão desconhecido.'
	}
}

/**
 * true quando a desconexão é "terminal": não adianta reconectar sozinho, porque
 * precisa de ação (parear de novo, trocar número etc.).
 */
export const isTerminalDisconnect = (statusCode: number | undefined): boolean => {
	const terminal = new Set<number>([
		DisconnectReason.loggedOut,
		DisconnectReason.forbidden,
		DisconnectReason.multideviceMismatch,
		DisconnectReason.connectionReplaced,
		DisconnectReason.badSession
	])

	return statusCode !== undefined && terminal.has(statusCode)
}
