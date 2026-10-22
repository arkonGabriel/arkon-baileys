import { randomBytes } from 'crypto'
import type { proto } from '../../WAProto/index.js'
import type { BinaryNode } from '../WABinary'

/** native flows WhatsApp renders with their own `interactive` node instead of the generic "mixed" one */
const FLOWS_MAP: Record<string, true> = {
	mpm: true,
	cta_catalog: true,
	send_location: true,
	call_permission_request: true,
	wa_payment_transaction_details: true,
	automated_greeting_message_view_catalog: true
}

const NATIVE_FLOW_ATTRIBUTE = { type: 'native_flow', v: '1' }

/**
 * Buttons, lists and native flows are only rendered by the receiving client when the stanza
 * carries a `biz` node describing them, as messages from the Business API do.
 */
export const shouldIncludeBizBinaryNode = (message: proto.IMessage) =>
	!!(
		message.buttonsMessage ||
		message.listMessage ||
		message.templateMessage ||
		message.interactiveMessage?.nativeFlowMessage
	)

export const getBizBinaryNode = (message: proto.IMessage): BinaryNode => {
	const flowMsg = message.interactiveMessage?.nativeFlowMessage
	const firstButtonName = flowMsg?.buttons?.[0]?.name
	const qualityContent: BinaryNode = {
		tag: 'quality_control',
		attrs: {
			decision_id: randomBytes(20).toString('hex'),
			source_type: 'third_party'
		},
		content: [{ tag: 'decision_source', attrs: { value: 'df' } }]
	}
	const attrs: Record<string, string> = {
		actual_actors: '2',
		host_storage: '2',
		privacy_mode_ts: `${(Date.now() / 1_000) | 0}`
	}

	if (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info') {
		attrs.native_flow_name = firstButtonName === 'review_and_pay' ? 'order_details' : firstButtonName
		return { tag: 'biz', attrs, content: [qualityContent] }
	}

	if (firstButtonName && FLOWS_MAP[firstButtonName]) {
		return {
			tag: 'biz',
			attrs,
			content: [
				{
					tag: 'interactive',
					attrs: NATIVE_FLOW_ATTRIBUTE,
					content: [{ tag: 'native_flow', attrs: { v: '2', name: firstButtonName } }]
				},
				qualityContent
			]
		}
	}

	if (flowMsg || message.buttonsMessage || message.templateMessage) {
		return {
			tag: 'biz',
			attrs,
			content: [
				{
					tag: 'interactive',
					attrs: NATIVE_FLOW_ATTRIBUTE,
					content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
				},
				qualityContent
			]
		}
	}

	if (message.listMessage) {
		return {
			tag: 'biz',
			attrs,
			content: [{ tag: 'list', attrs: { v: '2', type: 'product_list' } }, qualityContent]
		}
	}

	return { tag: 'biz', attrs, content: [qualityContent] }
}
