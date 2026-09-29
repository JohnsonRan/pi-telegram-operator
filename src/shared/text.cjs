// Appends chunk and keeps only the last maxBytes UTF-8 bytes, marking truncation with "…".
function appendBoundedText(current, chunk, maxBytes) {
  const combined = `${current}${String(chunk)}`;
  const bytes = Buffer.from(combined, "utf8");
  if (bytes.length <= maxBytes) return combined;
  return `…${bytes.subarray(bytes.length - maxBytes + 3).toString("utf8").replace(/^\uFFFD+/, "")}`;
}

module.exports = Object.freeze({ appendBoundedText });
