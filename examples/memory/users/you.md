# You: voice, and writing as you

> Example file. Replace with your own preferences.

Two different things live here. Keep them apart, because conflating them is the
commonest way this file goes wrong.

- **Talking TO you** is the persona (`~/.config/agentic-browser/persona.md`). The
  bridge normalises that text on the way out, so mrkdwn syntax rules do not
  belong there.
- **Writing AS you** is this file. Nothing normalises that. Every rule below has
  to be applied by the agent, correctly, on the first attempt, because a message
  sent in your name cannot be un-sent.

## Absolute, in anything written

- **Never an em dash.** Scan before sending, including inside HTML comments and
  generated copy.
- Never mention the agent, Claude, or AI assistance in anything produced for you.
- Pick your own bans and put them here. They only work if they are specific: "be
  professional" is not actionable, "never use the folded-hands emoji" is.

## Your channel-post style

Describe it concretely enough that someone could imitate you. For example:

Casual. Code-switches between languages freely. Short and punchy. When sharing a
link, the bare URL first, then a blank line, then one short sentence on why it
matters, often ending by tagging a person or a subteam. No bullet lists in casual
shares, just short paragraphs.

Vague self-description produces vague imitation. If you cannot write this from
memory, paste three of your own messages and describe what they have in common.

## Structure for a substantive message

1. **Lead with the answer in ONE line** that stands alone if they read nothing
   else.
2. **Blank line**, then bullets. Never three dense paragraphs.
3. **Five bullets maximum**, one fact each, under about fifteen words.
4. **Start each bullet with a bold scan label**: `*Sale:* ...`
5. **Blank line between groups.** White space is what makes it readable on a
   phone.

These came from a real correction: an earlier version capped length without
imposing structure, and produced dense prose that was harder to read than a list.
Length rules alone make things worse.

## Slack syntax when posting as you

- Bold is `*one asterisk*`. `**two**` renders as literal asterisks.
- Italic is `_underscores_`. Backticks for emails, ids, codes, order numbers.
- **No headings, no tables.** Neither renders in Slack.
- A record per line is a spreadsheet, not a message. Long data goes somewhere
  scrollable and you send the link.
- **Prefer native `rich_text` blocks over typed symbols** when sending through
  the API. Slack mrkdwn has no list syntax, so a typed `•` is just a character
  with no hanging indent and no wrapping.
- Inside `rich_text`, use literal `&`, `<`, `>`. Inside mrkdwn, escape them.
  Same characters, opposite rules, depending on field.
- **Never a Markdown image tag.** Slack cannot render it and it leaks a local
  disk path to the channel. Upload the file instead.

## What you expect

- Whether "summarise my inbox" means the first page or a complete walkthrough.
  Say which; the agent will otherwise pick the cheap one.
- Whether you check first-hand versus secondhand research. If you do, say so and
  the agent will state its provenance unprompted.
- Whether recommendations need their reasoning attached. "Brevity is not licence
  to drop the why" is a useful line if that is true for you.
