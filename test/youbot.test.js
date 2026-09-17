import test from "node:test";
import assert from "node:assert/strict";

import {
  ASPECT_RATIOS,
  CREDITS_PER_IMAGE,
  MODEL_IMAGE_TO_IMAGE,
  MODEL_TEXT_TO_IMAGE,
  YouBotError,
  YouBotImageClient,
  classifyApiKey,
  errorForStatus,
  imagesAffordable,
  keyProblemMessage,
  usd,
} from "../dist/youbot.js";

// --- helpers ---------------------------------------------------------------

function res(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    arrayBuffer: async () => new TextEncoder().encode(String(body)).buffer,
  };
}

/** Queue of responses; records every call for assertions. */
function fakeFetch(queue) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`Unexpected extra request to ${url}`);
    return typeof next === "function" ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

const noSleep = async () => {};

function client(queue, extra = {}) {
  return new YouBotImageClient({
    apiKey: "sk-live-test",
    fetchImpl: fakeFetch(queue),
    sleep: noSleep,
    pollIntervalMs: 0,
    ...extra,
  });
}

// --- key classification ----------------------------------------------------

test("a you.bot key is accepted", () => {
  assert.equal(classifyApiKey("sk-live-abc123"), "ok");
  assert.equal(classifyApiKey("  sk-live-abc123  "), "ok");
  assert.equal(keyProblemMessage("ok"), null);
});

test("a missing key produces signup instructions naming you.bot", () => {
  assert.equal(classifyApiKey(undefined), "missing");
  assert.equal(classifyApiKey(""), "missing");
  const msg = keyProblemMessage("missing");
  assert.match(msg, /you\.bot/);
  assert.match(msg, /NOT from OpenAI/);
  assert.match(msg, /50 free credits/);
  assert.match(msg, /YOUBOT_API_KEY/);
});

test("OpenAI key formats are named as the mistake, not just rejected", () => {
  for (const key of [
    "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA",
    "sk-svcacct-BBBBBBBBBBBBBBBBBBBB",
    "sk-admin-CCCCCCCCCCCCCCCCCCCC",
    "sk-abcdefghijklmnopqrstuvwxyz1234",
  ]) {
    assert.equal(classifyApiKey(key), "looks_like_openai", key);
  }
  const msg = keyProblemMessage("looks_like_openai");
  assert.match(msg, /looks like an OpenAI API key/);
  assert.match(msg, /sk-live-/);
});

test("an unrecognised key still points at you.bot", () => {
  assert.equal(classifyApiKey("hunter2"), "unrecognised");
  assert.match(keyProblemMessage("unrecognised"), /you\.bot keys start with "sk-live-"/);
});

// --- money -----------------------------------------------------------------

test("50 free credits buys 17 images", () => {
  assert.equal(imagesAffordable(50), 17);
  assert.equal(imagesAffordable(CREDITS_PER_IMAGE), 1);
  assert.equal(imagesAffordable(2), 0);
  assert.equal(imagesAffordable(0), 0);
  assert.equal(imagesAffordable(-5), 0);
});

test("an image is priced at $0.029", () => {
  assert.equal(usd(CREDITS_PER_IMAGE), "$0.029");
});

// --- error mapping ---------------------------------------------------------

test("401 suggests the OpenAI-key mix-up", () => {
  const err = errorForStatus(401, "");
  assert.match(err.message, /OpenAI key/);
  assert.match(err.message, /sk-live-/);
  assert.equal(err.retryable, false);
});

test("402 explains the per-image cost and where to top up", () => {
  const err = errorForStatus(402, "");
  assert.match(err.message, /Out of credits/);
  assert.match(err.message, /\$0\.029/);
});

test("409, 429 and 5xx are marked retryable; 400 is not", () => {
  assert.equal(errorForStatus(409, "").retryable, true);
  assert.equal(errorForStatus(429, "").retryable, true);
  assert.equal(errorForStatus(500, "").retryable, true);
  assert.equal(errorForStatus(503, "").retryable, true);
  assert.equal(errorForStatus(400, "").retryable, false);
});

test("409 states that nothing was charged", () => {
  assert.match(errorForStatus(409, "").message, /Nothing was charged/);
});

// --- generation ------------------------------------------------------------

test("text-to-image posts the right model, locks 1K, and polls to success", async () => {
  const fetchImpl = fakeFetch([
    res(200, { taskId: "t1", creditsCharged: 2.9 }),
    res(200, { state: "waiting" }),
    res(200, { state: "generating" }),
    res(200, { state: "success", resultUrls: ["https://cdn.you.bot/a.png"] }),
  ]);
  const c = new YouBotImageClient({
    apiKey: "sk-live-x",
    fetchImpl,
    sleep: noSleep,
    pollIntervalMs: 0,
  });

  const out = await c.generate({ prompt: "a red fox", aspectRatio: "16:9" });
  assert.equal(out.imageUrl, "https://cdn.you.bot/a.png");
  assert.equal(out.taskId, "t1");
  assert.equal(out.creditsCharged, 2.9);

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.modelId, MODEL_TEXT_TO_IMAGE);
  assert.equal(body.input.resolution, "1K");
  assert.equal(body.input.aspect_ratio, "16:9");
  assert.equal(body.input.prompt, "a red fox");
  assert.equal(body.input.input_urls, undefined);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer sk-live-x");

  // Poll URL must carry the model, or you.bot cannot find the task.
  assert.match(fetchImpl.calls[1].url, /\/task\/t1\?model=gpt-image-2-5-sunburst-text-to-image/);
});

