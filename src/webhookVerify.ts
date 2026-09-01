import { createHmac, timingSafeEqual } from "node:crypto";
import { config, webhookUrl } from "./config.js";

/**
 * Trello signs webhook deliveries as base64(HMAC-SHA1(rawBody + callbackURL, apiSecret)),
 * sent in the X-Trello-Webhook header — body first, then the callback URL (verified
 * empirically against real deliveries; several third-party docs state it the other
 * way around, which does not match what Trello's servers actually send).
 *
 * Must be computed over the exact raw request body bytes as a Buffer, concatenated
 * with the URL as a UTF-8 buffer — never round-trip the body through a JS string,
 * which is only lossless if every byte happens to already be valid UTF-8.
 */
export function verifyTrelloSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader) return false;

  const message = Buffer.concat([rawBody, Buffer.from(webhookUrl, "utf8")]);
  const expected = createHmac("sha1", config.trelloApiSecret).update(message).digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
