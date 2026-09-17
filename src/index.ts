#!/usr/bin/env node
/**
 * youbot-image-mcp — GPT Image 2.5 for any MCP client.
 *
 * Every user-visible string in this file is written on the assumption that the
 * reader's first guess will be "I need an OpenAI key". They do not.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import {
  ASPECT_RATIOS,
  CREDITS_PER_IMAGE,
  FREE_CREDITS_ON_SIGNUP,
  KEYS_URL,
  RESOLUTION,
  SIGNUP_URL,
  YouBotError,
  YouBotImageClient,
  classifyApiKey,
  imagesAffordable,
  keyProblemMessage,
  usd,
  type AspectRatio,
} from "./youbot.js";

// Read from package.json rather than repeating the number here — two copies
// drift the moment one of them is bumped and the other is forgotten.
const VERSION: string = createRequire(import.meta.url)("../package.json").version;

/** Images larger than this are linked rather than inlined, to protect the context window. */
const MAX_INLINE_BYTES = 5 * 1024 * 1024;

function env(name: string): string | undefined {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return holder.process?.env?.[name];
}

// ---------------------------------------------------------------------------
// Layer 1: server instructions.
//
// The MCP client hands this to the model before it ever calls a tool, so the
// model can answer "how do I set this up?" correctly without guessing.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `This server generates and edits images with GPT Image 2.5, OpenAI's most capable image model, at ${usd(
  CREDITS_PER_IMAGE,
)} per image (1024px).

IMPORTANT — where the API key comes from:
The model is reached through you.bot, an API gateway. The user needs a you.bot API key, NOT an OpenAI API key. An OpenAI key will not work here and no OpenAI account is needed.

If the user has not set one up, walk them through this:
  1. Sign up free at ${SIGNUP_URL} — no credit card required.
  2. They get ${FREE_CREDITS_ON_SIGNUP} free credits on signup, which is about ${imagesAffordable(
    FREE_CREDITS_ON_SIGNUP,
  )} images — enough to use this immediately without paying.
  3. Create a key at ${KEYS_URL}. you.bot keys begin with "sk-live-".
  4. Add it to this server's MCP config as the environment variable YOUBOT_API_KEY, then restart the client.

Cost awareness: every generate_image or edit_image call spends ${CREDITS_PER_IMAGE} credits (${usd(
  CREDITS_PER_IMAGE,
)}) of the user's balance. Do not generate batches of images without being asked. Failed generations are refunded automatically. Use check_credits to report the remaining balance.

