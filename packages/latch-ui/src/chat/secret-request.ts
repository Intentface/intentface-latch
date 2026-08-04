/**
 * The secret-entry form an agent can open in the composer.
 *
 * The point of this flow is that the agent never learns a credential. A field
 * with `secret: true` is collected here, sent by the host straight to its own
 * server (never through the chat stream), and reported back to the agent as
 * `name` alone. A field with `secret: false` is an ordinary value the agent does
 * get — a client id, an account slug — so it can finish the configuration.
 *
 * Mirrors {@link AskUserQuestion}: the shape is the contract between a host's
 * tool definition and this package's renderer.
 */
export interface SecretRequestField {
  /** Identifier for this field in the submitted values. */
  key: string;
  /** Shown above the input. */
  label: string;
  /** true → stored server-side under `name`, never returned to the agent. */
  secret: boolean;
  /** Vault name for a secret field. Required when `secret` is true. */
  name?: string;
  /** One short line telling the user where to find the value. */
  hint?: string;
}

export interface SecretRequestInput {
  /** Heading for the form. */
  title: string;
  /** Where the secrets are stored — shown to the user so the blast radius is explicit. */
  scope: "user" | "org";
  fields: SecretRequestField[];
}

/** What the host submits once the user saves (or skips). */
export interface SecretRequestSubmit {
  /** Every field's value, keyed by `field.key`. Empty when declined. */
  values: Record<string, string>;
  /** True when the user chose Skip rather than Save. */
  declined: boolean;
}
