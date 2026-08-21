/**
 * The secret-entry form an agent can open in the composer.
 *
 * The point of the flow is that the agent never learns a credential. A field
 * with `secret: true` is collected in the browser, sent straight to the app's
 * own server (never through the chat stream), and reported back to the agent as
 * `name` alone. A field with `secret: false` is an ordinary value the agent does
 * get — a client id, an account slug — so it can finish the configuration.
 */

import type { UnknownPart } from "@intentface/chat/types"
import { isAnyToolPart  } from "@/lib/ai/types"
import type {ToolPart} from "@/lib/ai/types";

export interface SecretRequestField {
  /** Identifier for this field in the submitted values. */
  key: string
  /** Shown above the input. */
  label: string
  /** true → stored server-side under `name`, never returned to the agent. */
  secret: boolean
  /** Vault name for a secret field. Required when `secret` is true. */
  name?: string
  /** One short line telling the user where to find the value. */
  hint?: string
}

export interface SecretRequestInput {
  /** Heading for the form. */
  title: string
  /** Where the secrets are stored — shown so the blast radius is explicit. */
  scope: "user" | "org"
  fields: SecretRequestField[]
}

/** What the host submits once the user saves (or skips). */
export interface SecretRequestSubmit {
  /** Every field's value, keyed by `field.key`. Empty when declined. */
  values: Record<string, string>
  /** True when the user chose Skip rather than Save. */
  declined: boolean
}

const isSecretRequestPart = (part: UnknownPart): part is ToolPart =>
  isAnyToolPart(part) && part.type === "tool-request_secret"

/** A settled `request_secret` call, for the collapsed summary in the transcript. */
export type SecretRequestAnswered = {
  toolCallId: string
  title: string
  /** Vault names written. Never a value — there is none in the part to read. */
  saved: string[]
  /** Non-secret fields the user filled in, label → value. */
  values: { label: string; value: string }[]
  declined: boolean
}

/**
 * Extracts settled `request_secret` parts. The tool's OUTPUT is the only place a
 * result lives, and by construction it carries names and non-secret values only
 * — so there is nothing here that could leak a credential.
 */
export const getSecretRequestsAnswered = (
  allParts: readonly UnknownPart[]
): SecretRequestAnswered[] =>
  allParts
    .filter(
      (p): p is ToolPart =>
        isSecretRequestPart(p) && p.state === "output-available"
    )
    .map((part) => {
      const input = part.input as
        | { title?: string; fields?: { key: string; label: string }[] }
        | undefined

      let out: {
        saved?: string[]
        values?: Record<string, string>
        declined?: boolean
      } = {}
      const raw = part.output
      if (raw && typeof raw === "object") {
        out = raw
      } else if (typeof raw === "string") {
        try {
          out = JSON.parse(raw) as typeof out
        } catch {
          // A malformed result still renders as a settled request; leave it empty.
        }
      }

      const labelOf = (key: string) =>
        input?.fields?.find((f) => f.key === key)?.label ?? key

      return {
        toolCallId: part.toolCallId,
        title: input?.title ?? "Credentials",
        saved: out.saved ?? [],
        values: Object.entries(out.values ?? {}).map(([key, value]) => ({
          label: labelOf(key),
          value,
        })),
        declined: !!out.declined,
      }
    })

/** The `request_secret` call currently awaiting the user, if any. */
export const findPendingSecretRequest = (
  allParts: readonly UnknownPart[]
): { toolCallId: string; request: SecretRequestInput } | undefined => {
  const part = allParts.find(
    (p): p is ToolPart =>
      isSecretRequestPart(p) && p.state === "input-available"
  )
  if (!part) return undefined
  const request = part.input as SecretRequestInput | undefined
  if (!request?.fields?.length) return undefined
  return { toolCallId: part.toolCallId, request }
}
