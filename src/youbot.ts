/**
 * you.bot API client for GPT Image 2.5.
 *
 * Deliberately free of any MCP imports so it can be unit-tested on its own
 * with an injected fetch.
 */

export const SIGNUP_URL = "https://you.bot";
export const KEYS_URL = "https://you.bot/dashboard/api-keys";
export const MODEL_PAGE_URL =
  "https://you.bot/models/gpt-image-2-5-sunburst-text-to-image";
export const API_BASE = "https://you.bot/api/v1";

export const MODEL_TEXT_TO_IMAGE = "gpt-image-2-5-sunburst-text-to-image";
export const MODEL_IMAGE_TO_IMAGE = "gpt-image-2-5-sunburst-image-to-image";

/** Every request from this server is locked to 1K, which costs 2.9 credits. */
export const RESOLUTION = "1K";
export const CREDITS_PER_IMAGE = 2.9;
export const USD_PER_CREDIT = 0.01;
export const FREE_CREDITS_ON_SIGNUP = 50;

export const ASPECT_RATIOS = [
  "1:1",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "2:1",
  "1:2",
  "21:9",
] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** Images you can still make with a given credit balance. */
export function imagesAffordable(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  return Math.floor(credits / CREDITS_PER_IMAGE);
}

export function usd(credits: number): string {
  return `$${(credits * USD_PER_CREDIT).toFixed(3).replace(/0$/, "")}`;
}

// ---------------------------------------------------------------------------
// API key handling
//
// This is the part that stops the single most likely support question:
// "I pasted my OpenAI key and it doesn't work."
// ---------------------------------------------------------------------------

export type KeyVerdict = "ok" | "missing" | "looks_like_openai" | "unrecognised";

export function classifyApiKey(raw: string | undefined | null): KeyVerdict {
  const key = (raw ?? "").trim();
  if (key === "") return "missing";
  if (key.startsWith("sk-live-")) return "ok";
  // OpenAI's own formats: sk-proj-…, sk-svcacct-…, sk-admin-… and the classic sk-…
  if (/^sk-(proj|svcacct|admin|None)-/.test(key)) return "looks_like_openai";
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) return "looks_like_openai";
  return "unrecognised";
}

const SIGNUP_STEPS = [
  `1. Open ${SIGNUP_URL} and create a free account (no credit card).`,
  `2. New accounts get ${FREE_CREDITS_ON_SIGNUP} free credits — that is about ${imagesAffordable(
    FREE_CREDITS_ON_SIGNUP,
  )} images at ${usd(CREDITS_PER_IMAGE)} each, so you can start immediately.`,
  `3. Go to ${KEYS_URL}, create a key (it begins with "sk-live-") and copy it.`,
  `4. Put it in this server's MCP config as the environment variable YOUBOT_API_KEY, then restart your MCP client.`,
].join("\n");

