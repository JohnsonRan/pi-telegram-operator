const MAX_SOURCE_CHARS = 3500;
// Bot API rich messages allow 32768 characters and 500 blocks; stay well below both.
const RICH_SOURCE_CHARS = 12000;
// Tags a model writes on purpose in a Markdown answer. Block and structural tags (p, pre,
// a, img, table, li, ...) stay escaped: a coding agent mostly writes those while talking
// about HTML, and rendering them would turn the explanation into layout or drop it.
const RICH_HTML_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "mark", "sub", "sup",
  "tg-spoiler", "br", "details", "summary", "tg-button", "tg-button-row",
]);
const VOID_TAGS = new Set(["br"]);
const BUTTON_STYLES = new Set(["success", "danger", "primary", "link"]);

// Rebuilds a button from parsed attributes, dropping everything the type does not need;
// smuggled or duplicated attributes (e.g. a callback data payload) can never pass through.
function canonicalButton(attributes) {
  const parsed = new Map();
  for (const [, name, raw = ""] of attributes.matchAll(/([:\w-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g)) {
    if (parsed.has(name)) return '<tg-button type="disabled">';
    parsed.set(name, raw.replace(/^["']|["']$/g, ""));
  }
  const style = BUTTON_STYLES.has(parsed.get("style")) ? ` style="${parsed.get("style")}"` : "";
  if (parsed.get("type") === "url") {
    const url = safeUrl(parsed.get("url"));
    return url ? `<tg-button type="url"${style} url="${url}">` : '<tg-button type="disabled">';
  }
  if (parsed.get("type") === "copy_text") {
    const text = parsed.get("text");
    return text === undefined ? '<tg-button type="disabled">' : `<tg-button type="copy_text"${style} text="${escapeHtml(text)}">`;
  }
  return parsed.get("type") === "disabled" ? `<tg-button type="disabled"${style}>` : '<tg-button type="disabled">';
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeUrl(value) {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    if (!["http:", "https:", "mailto:", "tel:", "tg:"].includes(url.protocol)) return undefined;
    if (url.protocol === "tg:" && !/^tg:\/\/user\?id=\d+$/.test(raw)) return undefined;
    return escapeHtml(raw);
  } catch {
    return undefined;
  }
}

function renderInline(value, allowLinks = true) {
  const tokens = [];
  let source = String(value ?? "");
  let marker = "\uE000TG";
  while (source.includes(marker)) marker += "X";
  const token = (html) => {
    const index = tokens.push(html) - 1;
    return `${marker}${index}\uE001`;
  };

  source = source.replace(/\\([!-/:-@[-`{-~])/g, (_match, character) => token(escapeHtml(character)));
  source = source.replace(/&(?:lt|gt|amp|quot);/g, (entity) => token(entity));
  source = source.replace(/(`+)([^\n]*?)\1/g, (_match, _ticks, code) => token(`<code>${escapeHtml(code)}</code>`));

  if (allowLinks) {
    source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const safe = safeUrl(href);
      return safe ? token(`<a href="${safe}">${renderInline(label, false)}</a>`) : match;
    });
    source = source.replace(/<(https?:\/\/[^\s<>]+)>/g, (_match, href) => {
      const safe = safeUrl(href);
      return safe ? token(`<a href="${safe}">${escapeHtml(href)}</a>`) : href;
    });
  }

  let html = escapeHtml(source);
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/\|\|([^|\n]+)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
    .replace(/(?<![\w])_([^_\n]+)_(?![\w])/g, "<i>$1</i>");

  return html.split(marker).map((part, index) => {
    if (index === 0) return part;
    const match = part.match(/^(\d+)\uE001/);
    if (!match) return `${marker}${part}`;
    return `${tokens[Number(match[1])] ?? ""}${part.slice(match[0].length)}`;
  }).join("");
}

function codeLanguage(value) {
  return String(value ?? "").trim().replace(/[^A-Za-z0-9_+-]/g, "").slice(0, 40);
}

function renderCodeBlock(language, lines) {
  const normalized = codeLanguage(language);
  const className = normalized ? ` class="language-${escapeHtml(normalized)}"` : "";
  return `<pre><code${className}>${escapeHtml(lines.join("\n"))}</code></pre>`;
}

// Legacy HTML has no inline media: web images become links, everything else its caption.
function legacyImages(markdown) {
  return mapImages(markdown, (alt, url) => (/^https?:/i.test(url)
    ? `[${alt || url.split(/[\\/?#]/).filter(Boolean).pop() || "image"}](${url})`
    : localImageText(alt, url)));
}

function renderTelegramHtml(markdown) {
  const lines = legacyImages(markdown).split("\n");
  const output = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s*```\s*([^`]*)$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      output.push(renderCodeBlock(fence[1], code));
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      let cursor = index;
      while (cursor < lines.length && /^\s*>/.test(lines[cursor])) {
        quote.push(renderInline(lines[cursor].replace(/^\s*>\s?/, "")));
        cursor += 1;
      }
      output.push(`<blockquote>${quote.join("\n")}</blockquote>`);
      index = cursor - 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(`<b>${renderInline(heading[1])}</b>`);
      continue;
    }

    const unordered = line.match(/^(\s*)[-+*]\s+(.+)$/);
    if (unordered) {
      output.push(`${unordered[1]}• ${renderInline(unordered[2])}`);
      continue;
    }

    const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      output.push(`${ordered[1]}${ordered[2]}. ${renderInline(ordered[3])}`);
      continue;
    }

    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push("────────");
      continue;
    }

    output.push(renderInline(line));
  }

  return output.join("\n").trim();
}

