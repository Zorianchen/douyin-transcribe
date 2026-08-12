'use strict';

// 手写 multipart/form-data，用于上传音频到 Groq

function buildMultipart(fields, boundary) {
  boundary = boundary || '----FormBoundary' + Math.random().toString(36).slice(2);
  const parts = [];
  for (const f of fields) {
    parts.push(Buffer.from(`--${boundary}\r\n`));
    if (f.filename) {
      parts.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
            `Content-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`
        )
      );
      parts.push(f.buffer);
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(
        Buffer.from(`Content-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`)
      );
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

module.exports = { buildMultipart };
