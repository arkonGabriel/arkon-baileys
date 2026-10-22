/**
 * Arkon: LID → número.
 *
 * O WhatsApp passou a usar identificadores "@lid" no lugar do número em vários
 * lugares. Estas funções ajudam a voltar pro número de telefone (JID
 * "@s.whatsapp.net") de forma segura, sem nunca estourar erro. A parte que
 * depende da rede recebe um "resolvedor" de fora, então o resto é puro e fácil
 * de testar.
 */

import { isLidUser, jidDecode, jidNormalizedUser } from '../WABinary'

/** função que, dado um JID "@lid", devolve o JID de telefone correspondente (ou nada) */
export type ArkonLidResolver = (lidJid: string) => string | undefined | Promise<string | undefined>

/** devolve só os dígitos do número de um JID de telefone; '' se não for um número */
export const phoneNumberFromJid = (jid: string | undefined): string => {
	const decoded = jidDecode(jid)
	if (!decoded) {
		return ''
	}

	if (decoded.server !== 's.whatsapp.net' && decoded.server !== 'c.us') {
		return ''
	}

	return /^\d+$/.test(decoded.user) ? decoded.user : ''
}

/** cria um resolvedor a partir de um mapa pronto (LID → JID de telefone) */
export const makeLidResolverFromMap = (mapping: Map<string, string> | Record<string, string>): ArkonLidResolver => {
	const lookup = mapping instanceof Map ? mapping : new Map(Object.entries(mapping))
	return (lidJid: string) => lookup.get(lidJid) ?? lookup.get(jidNormalizedUser(lidJid) ?? lidJid)
}

/** resolve um JID "@lid" pro JID de telefone usando o resolvedor; '' se não der */
export const resolveLidToPhoneJid = async (jid: string | undefined, resolver: ArkonLidResolver): Promise<string> => {
	if (!jid) {
		return ''
	}

	if (!isLidUser(jid)) {
		return jidNormalizedUser(jid) ?? ''
	}

	const mapped = await resolver(jidNormalizedUser(jid) ?? jid)
	return mapped ? (jidNormalizedUser(mapped) ?? '') : ''
}

/**
 * Devolve só os dígitos do número por trás de um JID. Se for "@lid" e você
 * passar um resolvedor, tenta mapear pro telefone antes. Nunca lança erro.
 */
export const resolveToPhoneNumber = async (jid: string | undefined, resolver?: ArkonLidResolver): Promise<string> => {
	if (!jid) {
		return ''
	}

	if (isLidUser(jid)) {
		if (!resolver) {
			return ''
		}

		return phoneNumberFromJid(await resolveLidToPhoneJid(jid, resolver))
	}

	return phoneNumberFromJid(jidNormalizedUser(jid) ?? jid)
}
