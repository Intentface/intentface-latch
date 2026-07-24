import { tool, jsonSchema } from "ai";

/**
 * The approval-gated Google Workspace write tools, contributed by the
 * `google_workspace_write` connection (see google-workspace.ts).
 *
 * The draft-and-apply contract, shared by every tool here: the agent composes
 * (in chat or /workspace), then calls the tool with the FINAL content inline —
 * the approval prompt shows the tool input verbatim, so what the user approves
 * is exactly what is written. Never accept a file path: it would hide the
 * content from the approver and let it change between approval and execution.
 *
 * Each tool is one narrow REST verb against the service's API; the access
 * token comes from the connection's per-tenant refresh grant.
 */

type GetToken = () => Promise<string>;

const DOCS_URL = "https://docs.googleapis.com/v1/documents";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const SLIDES_URL = "https://slides.googleapis.com/v1/presentations";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/** Authorized JSON round trip; throws with the API's error body on failure. */
async function gjson<T>(getToken: GetToken, url: string, body: unknown): Promise<T> {
  const token = await getToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${new URL(url).pathname} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** RFC 2047-encode a header value when it isn't plain ASCII. */
const encodeHeader = (value: string): string =>
  /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

/**
 * Build the RFC 822 message Gmail's `messages.send` expects (as base64url
 * `raw`). Body is base64-encoded so any UTF-8 content is line-length safe;
 * Bcc is honored by Gmail and stripped from delivered copies.
 */
export function buildRawEmail(msg: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const headers = [
    `To: ${msg.to}`,
    ...(msg.cc ? [`Cc: ${msg.cc}`] : []),
    ...(msg.bcc ? [`Bcc: ${msg.bcc}`] : []),
    `Subject: ${encodeHeader(msg.subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
  ];
  const rfc822 = `${headers.join("\r\n")}\r\n\r\n${Buffer.from(msg.body, "utf8").toString("base64")}`;
  return Buffer.from(rfc822, "utf8").toString("base64url");
}

/**
 * Build the write tool set for one tenant (`getToken` closes over the
 * principal). Keys are the tool names agents see; every one of them must be
 * approval-gated by the connection.
 */
export function googleWriteTools(getToken: GetToken): Record<string, unknown> {
  const gmail_send = tool({
    description:
      "Send an email from the user's own Gmail. Compose the final message " +
      "first, then call this ONCE with the complete content — the user " +
      "reviews and approves exactly this input before anything is sent.",
    inputSchema: jsonSchema<{
      to: string;
      subject: string;
      body: string;
      cc?: string;
      bcc?: string;
    }>({
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient(s), comma-separated." },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body — the full, final message." },
        cc: { type: "string", description: "Optional Cc recipient(s), comma-separated." },
        bcc: { type: "string", description: "Optional Bcc recipient(s), comma-separated." },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    }),
    execute: async (input) => {
      const sent = await gjson<{ id?: string; threadId?: string }>(getToken, GMAIL_SEND_URL, {
        raw: buildRawEmail(input),
      });
      return { sent: true, id: sent.id, threadId: sent.threadId, to: input.to, subject: input.subject };
    },
  });

  const gdocs_create = tool({
    description:
      "Create a new Google Doc in the user's Drive with the given title and " +
      "full text content. The user reviews and approves exactly this input " +
      "before the document is created.",
    inputSchema: jsonSchema<{ title: string; body?: string }>({
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string", description: "Plain-text document content (optional)." },
      },
      required: ["title"],
      additionalProperties: false,
    }),
    execute: async ({ title, body }) => {
      const doc = await gjson<{ documentId: string }>(getToken, DOCS_URL, { title });
      if (body) {
        await gjson(getToken, `${DOCS_URL}/${doc.documentId}:batchUpdate`, {
          requests: [{ insertText: { endOfSegmentLocation: {}, text: body } }],
        });
      }
      return {
        created: true,
        documentId: doc.documentId,
        title,
        url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
      };
    },
  });

  const gdocs_append = tool({
    description:
      "Append plain text to the END of an existing Google Doc (never edits " +
      "or removes existing content). Find the document id by browsing the " +
      "read-only /gdocs or /gdrive mount. The user reviews and approves " +
      "exactly this input before anything is written.",
    inputSchema: jsonSchema<{ document_id: string; text: string }>({
      type: "object",
      properties: {
        document_id: { type: "string" },
        text: { type: "string", description: "Text to append — the full, final content." },
      },
      required: ["document_id", "text"],
      additionalProperties: false,
    }),
    execute: async ({ document_id, text }) => {
      await gjson(getToken, `${DOCS_URL}/${document_id}:batchUpdate`, {
        requests: [{ insertText: { endOfSegmentLocation: {}, text } }],
      });
      return {
        appended: true,
        documentId: document_id,
        url: `https://docs.google.com/document/d/${document_id}/edit`,
      };
    },
  });

  const gsheets_create = tool({
    description:
      "Create a new Google Sheet with the given title, optionally seeded " +
      "with rows (a 2D array; first row is typically headers). The user " +
      "reviews and approves exactly this input before the sheet is created.",
    inputSchema: jsonSchema<{ title: string; rows?: string[][] }>({
      type: "object",
      properties: {
        title: { type: "string" },
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "Optional initial rows, outer array = rows, inner = cells.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    }),
    execute: async ({ title, rows }) => {
      const sheet = await gjson<{ spreadsheetId: string }>(getToken, SHEETS_URL, {
        properties: { title },
      });
      if (rows?.length) {
        await gjson(
          getToken,
          `${SHEETS_URL}/${sheet.spreadsheetId}/values/A1:append?valueInputOption=USER_ENTERED`,
          { values: rows },
        );
      }
      return {
        created: true,
        spreadsheetId: sheet.spreadsheetId,
        title,
        url: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`,
      };
    },
  });

  const gsheets_append = tool({
    description:
      "Append rows to an existing Google Sheet (after its current data — " +
      "never overwrites). Find the spreadsheet id by browsing the read-only " +
      "/gsheets or /gdrive mount. The user reviews and approves exactly this " +
      "input before anything is written.",
    inputSchema: jsonSchema<{ spreadsheet_id: string; rows: string[][]; range?: string }>({
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "Rows to append, outer array = rows, inner = cells.",
        },
        range: {
          type: "string",
          description: 'Table to append to, e.g. "Sheet2!A1". Default: first sheet.',
        },
      },
      required: ["spreadsheet_id", "rows"],
      additionalProperties: false,
    }),
    execute: async ({ spreadsheet_id, rows, range }) => {
      await gjson(
        getToken,
        `${SHEETS_URL}/${spreadsheet_id}/values/${encodeURIComponent(range ?? "A1")}:append?valueInputOption=USER_ENTERED`,
        { values: rows },
      );
      return {
        appended: true,
        spreadsheetId: spreadsheet_id,
        rowCount: rows.length,
        url: `https://docs.google.com/spreadsheets/d/${spreadsheet_id}/edit`,
      };
    },
  });

  const gslides_create = tool({
    description:
      "Create a new Google Slides presentation with the given title and " +
      "slides (each a title + optional body text, rendered on a " +
      "title-and-body layout). The user reviews and approves exactly this " +
      "input before the presentation is created.",
    inputSchema: jsonSchema<{
      title: string;
      slides?: { title: string; body?: string }[];
    }>({
      type: "object",
      properties: {
        title: { type: "string" },
        slides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              body: { type: "string", description: "Slide body text (optional)." },
            },
            required: ["title"],
            additionalProperties: false,
          },
        },
      },
      required: ["title"],
      additionalProperties: false,
    }),
    execute: async ({ title, slides }) => {
      const pres = await gjson<{ presentationId: string }>(getToken, SLIDES_URL, { title });
      if (slides?.length) {
        // One batchUpdate: create each slide with deterministic placeholder
        // ids (Slides object ids must be 5–50 chars), then fill them.
        const requests = slides.flatMap((s, i) => [
          {
            createSlide: {
              objectId: `slide_${i}_root`,
              slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
              placeholderIdMappings: [
                { layoutPlaceholder: { type: "TITLE" }, objectId: `slide_${i}_title` },
                { layoutPlaceholder: { type: "BODY" }, objectId: `slide_${i}_body` },
              ],
            },
          },
          ...(s.title
            ? [{ insertText: { objectId: `slide_${i}_title`, text: s.title } }]
            : []),
          ...(s.body ? [{ insertText: { objectId: `slide_${i}_body`, text: s.body } }] : []),
        ]);
        await gjson(getToken, `${SLIDES_URL}/${pres.presentationId}:batchUpdate`, { requests });
      }
      return {
        created: true,
        presentationId: pres.presentationId,
        title,
        slideCount: slides?.length ?? 0,
        url: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`,
      };
    },
  });

  return { gmail_send, gdocs_create, gdocs_append, gsheets_create, gsheets_append, gslides_create };
}
