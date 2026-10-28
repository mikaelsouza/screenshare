import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { baseUrl, INSTRUMENT, launchBrowser, startServer, stopServer, waitFor } from "./helpers.mjs";

const PORT = 8892;
const BASE_URL = baseUrl(PORT);

let server;
let browser;
let page;

/** Read the results table as { test -> { status, details } }. */
const readRows = () =>
  Object.fromEntries(
    [...document.querySelectorAll("#results tr")].map((tr) => {
      const [name, status, details] = [...tr.querySelectorAll("td")].map((td) => td.textContent.trim());
      return [name, { status, details }];
    }),
  );

describe("diagnostics page", { concurrency: 1 }, () => {
  before(async () => {
    server = await startServer(PORT);
    browser = await launchBrowser();
    const ctx = await browser.newContext();
    await ctx.addInitScript(INSTRUMENT);
    page = await ctx.newPage();
    await page.goto(`${BASE_URL}/diagnostics`);
  });

  after(async () => {
    await browser?.close();
    await stopServer(server);
  });

  it("starts with an empty results table", async () => {
    assert.equal(await page.evaluate(() => document.querySelectorAll("#results tr").length), 0);
  });

  it("runs the suite and re-enables the button when finished", async () => {
    await page.click("#run-btn");
    await waitFor(page, () => !document.getElementById("run-btn").disabled, {
      label: "diagnostics run to finish",
      timeout: 60_000,
    });
    assert.equal(await page.evaluate(() => document.getElementById("run-btn").textContent), "Run test");
  });

  it("reports every check it claims to run", async () => {
    const rows = await page.evaluate(readRows);
    for (const name of ["Browser", "Secure context", "System audio", "WebRTC loopback", "STUN / public address", "NAT mapping"]) {
      assert.ok(name in rows, `missing row "${name}"; got ${Object.keys(rows).join(", ")}`);
    }
  });

  it("passes the checks that do not depend on the network", async () => {
    const rows = await page.evaluate(readRows);
    // 127.0.0.1 is a secure context, and headless Chromium is Chromium.
    assert.equal(rows["Browser"].status, "PASS");
    assert.equal(rows["Secure context"].status, "PASS");
    // Proves the local WebRTC stack works, independently of any network condition.
    assert.equal(rows["WebRTC loopback"].status, "PASS", rows["WebRTC loopback"].details);
  });

  it("gives an actionable explanation for every non-passing row", async () => {
    const rows = await page.evaluate(readRows);
    for (const [name, { status, details }] of Object.entries(rows)) {
      if (status === "PASS") continue;
      assert.ok(details.length > 20, `row "${name}" is ${status} with an unhelpful detail: "${details}"`);
    }
  });

  it("can be re-run without duplicating rows", async () => {
    const before = await page.evaluate(() => document.querySelectorAll("#results tr").length);
    await page.click("#run-btn");
    await waitFor(page, () => !document.getElementById("run-btn").disabled, { label: "second run", timeout: 60_000 });
    const after = await page.evaluate(() => document.querySelectorAll("#results tr").length);
    assert.equal(after, before, "results table grew on re-run instead of being replaced");
  });
});
