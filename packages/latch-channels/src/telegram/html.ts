/**
 * Best-effort GFM → Telegram HTML (parse_mode: "HTML"), same modest scope as
 * the Slack adapter's `toMrkdwn`: bold, italic, strike, inline code, code
 * fences, links. HTML is deliberately chosen over MarkdownV2 — MarkdownV2
 * requires escaping 18 characters and partially streamed markdown breaks its
 * parser, while unknown tags in HTML just error one edit (we then retry the
 * edit as plain text).
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline formatting on an already-escaped, fence-free segment. */
function inline(escaped: string): string {
  return (
    escaped
      // inline code first so its contents are not re-formatted
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/__(.+?)__/g, "<b>$1</b>")
      .replace(/~~(.+?)~~/g, "<s>$1</s>")
      // _italic_ only at word boundaries, so snake_case survives
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/gm, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  );
}

export function gfmToTelegramHtml(gfm: string): string {
  // Code fences become <pre>; everything else gets inline formatting. The
  // language tag on the opening fence line is stripped inside the code segment
  // (splitting on the bare fence keeps the closing fence's newline in prose).
  const parts = gfm.split("```");
  return parts
    .map((part, i) =>
      i % 2 === 1
        ? `<pre>${escapeHtml(part.replace(/^[\w+-]*\n/, "").replace(/\n$/, ""))}</pre>`
        : inline(escapeHtml(part)),
    )
    .join("");
}
