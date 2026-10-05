# Linear agent relay

Lets an agent answer when it is mentioned in, or assigned, a Linear issue.

```
Linear --webhook--> Worker /hook/<agent>      verify, gate, queue, ack
bridge --poll-----> Worker /pull/<agent>      oldest queued event
bridge --reply----> Worker /activity/<agent>  write to the Linear session
```

Linear needs a public URL. The bridges only call out, so the Worker is the only
public piece and nothing on the Mac listens.

## What it refuses

- A webhook with a bad `Linear-Signature` (HMAC-SHA256 of the raw body) or a
  `webhookTimestamp` more than a minute off.
- Any event whose author is not `ALLOWED_LINEAR_USER`. A follow-up prompt is
  judged by its own author, and one with no author is refused.
- `/pull` and `/activity` without that agent's `PULL_TOKEN_<AGENT>`.

An event is handed over once and deleted first, so a crashed bridge loses it
rather than replaying an action in a logged-in browser. Events expire after an hour.

## Set up (per agent: `hammock`, `tara`)

1. Linear → Settings → API → the agent's OAuth app: turn on **Client credentials**
   and **Webhooks**. Webhook URL `https://<worker>/hook/<agent>`, category
   **Agent session events**. Copy the signing secret Linear shows.
2. `wrangler kv namespace create QUEUE`, put the id in `wrangler.toml`, and set
   `ALLOWED_LINEAR_USER` to the operator's Linear user id.
3. `wrangler secret put` for each of `WEBHOOK_SECRET_<A>`, `PULL_TOKEN_<A>`,
   `CLIENT_ID_<A>`, `CLIENT_SECRET_<A>` (A is `HAMMOCK` or `TARA`).
4. `wrangler deploy`.
5. In the agent's bridge env: `LINEAR_RELAY_URL`, `LINEAR_RELAY_TOKEN` (the same
   `PULL_TOKEN`) and `LINEAR_AGENT`. Restart the bridge.

## Not verified against live Linear

The payload shape and the `client_credentials` app token come from Linear's docs,
not from a live run. Check `wrangler tail` on the first mention. In particular the
author field on a `prompted` event: the relay reads `agentActivity.userId` and
refuses the event when it is absent.

`node --test` runs the tests with no network.
