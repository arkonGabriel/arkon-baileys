/**
 * Arkon: fallback de botão → texto.
 *
 * Alguns aparelhos/versões do WhatsApp não mostram botões, listas ou cards.
 * Estas funções transformam um conteúdo com botões num texto equivalente, pra
 * ninguém ficar sem ver as opções. É opcional e puro (não envia nada): você
 * decide quando usar o texto no lugar dos botões.
 */

const readString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const pick = (obj: unknown, key: string): unknown =>
	obj !== null && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** tenta achar um rótulo legível dentro de um objeto de botão, em várias formas conhecidas */
const labelOf = (button: unknown): string => {
	const displayText = readString(pick(pick(button, 'buttonText'), 'displayText'))
	if (displayText) {
		return displayText
	}

	const fromQuick = readString(pick(pick(button, 'quickReplyButton'), 'displayText'))
	if (fromQuick) {
		return fromQuick
	}

	const urlButton = pick(button, 'urlButton')
	const urlLabel = readString(pick(urlButton, 'displayText'))
	if (urlLabel) {
		const url = readString(pick(urlButton, 'url'))
		return url ? `${urlLabel} (${url})` : urlLabel
	}

	const callButton = pick(button, 'callButton')
	const callLabel = readString(pick(callButton, 'displayText'))
	if (callLabel) {
		const phone = readString(pick(callButton, 'phoneNumber'))
		return phone ? `${callLabel} (${phone})` : callLabel
	}

	return (
		readString(pick(button, 'displayText')) ||
		readString(pick(button, 'name')) ||
		readString(pick(button, 'title')) ||
		readString(pick(button, 'text'))
	)
}

/** extrai, em ordem, todos os rótulos de opção de um conteúdo com botões/listas/cards */
export const extractButtonLabels = (content: unknown): string[] => {
	const labels: string[] = []

	for (const button of asArray(pick(content, 'buttons'))) {
		const label = labelOf(button)
		if (label) {
			labels.push(label)
		}
	}

	for (const button of asArray(pick(content, 'templateButtons'))) {
		const label = labelOf(button)
		if (label) {
			labels.push(label)
		}
	}

	for (const button of asArray(pick(content, 'interactiveButtons'))) {
		const label = labelOf(button)
		if (label) {
			labels.push(label)
		}
	}

	for (const section of asArray(pick(content, 'sections'))) {
		const sectionTitle = readString(pick(section, 'title'))
		if (sectionTitle) {
			labels.push(sectionTitle)
		}

		for (const row of asArray(pick(section, 'rows'))) {
			const rowTitle = readString(pick(row, 'title'))
			const rowDesc = readString(pick(row, 'description'))
			if (rowTitle) {
				labels.push(rowDesc ? `${rowTitle} — ${rowDesc}` : rowTitle)
			}
		}
	}

	return labels
}

export interface ButtonsToTextOptions {
	/** numera as opções (1, 2, 3...). padrão: true */
	numbered?: boolean
	/** marcador usado quando `numbered` é false. padrão: '•' */
	bullet?: string
}

/**
 * Monta o texto equivalente de um conteúdo com botões: junta título, corpo,
 * rodapé e a lista de opções. Retorna '' se não houver nada aproveitável.
 */
export const arkonButtonsToText = (content: unknown, options: ButtonsToTextOptions = {}): string => {
	const numbered = options.numbered !== false
	const bullet = options.bullet ?? '•'

	const parts: string[] = []
	const title = readString(pick(content, 'title'))
	if (title) {
		parts.push(title)
	}

	const body = readString(pick(content, 'text')) || readString(pick(content, 'caption'))
	if (body) {
		parts.push(body)
	}

	const labels = extractButtonLabels(content)
	if (labels.length > 0) {
		const list = labels.map((label, index) => (numbered ? `${index + 1}. ${label}` : `${bullet} ${label}`)).join('\n')
		parts.push(list)
	}

	const footer = readString(pick(content, 'footer'))
	if (footer) {
		parts.push(footer)
	}

	return parts.join('\n\n')
}

/**
 * Se os botões estiverem desligados (ou não suportados), devolve `{ text }` com
 * o fallback. Caso contrário devolve o próprio conteúdo, sem mexer.
 */
export const withButtonTextFallback = <T>(content: T, enabled: boolean): T | { text: string } => {
	if (enabled) {
		return content
	}

	const text = arkonButtonsToText(content)
	return text ? { text } : content
}
