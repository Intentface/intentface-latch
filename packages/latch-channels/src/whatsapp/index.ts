/**
 * @intentface/latch-channels/whatsapp
 *
 * Bring a Latch agent to WhatsApp via the Meta Business Cloud API: per-bot
 * webhook handling (hub.challenge handshake + X-Hub-Signature-256), one reply
 * per turn (split past 4096 chars — WhatsApp cannot edit messages), reply-
 * button approvals, and media → multimodal file parts. Pure protocol
 * translation — identity, credentials and dedupe are injected by the host.
 */
export {
  whatsappApi,
  WhatsappApiError,
  type LazyString,
  type WhatsappApiOptions,
  type WhatsappClient,
  type WhatsappReplyButton,
} from "./api.js";
export { verifyWhatsappSignature, whatsappVerifyChallenge } from "./verify.js";
export {
  whatsappChannel,
  encodeWhatsappApprovalId,
  decodeWhatsappApprovalId,
  splitWhatsappText,
  type WhatsappAuthResult,
  type WhatsappChannelConfig,
} from "./whatsappChannel.js";
