/**
 * End-to-end check: drive the built server over real stdio JSON-RPC,
 * exactly the way Claude Desktop does.
 *
 *   node test/stdio-check.mjs
 */
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

function session(env) {
  const child = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, YOUBOT_API_KEY: undefined, ...env },
  });
  const pending = new Map();
  let buf = "";

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const notify = (method, params = {}) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

  return { child, send, notify, close: () => child.kill() };
}

async function handshake(s) {
  const init = await s.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "stdio-check", version: "1.0.0" },
  });
  s.notify("notifications/initialized");
  return init;
}

const checks = [];
function check(label, fn) {
  try {
    fn();
    checks.push(`  ok   ${label}`);
  } catch (err) {
    checks.push(`  FAIL ${label}\n       ${err.message}`);
    process.exitCode = 1;
  }
}

// --- 1. no key configured --------------------------------------------------

const noKey = session({});
const init = await handshake(noKey);
const instructions = init.result.instructions ?? "";

check("initialize returns server instructions", () => assert.ok(instructions.length > 100));
check("instructions say the key is NOT an OpenAI key", () =>
  assert.match(instructions, /NOT an OpenAI API key/));
check("instructions give the you.bot signup URL", () =>
  assert.match(instructions, /https:\/\/you\.bot/));
check("instructions mention the 50 free credits", () =>
  assert.match(instructions, /50 free credits/));
check("instructions name the env var", () =>
  assert.match(instructions, /YOUBOT_API_KEY/));
check("instructions state the per-image cost", () =>
  assert.match(instructions, /\$0\.029/));

const tools = (await noKey.send("tools/list")).result.tools;
check("three tools are exposed", () => assert.equal(tools.length, 3));
check("tool names are as documented", () =>
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ["check_credits", "edit_image", "generate_image"],
  ));
for (const t of tools) {
  check(`${t.name} description warns the key is from you.bot`, () =>
    assert.match(t.description, /you\.bot API key in YOUBOT_API_KEY — NOT an OpenAI key/));
}
check("generate_image exposes all 10 aspect ratios", () => {
  const g = tools.find((t) => t.name === "generate_image");
  assert.equal(g.inputSchema.properties.aspect_ratio.enum.length, 10);
  assert.deepEqual(g.inputSchema.required, ["prompt"]);
});
check("edit_image requires both a URL and a prompt", () => {
  const e = tools.find((t) => t.name === "edit_image");
  assert.deepEqual(e.inputSchema.required.sort(), ["image_url", "prompt"]);
});

const prompts = (await noKey.send("prompts/list")).result.prompts;
check("a setup prompt is offered", () => assert.equal(prompts[0].name, "setup"));

const setup = await noKey.send("prompts/get", { name: "setup" });
check("setup prompt reports the missing key and points at you.bot", () => {
  const text = setup.result.messages[0].content.text;
  assert.match(text, /No API key found/);
  assert.match(text, /https:\/\/you\.bot/);
});

const noKeyCall = await noKey.send("tools/call", {
  name: "generate_image",
  arguments: { prompt: "a red fox" },
});
check("calling a tool with no key fails with setup steps, not a stack trace", () => {
  assert.equal(noKeyCall.result.isError, true);
  const text = noKeyCall.result.content[0].text;
  assert.match(text, /No API key found/);
  assert.match(text, /NOT from OpenAI/);
  assert.match(text, /~?17 images|about 17 images/);
});
check("no image was generated and nothing was charged", () =>
  assert.equal(noKeyCall.result.content.length, 1));
noKey.close();

// --- 2. an OpenAI key pasted by mistake ------------------------------------

const wrongKey = session({ YOUBOT_API_KEY: "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz" });
await handshake(wrongKey);
const wrongCall = await wrongKey.send("tools/call", {
  name: "check_credits",
  arguments: {},
});
check("an OpenAI key is named as the mistake before any network call", () => {
  assert.equal(wrongCall.result.isError, true);
  const text = wrongCall.result.content[0].text;
  assert.match(text, /looks like an OpenAI API key/);
  assert.match(text, /sk-live-/);
});
wrongKey.close();

// --- 3. a plausible you.bot key gets past validation -----------------------

const goodKey = session({ YOUBOT_API_KEY: "sk-live-not-a-real-key" });
await handshake(goodKey);
const goodCall = await goodKey.send("tools/call", { name: "check_credits", arguments: {} });
check("a sk-live- key passes validation and reaches you.bot", () => {
  const text = goodCall.result.content[0].text;
  // Not a real key, so you.bot answers 401 — the point is that we got that far.
  assert.doesNotMatch(text, /No API key found|looks like an OpenAI/);
  assert.match(text, /401|credits|balance/i);
});
const setupOk = await goodKey.send("prompts/get", { name: "setup" });
check("setup prompt recognises a configured key", () =>
  assert.match(setupOk.result.messages[0].content.text, /already configured/));
goodKey.close();

// --- report ----------------------------------------------------------------

console.log("\nstdio JSON-RPC verification\n");
console.log(checks.join("\n"));
const failed = checks.filter((c) => c.includes("FAIL")).length;
console.log(`\n${checks.length - failed}/${checks.length} passed\n`);
