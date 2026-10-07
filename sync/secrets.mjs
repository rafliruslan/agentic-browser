/**
 * Refuse to commit anything shaped like a credential. Only lines a commit adds
 * are scanned, and a hit is reported by file and pattern name: the matched
 * text never reaches a log, a notification or the status file.
 */
export const PATTERNS = [
  ['slack-token', /\bxox[abposre]-[A-Za-z0-9-]{10,}/],
  ['slack-app-token', /\bxapp-\d-[A-Za-z0-9-]{10,}/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}/],
  ['linear-key', /\blin_(?:api|oauth)_[A-Za-z0-9]{30,}/],
  ['shopify-token', /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['stripe-key', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ['slack-webhook', /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  // A value after a secret-ish label, but only one that looks generated: long,
  // with both letters and digits, so prose after "token:" does not fire.
  ['assigned-secret', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?(?=[^\s"']*\d)(?=[^\s"']*[A-Za-z])[^\s"']{16,}/i],
];

export const scanText = (text) => PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);

/** Added lines per file. Headers are recognised only between `diff --git` and the first `@@`. */
export function addedLines(diff) {
  const out = new Map();
  let file = null;
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) { header = true; file = null; continue; }
    if (header) {
      if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(6);
      if (line.startsWith('@@')) header = false;
      continue;
    }
    if (file && line.startsWith('+')) out.set(file, `${out.get(file) ?? ''}${line.slice(1)}\n`);
  }
  return out;
}

export function findSecrets(diff) {
  const hits = [];
  for (const [file, text] of addedLines(diff)) {
    for (const pattern of scanText(text)) hits.push({ file, pattern });
  }
  // File names travel too, and a new empty file has no added lines at all.
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    for (const pattern of scanText(line)) hits.push({ file: 'a file name', pattern });
  }
  return hits;
}