Prompting: GPT Image 2.5 follows long, specific prompts well. Describe subject, setting, lighting, composition and style rather than listing keywords. It also renders text inside images accurately, so quote any wanted text exactly.`;

const KEY_NOTE =
  `Requires a you.bot API key in YOUBOT_API_KEY — NOT an OpenAI key. Free key with ${FREE_CREDITS_ON_SIGNUP} starting credits (~${imagesAffordable(
    FREE_CREDITS_ON_SIGNUP,
  )} images) at ${SIGNUP_URL}.`;

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "generate_image",
    description:
      `Generate an image from a text prompt using GPT Image 2.5 (OpenAI's most capable image model) at ${usd(
        CREDITS_PER_IMAGE,
      )} per image, 1024px. Good at photorealism, illustration, and rendering readable text inside the image. Costs ${CREDITS_PER_IMAGE} credits per call. ` +
      KEY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "What to draw. Long, specific descriptions work best — subject, setting, lighting, composition, style. To put words in the image, quote them exactly.",
        },
        aspect_ratio: {
          type: "string",
          enum: [...ASPECT_RATIOS],
          default: "1:1",
          description: "Shape of the image. Defaults to 1:1 (square).",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description:
      `Edit an existing image with GPT Image 2.5 — change, add, remove or restyle parts of it while keeping the rest. Takes a publicly reachable image URL and a description of the change. ${usd(
        CREDITS_PER_IMAGE,
      )} per edit (${CREDITS_PER_IMAGE} credits), 1024px output. ` + KEY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: "string",
          description:
            "Public https URL of the source image. Local file paths do not work — the image must be reachable from the internet.",
        },
        prompt: {
          type: "string",
          description:
            "The change to make, e.g. 'replace the background with a snowy forest, keep the subject and lighting unchanged'.",
        },
        aspect_ratio: {
          type: "string",
          enum: [...ASPECT_RATIOS],
          default: "1:1",
          description: "Shape of the output image. Defaults to 1:1 (square).",
        },
      },
      required: ["image_url", "prompt"],
    },
  },
  {
    name: "check_credits",
    description:
      `Check the remaining you.bot credit balance and how many more images it buys. Free and instant — does not generate anything. ` +
      KEY_NOTE,
    inputSchema: { type: "object", properties: {} },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function getClient(): YouBotImageClient | { error: string } {
  const key = env("YOUBOT_API_KEY");
  const problem = keyProblemMessage(classifyApiKey(key));
  if (problem) return { error: problem };
  return new YouBotImageClient({ apiKey: (key as string).trim() });
}

async function maybeSaveLocally(
  base64: string,
  mimeType: string,
): Promise<string | null> {
  const dir = env("YOUBOT_IMAGE_DIR");
  if (!dir) return null;
  try {
    const ext = mimeType.includes("jpeg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
    const target = resolve(dir);
    await mkdir(target, { recursive: true });
    const path = join(target, `gpt-image-2-5-${Date.now()}.${ext}`);
    await writeFile(path, Buffer.from(base64, "base64"));
    return path;
  } catch {
    return null; // Saving is a convenience; never fail a paid generation over it.
  }
}

async function runGeneration(
  client: YouBotImageClient,
  args: { prompt: string; aspectRatio: AspectRatio; imageUrl?: string },
) {
  const result = await client.generate(args);
  const content: Content[] = [];

  let savedTo: string | null = null;
  let downloadNote = "";
  try {
    const file = await client.download(result.imageUrl);
    if (file.bytes <= MAX_INLINE_BYTES) {
      content.push({ type: "image", data: file.base64, mimeType: file.mimeType });
    } else {
      downloadNote = "\n(Image too large to show inline — open the URL above.)";
    }
    savedTo = await maybeSaveLocally(file.base64, file.mimeType);
  } catch {
    downloadNote = "\n(Could not inline the image — open the URL above.)";
  }

  const lines = [
    `Image ready in ${(result.elapsedMs / 1000).toFixed(1)}s.`,
    `URL: ${result.imageUrl}`,
    savedTo ? `Saved to: ${savedTo}` : null,
    `Cost: ${result.creditsCharged} credits (${usd(result.creditsCharged)}) · GPT Image 2.5 at ${RESOLUTION} via you.bot`,
  ].filter(Boolean) as string[];

  content.push({ type: "text", text: lines.join("\n") + downloadNote });
  return { content };
}

const server = new Server(
  { name: "youbot-image-mcp", version: VERSION },
  { capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "setup",
      description:
        "Walk me through setting up this server, including where to get the API key (you.bot, not OpenAI).",
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "setup") {
    throw new Error(`Unknown prompt: ${request.params.name}`);
  }
  const verdict = classifyApiKey(env("YOUBOT_API_KEY"));
  const state =
    verdict === "ok"
      ? "A valid-looking you.bot key is already configured, so check_credits should work — try it."
      : keyProblemMessage(verdict);

  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me set up the GPT Image 2.5 MCP server.\n\nCurrent state:\n${state}\n\nPlease tell me, in order: where the API key comes from, what it costs, and exactly what to paste into my MCP config.`,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as Record<string, unknown>;

  const client = getClient();
  if ("error" in client) return fail(client.error);

  try {
    switch (name) {
      case "check_credits": {
        const credits = await client.credits();
        const n = imagesAffordable(credits);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `you.bot balance: ${credits} credits (${usd(credits)}).\n` +
                `That is ${n} more image${n === 1 ? "" : "s"} at ${CREDITS_PER_IMAGE} credits (${usd(
                  CREDITS_PER_IMAGE,
                )}) each.` +
                (n === 0 ? `\n\nTop up at ${SIGNUP_URL} — credits never expire.` : ""),
            },
          ],
        };
      }

      case "generate_image": {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        if (!prompt) return fail("A prompt is required — describe the image you want.");
        return await runGeneration(client, {
          prompt,
          aspectRatio: resolveAspect(args.aspect_ratio),
        });
      }

      case "edit_image": {
        const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
        const imageUrl = typeof args.image_url === "string" ? args.image_url.trim() : "";
        if (!imageUrl) return fail("A public https URL for the source image is required.");
        if (!/^https?:\/\//i.test(imageUrl)) {
          return fail(
            "image_url must be a public http(s) URL. A local file path will not work — upload the image somewhere reachable first.",
          );
        }
        if (!prompt) return fail("Describe the edit you want to make.");
        return await runGeneration(client, {
          prompt,
          aspectRatio: resolveAspect(args.aspect_ratio),
          imageUrl,
        });
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof YouBotError) return fail(err.message);
    return fail(`Unexpected error: ${(err as Error).message}`);
  }
});

function resolveAspect(value: unknown): AspectRatio {
  const wanted = typeof value === "string" ? value : "1:1";
  return (ASPECT_RATIOS as readonly string[]).includes(wanted)
    ? (wanted as AspectRatio)
    : "1:1";
}

async function main() {
  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel, so anything human-readable goes to stderr.
  console.error(
    `youbot-image-mcp ${VERSION} ready — GPT Image 2.5 at ${usd(CREDITS_PER_IMAGE)}/image. ` +
      `Key source: you.bot (not OpenAI).`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  (globalThis as { process?: { exit(code: number): void } }).process?.exit(1);
});