// Escapes text for Markdown. Telegram's rich parser honors a backslash only before the
// characters below (verified against the live API); before others, such as `:` or `/`,
// the backslash stays visible. `<` and `&` become entities, which the legacy renderer
// decodes as well.
function escapeMarkdown(value) {
  const entities = { "<": "&lt;", "&": "&amp;" };
  return String(value ?? "").replace(/[!#$()*+\-.=>[\]_`{|}~\\<&]/g, (character) => entities[character] ?? `\\${character}`);
}

// Calls fn on every stretch of text outside fenced code blocks and code spans, in order.
function mapProse(markdown, fn) {
  let fence;
  return String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n").map((line) => {
    if (fence) {
      if (new RegExp(`^\\s*(?:>\\s*)*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      return line;
    }
    const open = line.match(/^\s*(?:>\s*)*(`{3,}|~{3,})/);
    if (open) {
      fence = open[1];
      return line;
    }
    return line.split(/(`+[^`]*?`+)/).map((part, index) => (index % 2 ? part : fn(part))).join("");
  }).join("\n");
}

// Classifies one tag; buttons are rebuilt in canonical form so only safe types survive.
function richTag(text) {
  const match = text.match(/^<(\/?)([A-Za-z][\w-]*)((?:\s[^<>]*)?)>$/);
  const name = match?.[2].toLowerCase();
  if (!name || !RICH_HTML_TAGS.has(name)) return undefined;
  const selfClosing = /\/\s*$/.test(match[3]);
  let tagText = text;
  if (!match[1] && name === "tg-button") {
    tagText = canonicalButton(match[3].replace(/\/\s*$/, ""));
    if (selfClosing) tagText = `${tagText.slice(0, -1)} />`;
  }
  return {
    name,
    closing: Boolean(match[1]),
    paired: !VOID_TAGS.has(name) && !selfClosing,
    text: tagText,
  };
}

// Rich Markdown accepts raw HTML but silently drops unknown tags (`Vec<String>` loses
// `<String>`, even as `\<String>`), so tag-like text outside code becomes `&lt;` unless
// it is a supported tag. Paired tags must balance, or a stray `<p>` would swallow text.
function prepareRichMarkdown(markdown) {
  const candidate = /\\?<(?!https?:\/\/|mailto:)(?=[A-Za-z/!?])(?:\/?[A-Za-z][\w-]*(?:\s[^<>]*)?>)?/g;
  const found = [];
  mapProse(markdown, (text) => {
    text.replace(candidate, (match) => {
      found.push(match.startsWith("\\") ? undefined : richTag(match));
      return match;
    });
    return text;
  });
  const balance = new Map();
  for (const tag of found) {
    if (tag?.paired) balance.set(tag.name, (balance.get(tag.name) || 0) + (tag.closing ? -1 : 1));
  }
  let index = 0;
  return mapProse(markdown, (text) => text.replace(candidate, (match) => {
    const tag = found[index++];
    return tag && !(tag.paired && balance.get(tag.name)) ? tag.text : `&lt;${match.replace(/^\\?</, "")}`;
  }));
}

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g;

// Rewrites Markdown images outside code; fn(alt, url, title) returns the replacement.
function mapImages(markdown, fn) {
  return mapProse(markdown, (text) => text.replace(MARKDOWN_IMAGE, (match, alt, url, title = "") =>
    fn(alt, url.replace(/^<|>$/g, ""), title) ?? match));
}

const isRemoteUrl = (url) => /^(?:https?|tg):/i.test(url);

// A local image Telegram cannot fetch would make it reject the whole message.
const localImageText = (alt, url) => `*${escapeMarkdown(alt || url.split(/[\\/]/).pop())}*`;

// Drafts cannot upload files, so local images become their caption until the final message.
function prepareRichDraft(markdown) {
  return prepareRichMarkdown(mapImages(markdown, (alt, url) => (isRemoteUrl(url) ? undefined : localImageText(alt, url))));
}

// Live status in a draft-only thinking block; HTML block content is not Markdown.
function richThinking(text) {
  return `<tg-thinking>${String(text ?? "").split("\n").map(escapeHtml).join("<br>")}</tg-thinking>`;
}

function renderedTextLength(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|amp|quot);/g, "x")
    .replace(/&#(?:x[0-9a-f]+|\d+);/gi, "x")
    .length;
}

function preferredSplitIndex(source) {
  const midpoint = Math.floor(source.length / 2);
  const before = source.lastIndexOf("\n", midpoint);
  const after = source.indexOf("\n", midpoint);
  if (before > 0 && midpoint - before < source.length / 4) return before;
  if (after > 0 && after - midpoint < source.length / 4) return after;
  return Math.max(1, midpoint);
}

// Finds the opening fence of a code block still open at the end of source.
function openFence(source) {
  let open;
  let offset = 0;
  for (const line of source.split("\n")) {
    if (open) {
      if (/^\s*```\s*$/.test(line)) open = undefined;
    } else {
      const match = line.match(/^\s*```\s*([^`]*)$/);
      if (match) open = { start: offset, end: offset + line.length, reopen: `\`\`\`${codeLanguage(match[1])}` };
    }
    offset += line.length + 1;
  }
  return open;
}

