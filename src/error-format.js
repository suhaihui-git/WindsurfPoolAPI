export function sanitizePublicErrorMessage(message, fallback = 'Upstream service error') {
  let msg = String(message || fallback);
  msg = msg.replace(/\bWindsurf\b/gi, 'upstream service');
  msg = msg.replace(/\bCodeium\b/gi, 'upstream service');
  msg = msg.replace(/\bFirebase\b/gi, 'authentication service');
  msg = msg.replace(/\/tmp\/windsurf-workspace/gi, '[redacted-path]');
  msg = msg.replace(/\/opt\/windsurf/gi, '[redacted-path]');
  msg = msg.replace(/internal error occurred \(error ID:[^)]+\)/gi, 'internal upstream error');
  msg = msg.replace(/\s+/g, ' ').trim();
  if (!msg) return fallback;
  return msg;
}

export function buildOpenAIError(message, type = 'upstream_error', extra = {}) {
  return {
    error: {
      message: sanitizePublicErrorMessage(message),
      type,
      ...extra,
    },
  };
}

export function writeOpenAIStreamError(res, status, message, type = 'upstream_error', extra = {}) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(buildOpenAIError(message, type, extra));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
  });
  res.end(payload);
}
