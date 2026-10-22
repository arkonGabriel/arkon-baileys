import { ARKON_FALLBACK_URL, ARKON_LIBRARY_NAME } from './constants'
import type { ArkonNativeFlowButton, ArkonNativeFlowOptions } from './types'

export type NativeFlowButtonNode = { name?: string; buttonParamsJson?: string }

const isSet = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined && !!value

/** Turns the short `nativeFlow` button list into WhatsApp native flow buttons */
export const prepareNativeFlowButtons = (message: ArkonNativeFlowOptions) => {
	const field = message.nativeFlow
	const buttons: ArkonNativeFlowButton[] = Array.isArray(field) ? field : field?.buttons || []
	const messageParamsJson: Record<string, unknown> = {}

	if (isSet(message.offerText)) {
		messageParamsJson.limited_time_offer = {
			text: message.offerText || ARKON_LIBRARY_NAME,
			url: message.offerUrl || ARKON_FALLBACK_URL,
			copy_code: message.offerCode,
			expiration_time: message.offerExpiration
		}
	}

	if (isSet(message.optionText)) {
		messageParamsJson.bottom_sheet = {
			in_thread_buttons_limit: 1,
			divider_indices: Array.from({ length: buttons.length }, (_, index) => index),
			list_title: message.optionTitle || '📄 Select Options',
			button_title: message.optionText
		}
	}

	return {
		buttons: buttons.map((button): NativeFlowButtonNode => {
			const displayText = button.text || button.buttonText
			const icon = button.icon?.toUpperCase()
			if (isSet(button.id)) {
				return {
					name: 'quick_reply',
					buttonParamsJson: JSON.stringify({ display_text: displayText || '👉🏻 Click', id: button.id, icon })
				}
			}

			if (isSet(button.copy)) {
				return {
					name: 'cta_copy',
					buttonParamsJson: JSON.stringify({ display_text: displayText || '📋 Copy', copy_code: button.copy, icon })
				}
			}

			if (isSet(button.url)) {
				return {
					name: 'cta_url',
					buttonParamsJson: JSON.stringify({
						display_text: displayText || '🌐 Visit',
						url: button.url,
						merchant_url: button.url,
						webview_interaction: button.useWebview,
						icon
					})
				}
			}

			if (isSet(button.call)) {
				return {
					name: 'cta_call',
					buttonParamsJson: JSON.stringify({ display_text: displayText || '📞 Call', phone_number: button.call, icon })
				}
			}

			if (isSet(button.sections)) {
				return {
					name: 'single_select',
					buttonParamsJson: JSON.stringify({ title: displayText || '📋 Select', sections: button.sections, icon })
				}
			}

			return button as NativeFlowButtonNode
		}),
		messageParamsJson: JSON.stringify(messageParamsJson)
	}
}