function splitMarkdown(value, renderedLimit = MAX_SOURCE_CHARS) {
  const source = String(value ?? "");
  if (!source) return [""];
  if (renderedTextLength(renderTelegramHtml(source)) <= renderedLimit) return [source];
  if (source.length === 1) return [source];

  const index = preferredSplitIndex(source);
  let left = source.slice(0, index).replace(/\n$/, "");
  let right = source.slice(index).replace(/^\n/, "");
  if (!left || !right) {
    const midpoint = Math.max(1, Math.floor(source.length / 2));
    left = source.slice(0, midpoint);
    right = source.slice(midpoint);
  }
  let fence = openFence(left);
  if (fence && fence.end === left.length) {
    // The split landed right after an opening fence; never emit an empty block.
    if (fence.start > 0) {
      right = `${left.slice(fence.start)}\n${right}`;
      left = left.slice(0, fence.start).replace(/\n$/, "");
      fence = undefined;
    } else {
      // Nothing precedes the fence, so split the code body itself.
      const midpoint = Math.max(1, Math.floor(right.length / 2));
      left = `${fence.reopen}\n${right.slice(0, midpoint)}`;
      right = right.slice(midpoint);
      fence = openFence(left);
    }
  }
  // Reopen a code block cut in half so the tail still renders as code;
  // renderTelegramHtml closes the unterminated head on its own. The short
  // canonical fence keeps every recursive piece smaller than its parent.
  if (fence) right = `${fence.reopen}\n${right}`;
  return [
    ...splitMarkdown(left, renderedLimit),
    ...splitMarkdown(right, renderedLimit),
  ];
}

function renderTelegramChunkPairs(markdown, renderedLimit = MAX_SOURCE_CHARS) {
  return splitMarkdown(markdown, renderedLimit)
    .map((source) => ({ source, html: renderTelegramHtml(source) }))
    .filter((chunk) => chunk.html);
}

function renderTelegramChunks(markdown, renderedLimit = MAX_SOURCE_CHARS) {
  return renderTelegramChunkPairs(markdown, renderedLimit).map((chunk) => chunk.html);
}

module.exports = Object.freeze({
  RICH_SOURCE_CHARS,
  escapeHtml,
  escapeMarkdown,
  isRemoteUrl,
  localImageText,
  mapImages,
  prepareRichDraft,
  prepareRichMarkdown,
  richThinking,
  renderInline,
  renderedTextLength,
  renderTelegramChunkPairs,
  renderTelegramChunks,
  renderTelegramHtml,
  safeUrl,
  splitMarkdown,
});
