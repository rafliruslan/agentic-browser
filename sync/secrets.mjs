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
  return hits;
}
