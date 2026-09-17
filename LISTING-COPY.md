# Standard listing copy — gpt-image-mcp

Reusable text for MCP directory submissions. Every claim here is verified against
the live you.bot model page and a real generation run on 17 Sep 2026.

**Rules followed:** no parent company named · no competitor named · no unverified
discount percentage (we state the absolute price, which is checkable, rather than
a "% cheaper" claim we cannot source for this specific model).

---

## Links

| Field | Value |
|---|---|
| Repository | https://github.com/youbotapi/gpt-image-mcp |
| npm | https://www.npmjs.com/package/gpt-image-2-5-mcp |
| Package name | `gpt-image-2-5-mcp` |
| Homepage | https://you.bot |
| Install | `npx -y gpt-image-2-5-mcp` |
| License | MIT |

## Title

**GPT Image 2.5 MCP Server**

Alternate, if the field is short: `GPT Image 2.5 MCP`

## Tagline (under 80 chars)

> Generate images with GPT Image 2.5 for $0.029 — 50 free credits, no card.

## Short description (under 160 chars)

> Generate and edit images with GPT Image 2.5 inside Claude, Cursor or any MCP client. $0.029 per image. Free key with 50 credits — about 17 images, no card.

## Medium description (under 350 chars)

> Bring GPT Image 2.5, OpenAI's most capable image model, into any MCP client for **$0.029 per image** at 1024px. Signing up is free and gives you **50 credits — roughly 17 images — with no credit card**, so it works the moment you paste the key in. Three tools: generate an image, edit an existing one, check your balance.

## Long description

Generate and edit images with **GPT Image 2.5** directly inside Claude, Cursor, or any
MCP client — **$0.029 per image**, flat, at 1024px.

**Free to start.** Creating a you.bot account takes a couple of minutes, needs no credit
card, and comes with **50 credits — about 17 images**. That is enough to use this server
properly before deciding whether to spend anything. Credits never expire, failed
generations are refunded automatically, and there is no subscription.

**Why people use it:** GPT Image 2.5 is unusually good at rendering readable text inside
an image — signs, posters, labels, UI mockups — which most image models still get wrong.
At under three cents a shot you can iterate on a prompt instead of rationing attempts.

**Tools**

- `generate_image` — make an image from a text prompt (2.9 credits, $0.029)
- `edit_image` — change an existing image from a public URL: swap a background, add or
  remove objects, restyle, while keeping the rest (2.9 credits, $0.029)
- `check_credits` — show the remaining balance and how many images it buys (free)

**One thing to know:** the API key comes from **you.bot**, not from OpenAI. The server
says so up front, and if an OpenAI key is pasted by mistake it names that as the problem
rather than failing with a confusing 401.

Published from CI with provenance attestation. MIT licensed.

## Setup snippet

```json
{
  "mcpServers": {
    "gpt-image": {
      "command": "npx",
      "args": ["-y", "gpt-image-2-5-mcp"],
      "env": { "YOUBOT_API_KEY": "sk-live-your-key-from-you.bot" }
    }
  }
}
```

## Tags / categories

`image-generation` `text-to-image` `image-editing` `gpt-image` `openai` `ai` `claude`
`cursor` `mcp-server` `model-context-protocol` `creative` `media`

## Facts, with sources

| Claim | Source |
|---|---|
| $0.029 per image at 1K | you.bot model page, 2.9 credits × $0.01, re-read 17 Sep 2026 |
| 50 free credits on signup, no card | you.bot signup, verified 17 Sep 2026 |
| ≈ 17 images free | 50 ÷ 2.9 = 17.2 |
| Credits never expire · failed generations refunded | you.bot docs |
| Renders text inside images accurately | our own test run: requested sign text came out exactly |
| 30–60 s per image | measured: 44.7 s on a 16:9 1K generation |