test("supplying an image URL switches to the image-to-image model", async () => {
  const fetchImpl = fakeFetch([
    res(200, { taskId: "t2", creditsCharged: 2.9 }),
    res(200, { state: "success", resultUrls: ["https://cdn.you.bot/b.png"] }),
  ]);
  const c = new YouBotImageClient({
    apiKey: "sk-live-x",
    fetchImpl,
    sleep: noSleep,
    pollIntervalMs: 0,
  });

  await c.generate({
    prompt: "make it snowy",
    aspectRatio: "1:1",
    imageUrl: "https://example.com/in.png",
  });

  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.modelId, MODEL_IMAGE_TO_IMAGE);
  assert.equal(body.input.input_urls, "https://example.com/in.png");
});

test("webhook-style `status` is understood as well as `state`", async () => {
  const c = client([
    res(200, { taskId: "t3" }),
    res(200, { status: "success", resultUrls: ["https://cdn.you.bot/c.png"] }),
  ]);
  const out = await c.generate({ prompt: "x", aspectRatio: "1:1" });
  assert.equal(out.imageUrl, "https://cdn.you.bot/c.png");
});

test("a failed generation says the credits come back", async () => {
  const c = client([
    res(200, { taskId: "t4" }),
    res(200, { state: "fail", failMsg: "content filtered" }),
  ]);
  await assert.rejects(
    () => c.generate({ prompt: "x", aspectRatio: "1:1" }),
    (err) => {
      assert.ok(err instanceof YouBotError);
      assert.match(err.message, /content filtered/);
      assert.match(err.message, /refunded/);
      return true;
    },
  );
});

test("a transient 500 mid-poll does not abandon a paid task", async () => {
  const c = client([
    res(200, { taskId: "t5" }),
    res(500, "boom"),
    res(200, { state: "success", resultUrls: ["https://cdn.you.bot/d.png"] }),
  ]);
  const out = await c.generate({ prompt: "x", aspectRatio: "1:1" });
  assert.equal(out.imageUrl, "https://cdn.you.bot/d.png");
});

test("a 401 on create is surfaced, not retried", async () => {
  const c = client([res(401, "unauthorized")]);
  await assert.rejects(
    () => c.generate({ prompt: "x", aspectRatio: "1:1" }),
    /OpenAI key/,
  );
});

test("polling gives up once the timeout passes and names the task", async () => {
  let t = 0;
  const c = new YouBotImageClient({
    apiKey: "sk-live-x",
    fetchImpl: fakeFetch([
      res(200, { taskId: "t6" }),
      () => {
        t += 999_999;
        return res(200, { state: "generating" });
      },
    ]),
    sleep: noSleep,
    pollIntervalMs: 0,
    timeoutMs: 1000,
    now: () => t,
  });
  await assert.rejects(() => c.generate({ prompt: "x", aspectRatio: "1:1" }), /t6/);
});

test("success without a result URL is treated as an error, not an empty image", async () => {
  const c = client([res(200, { taskId: "t7" }), res(200, { state: "success", resultUrls: [] })]);
  await assert.rejects(() => c.generate({ prompt: "x", aspectRatio: "1:1" }), /no image URL/);
});

// --- credits ---------------------------------------------------------------

test("credits() reads the balance", async () => {
  const c = client([res(200, { credits: 47.1 })]);
  assert.equal(await c.credits(), 47.1);
});

test("credits() reports a 402 in plain language", async () => {
  const c = client([res(402, "")]);
  await assert.rejects(() => c.credits(), /Out of credits/);
});

// --- download --------------------------------------------------------------

test("download returns base64 plus the real mime type", async () => {
  const c = client([res(200, "PNGDATA", { "content-type": "image/png; charset=binary" })]);
  const file = await c.download("https://cdn.you.bot/a.png");
  assert.equal(Buffer.from(file.base64, "base64").toString(), "PNGDATA");
  assert.equal(file.mimeType, "image/png");
  assert.equal(file.bytes, 7);
});

test("a failed download still hands back the working URL", async () => {
  const c = client([res(404, "")]);
  await assert.rejects(
    () => c.download("https://cdn.you.bot/gone.png"),
    /https:\/\/cdn\.you\.bot\/gone\.png/,
  );
});

// --- schema ----------------------------------------------------------------

test("the aspect ratios match the ones you.bot documents", () => {
  assert.deepEqual([...ASPECT_RATIOS], [
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
  ]);
});
