---
name: channel
description: Read and act in the Slack conversation that started this task. Use for thread history, channel history, who is in a thread, looking up a user, posting or editing a message, adding a reaction, uploading a file, and following or unfollowing a thread. Use whenever the task refers to this thread, this channel, someone in it, or something said earlier.
---

# The Slack conversation you are in

The task reached you through Slack, and the bridge told you where you are in
the block above the request: the channel id, the thread ts, and how to attach a
file. Everything below acts in that conversation.

The bridge posts your reply for you. Use these when you need to read what came
before, or write something extra beyond the reply.

## Get a client

The Slack token is in the bridge env. Read it once, reuse the client.

```js
const token = (await fs.readFile(process.env.HOME + '/.config/agentic-browser/env', 'utf8'))
  .match(/^SLACK_BOT_TOKEN=(.+)$/m)[1].trim();
const api = async (method, body) => {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
};
```

## Read

```js
await api('conversations.replies', { channel, ts: threadTs, limit: 50 });   // this thread
await api('conversations.history', { channel, limit: 50 });                 // the channel
await api('conversations.info',    { channel });                            // name, privacy, membership
await api('users.info',            { user: 'U01EXAMPLE1' });                // display name, tz, admin
```

Participants are the distinct `user` values in `conversations.replies`. There is
no separate endpoint for that.

## Write

```js
await api('chat.postMessage', { channel, thread_ts: threadTs, text: 'extra note' });
await api('chat.update',      { channel, ts: messageTs, text: 'corrected' });
await api('chat.delete',      { channel, ts: messageTs });
await api('reactions.add',    { channel, timestamp: messageTs, name: 'white_check_mark' });
```

Reaction names are Slack shortcodes with no colons: `white_check_mark`, not
`:white_check_mark:`.

Only edit or delete messages the bot itself posted. Anything the user wrote is
theirs.

## Files

Never write a Markdown image tag. Slack cannot render it and it leaks a path
from this machine into the channel.

There is no `filesUploadV2` helper here; that is an SDK method and this is raw
HTTP. The real upload is three calls, and getting told "upload it" without them
is what sends people looking for a tool that does not exist.

```js
const bytes = await fs.readFile(path);
const { upload_url, file_id } = await api('files.getUploadURLExternal', null, {
  filename: 'chart.png', length: bytes.length,
});                                    // form-encoded, not JSON: see below
await fetch(upload_url, { method: 'POST', body: bytes });
await api('files.completeUploadExternal', {
  files: [{ id: file_id, title: 'chart.png' }],
  channel_id: channel,
  thread_ts: threadTs,                 // omit this and it lands at the top of
});                                    // the channel instead of in your thread
```

`files.getUploadURLExternal` takes form encoding, not JSON, so it does not go
through the `api` helper above:

```js
const form = async (method, params) => {
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` },
    body: new URLSearchParams(params),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
};
```

This needs the `files:write` scope. If it is missing the call fails with
`missing_scope`, and the honest move is to say so rather than to describe the
file in words and let it read as though you attached it.

## Following a thread

After you answer in a thread, the bridge follows it, so the user's next reply
reaches you without an @mention. It stops following after a day of silence, or
immediately if the user says `stop`, `quiet` or `stand down`.

You do not need to manage this. It matters only because it explains why a bare
reply can arrive as a task: you are already in that conversation.

## Two identities, one thread

Your reply is posted by the bot and shows as an app. Anything you do through
the browser is done as the operator and carries no bot label.

So a message you send through the browser will not appear in the bot's own
history, and querying with the bot token returns nothing. That is the wrong
observer, not a failed send. Check what you actually did before concluding it
did not happen.

## Say it once

Your reply already lands in this thread. Do not also post the same content
here as him. If the thread needs a message in his voice because teammates are
in it, post that one and keep your reply to a line pointing at it.