export function keyProblemMessage(verdict: KeyVerdict): string | null {
  switch (verdict) {
    case "ok":
      return null;
    case "missing":
      return [
        "No API key found. This server needs a you.bot API key in YOUBOT_API_KEY.",
        "",
        "⚠️ The key comes from you.bot — NOT from OpenAI. An OpenAI key will not work here,",
        "and you do not need an OpenAI account at all.",
        "",
        SIGNUP_STEPS,
      ].join("\n");
    case "looks_like_openai":
      return [
        "That key looks like an OpenAI API key, and OpenAI keys do not work with this server.",
        "",
        `This server reaches GPT Image 2.5 through you.bot, so it needs a you.bot key — they start with "sk-live-".`,
        "",
        SIGNUP_STEPS,
      ].join("\n");
    case "unrecognised":
      return [
        `YOUBOT_API_KEY does not look like a you.bot key. you.bot keys start with "sk-live-".`,
        "",
        "Check you copied the whole key, and that you took it from you.bot rather than another provider.",
        "",
        SIGNUP_STEPS,
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class YouBotError extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "YouBotError";
    this.status = status;
    this.retryable = retryable;
  }
}

export function errorForStatus(status: number, body: string): YouBotError {
  const detail = body ? ` — ${body.slice(0, 300)}` : "";
  switch (status) {
    case 400:
      return new YouBotError(`Invalid request${detail}`, 400);
    case 401:
      return new YouBotError(
        [
          "you.bot rejected the API key (401).",
          "",
          `If you pasted an OpenAI key, that is the problem — this server needs a you.bot key from ${KEYS_URL} (it starts with "sk-live-").`,
          "Otherwise the key may have been revoked or mistyped.",
        ].join("\n"),
        401,
      );
    case 402:
      return new YouBotError(
        [
          "Out of credits (402).",
          "",
          `Each image costs ${CREDITS_PER_IMAGE} credits (${usd(CREDITS_PER_IMAGE)}). Top up at ${SIGNUP_URL} — credits never expire.`,
        ].join("\n"),
        402,
      );
    case 403:
      return new YouBotError(
        `This key is not allowed to make this request (403). Check the key's IP allow-list and model restrictions in the you.bot dashboard.${detail}`,
        403,
      );
    case 404:
      return new YouBotError(`Not found or expired (404)${detail}`, 404);
    case 409:
      // Nothing was charged, so retrying is free.
      return new YouBotError(
        "Duplicate request (409) — an identical request arrived moments ago. Nothing was charged; retrying is safe.",
        409,
        true,
      );
    case 413:
      return new YouBotError(
        `Request too large (413). Shorten the prompt or use a smaller source image.${detail}`,
        413,
      );
    case 422:
      return new YouBotError(`Request rejected (422)${detail}`, 422);
    case 429:
      return new YouBotError(
        "Rate limited (429) — you.bot allows 60 new generations per minute. Wait a moment and retry.",
        429,
        true,
      );
    default:
      if (status >= 500) {
        return new YouBotError(
          `you.bot returned ${status}. Nothing was delivered, so retrying is safe.${detail}`,
          status,
          true,
        );
      }
      return new YouBotError(`Unexpected response ${status}${detail}`, status);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Give up on a task after this long. Images normally land in 10–40s. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
}

export interface GenerateResult {
  imageUrl: string;
  taskId: string;
  creditsCharged: number;
  elapsedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class YouBotImageClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = opts.sleep ?? defaultSleep;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "youbot-image-mcp",
    };
  }

  async credits(): Promise<number> {
    const res = await this.fetchImpl(`${API_BASE}/credits`, {
      method: "GET",
      headers: this.headers(),
    });
    const body = await res.text();
    if (!res.ok) throw errorForStatus(res.status, body);
    const parsed = JSON.parse(body) as { credits?: number; balance?: number };
    const value = parsed.credits ?? parsed.balance;
    if (typeof value !== "number") {
      throw new YouBotError("Could not read the credit balance from you.bot's reply.");
    }
    return value;
  }

  /** Create a generation task and wait for the finished image. */
  async generate(args: {
    prompt: string;
    aspectRatio: AspectRatio;
    imageUrl?: string;
  }): Promise<GenerateResult> {
    const startedAt = this.now();
    const modelId = args.imageUrl ? MODEL_IMAGE_TO_IMAGE : MODEL_TEXT_TO_IMAGE;

    const input: Record<string, string> = {
      prompt: args.prompt,
      aspect_ratio: args.aspectRatio,
      resolution: RESOLUTION,
    };
    if (args.imageUrl) input.input_urls = args.imageUrl;

    const createRes = await this.fetchImpl(`${API_BASE}/generate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ modelId, input }),
    });
    const createBody = await createRes.text();
    if (!createRes.ok) throw errorForStatus(createRes.status, createBody);

    const created = JSON.parse(createBody) as {
      taskId?: string;
      creditsCharged?: number;
    };
    if (!created.taskId) {
      throw new YouBotError("you.bot accepted the request but returned no taskId.");
    }

    const imageUrl = await this.waitForImage(created.taskId, modelId, startedAt);
    return {
      imageUrl,
      taskId: created.taskId,
      creditsCharged: created.creditsCharged ?? CREDITS_PER_IMAGE,
      elapsedMs: this.now() - startedAt,
    };
  }

  private async waitForImage(
    taskId: string,
    modelId: string,
    startedAt: number,
  ): Promise<string> {
    const url = `${API_BASE}/task/${encodeURIComponent(taskId)}?model=${encodeURIComponent(modelId)}`;

    for (;;) {
      if (this.now() - startedAt > this.timeoutMs) {
        throw new YouBotError(
          `The image was still rendering after ${Math.round(this.timeoutMs / 1000)}s. ` +
            `It may still finish — check task ${taskId} in the you.bot dashboard.`,
        );
      }

      await this.sleep(this.pollIntervalMs);

      const res = await this.fetchImpl(url, { method: "GET", headers: this.headers() });
      const body = await res.text();

      if (!res.ok) {
        const err = errorForStatus(res.status, body);
        // A transient blip mid-poll should not kill a task that is already paid for.
        if (err.retryable) continue;
        throw err;
      }

      const task = JSON.parse(body) as {
        state?: string;
        status?: string;
        resultUrls?: string[];
        failMsg?: string;
        error?: string;
      };
      // Polling replies use `state`; webhooks use `status`. Accept either.
      const state = task.state ?? task.status;

      if (state === "success") {
        const first = task.resultUrls?.[0];
        if (!first) {
          throw new YouBotError("you.bot reported success but returned no image URL.");
        }
        return first;
      }
      if (state === "fail") {
        const why = task.failMsg ?? task.error ?? "no reason given";
        throw new YouBotError(
          `Generation failed: ${why}. Failed generations are refunded automatically, so you have not been charged.`,
        );
      }
      // waiting | generating → keep polling
    }
  }

  /** Download a finished image so the MCP client can display it inline. */
  async download(
    imageUrl: string,
  ): Promise<{ base64: string; mimeType: string; bytes: number }> {
    const res = await this.fetchImpl(imageUrl, { method: "GET" });
    if (!res.ok) {
      throw new YouBotError(
        `The image was generated but could not be downloaded (${res.status}). The URL still works: ${imageUrl}`,
        res.status,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type")?.split(";")[0] ?? "image/png";
    return { base64: buf.toString("base64"), mimeType, bytes: buf.byteLength };
  }
}
