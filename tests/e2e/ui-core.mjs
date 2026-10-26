// Copyright 2026 Frank Gao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { stopServer, workerExecutable } from "../lib/platform.mjs";

const ROOT = process.env.RTL_PROJECT_ROOT ? path.resolve(process.env.RTL_PROJECT_ROOT) : path.resolve(import.meta.dirname, "..", "..");
const MAIN = path.join(ROOT, "dist", "server", "apps", "server", "src", "main.js");
const WORKER = workerExecutable(ROOT);
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const CHROMIUM = process.env.RTL_CHROMIUM ||
  (process.platform === "win32" ? "" : path.join(ROOT, ".sandbox", "deps", "browser", "chrome-linux64", "chrome"));
const STATE = path.join(ROOT, "state", `e2e-${Date.now()}-${process.pid}`);
const HOST = "127.0.0.1";

if (CHROMIUM && !fs.existsSync(CHROMIUM)) throw new Error(`Chromium not found at ${CHROMIUM}; set RTL_CHROMIUM`);
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function copy(name, fixture) {
  const dir = path.join(STATE, "projects", `${name}-${Date.now()}`);
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true, filter: (src) => path.basename(src) !== ".rtlb" });
  return dir;
}
fs.mkdirSync(path.join(STATE, "projects"), { recursive: true });
const simpleDir = copy("simple-ui", "simple");
const preDir = copy("preprocess-ui", "preprocess");
const xssDir = copy("xss-ui", "xss");
const warnDir = copy("warning-ui", "warning");
const brokenDir = copy("broken-ui", "broken");
const genDir = copy("generate-ui", "generate");
const ifdefDir = copy("ifdef-ui", "ifdef");
const dupDir = copy("duplicate-ui", "duplicate");
const pkgTypesDir = copy("package-types-ui", "package-types");
const importDir = path.join(STATE, "projects", "import-ui");
const mismatchDir = path.join(STATE, "projects", "mismatch-ui");
fs.mkdirSync(importDir, { recursive: true });
fs.mkdirSync(mismatchDir, { recursive: true });
const exportedBundle = path.join(STATE, "ui-export.rtlbsnap");

const server = spawn(process.execPath, [
  MAIN, "--workspace", STATE, "--worker", WORKER,
  "--web", path.join(ROOT, "dist", "web"), "--port", "0",
], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, RTL_PROJECT_ROOT: ROOT },
});
let serverStderr = "";
server.stderr.on("data", (c) => { serverStderr = (serverStderr + c.toString()).slice(-30000); });
const urlLine = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error(`server did not start\n${serverStderr}`)), 15000);
  server.stdout.on("data", (c) => {
    buf += c.toString();
    const line = buf.split("\n").find((x) => x.startsWith("open: "));
    if (line) { clearTimeout(timer); resolve(line.slice(6).trim()); }
  });
  server.on("exit", (code) => { if (code !== null) reject(new Error(`server exited ${code}\n${serverStderr}`)); });
});
const parsed = new URL(urlLine);
const base = `http://${HOST}:${parsed.port}`;

let browser;
let page;
const consoleLog = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(CHROMIUM ? { executablePath: CHROMIUM } : { channel: "msedge" }),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleLog.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => consoleLog.push(`pageerror: ${e.message}`));

  await page.goto(urlLine, { waitUntil: "networkidle" });
  assert.ok(!page.url().includes("token="));
  const cookies = await context.cookies(base);
  const sidCookie = cookies.find((c) => c.name.startsWith("rtl_sid_"));
  assert.ok(sidCookie);
  const cookie = `${sidCookie.name}=${sidCookie.value}`;
  const session = await fetch(`${base}/api/session`, { headers: { cookie } }).then((r) => r.json());
  const csrf = session.data.csrfToken;
  async function api(method, p, body) {
    const headers = { cookie, origin: base };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-rtl-csrf"] = csrf;
    const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json();
    if (!j.ok) throw new Error(`${method} ${p}: ${res.status} ${JSON.stringify(j)}`);
    return j.data;
  }
  async function seed(dir, topModule, extra = {}) {
    await api("POST", "/api/workspace/open", { path: dir });
    const config = {
      inputMode: "filelist", filelistPath: "design.f", topMode: "explicit", topModule,
      defines: [], includeRoots: [], libraries: [], parameters: [], language: "1800-2017",
      singleUnit: false, threads: 1, warningAsError: false, warningOptions: [],
      ...extra,
    };
    const project = (await api("POST", "/api/projects", { config })).project;
    const job = await api("POST", `/api/projects/${project.projectId}/build`, { configRevision: 1, requestKey: `seed-${Date.now()}` });
    for (let i = 0; i < 150; i++) {
      const j = await api("GET", `/api/projects/${project.projectId}/jobs/${job.jobId}`);
      if (["COMPLETE", "FAILED", "CANCELLED"].includes(j.state)) return { project, job: j };
      await sleep(100);
    }
    throw new Error("seed build did not finish");
  }
  function toolbarRange(text) {
    const m = /(\d+)–(\d+) \/ (\d+)/.exec(text);
    assert.ok(m, `source range missing: ${text}`);
    return { start: Number(m[1]), end: Number(m[2]), total: Number(m[3]) };
  }

  // --- open folder + build through the UI --------------------------------
  if (process.platform !== "win32") {
    const readonlyDir = path.join(STATE, "readonly-ui");
    fs.mkdirSync(readonlyDir, { recursive: true });
    fs.chmodSync(readonlyDir, 0o500);
    await page.locator(".home-card input").fill(readonlyDir);
    await page.getByRole("button", { name: "打开工程" }).click();
    await page.waitForSelector(".banner.error");
    assert.match(await page.locator(".banner.error").innerText(), /PERMISSION_DENIED|permission|权限/i);
    fs.chmodSync(readonlyDir, 0o700);
  }
  consoleLog.length = 0;

  await page.locator(".home-card input").fill(simpleDir);
  await page.getByRole("button", { name: "打开工程" }).click();
  await page.waitForSelector(".empty-workspace .build-form");
  const form = page.locator(".empty-workspace .build-form");
  assert.match(await form.innerText(), /工程目录/);
  const filelistInput = form.locator("label").filter({ hasText: "Filelist 路径" }).locator("input");
  const topInput = form.locator("label").filter({ hasText: "Top 模块" }).locator("input");
  assert.equal(await filelistInput.inputValue(), "", "Filelist input starts empty");
  assert.equal(await topInput.inputValue(), "", "Top input starts empty");
  assert.equal(await filelistInput.getAttribute("placeholder"), null, "Filelist input has no placeholder default");
  await form.getByRole("button", { name: "检查输入" }).click();
  await page.waitForTimeout(400);
  assert.match(await form.innerText(), /输入检查失败/, "empty input check reports failure");
  await filelistInput.fill(path.join(simpleDir, "design.f"));
  await form.locator("label").filter({ hasText: "Top 模块" }).locator("input").fill("top");
  await form.getByRole("button", { name: "检查输入" }).click();
  await page.waitForTimeout(500);
  assert.match(await form.locator(".form-status").innerText(), /输入检查通过/);
  assert.match(await form.locator(".form-status").innerText(), /尚未保存工程/, "input check must not create or save a project");
  await form.getByRole("button", { name: "编译并建立索引" }).click();
  await page.waitForSelector(".workspace", { timeout: 60000 });
  assert.equal(await page.locator(".project-chip").innerText(), "top");
  await page.waitForSelector(".tree-row");
  assert.equal(await page.locator(".tree-row").count(), 1);
  assert.equal(await page.getByRole("button", { name: "复制层次" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "复制路径" }).count(), 1);
  const navGroup = page.getByRole("group", { name: "页面导航" });
  const projectGroup = page.getByRole("group", { name: "工程操作" });
  assert.equal(await navGroup.getByRole("button", { name: "Up" }).count(), 1);
  assert.equal(await navGroup.getByRole("button", { name: "Down" }).count(), 1);
  assert.equal(await navGroup.getByRole("button", { name: "Top" }).count(), 1);
  assert.equal(await navGroup.getByRole("button", { name: "打开目录" }).count(), 0,
    "page-navigation controls are separate from project actions");
  assert.equal(await projectGroup.getByRole("button", { name: "打开目录" }).count(), 1);

  // --- export the current snapshot as a fixed-type single file -----------
  await page.getByRole("button", { name: "导出快照" }).click();
  await page.waitForSelector(".export-modal");
  const exportInput = page.locator(".export-modal input");
  assert.equal(await exportInput.inputValue(), "top", "export filename defaults to the top module");
  assert.equal(await page.locator(".export-modal .fixed-suffix").innerText(), ".rtlbsnap");
  await exportInput.fill("ui-export");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载快照" }).click(),
  ]);
  await download.saveAs(exportedBundle);
  assert.equal(download.suggestedFilename(), "ui-export.rtlbsnap");
  const exportedBytes = fs.readFileSync(exportedBundle);
  assert.equal(exportedBytes.subarray(0, 8).toString("ascii"), "RTLSNAP1");

  // --- resizable hierarchy/source and source/inspector boundaries -------
  const leftPane = page.locator(".left-pane");
  const leftBefore = (await leftPane.boundingBox()).width;
  const leftHandle = await page.locator(".left-resize").boundingBox();
  await page.mouse.move(leftHandle.x + 3, leftHandle.y + 80);
  await page.mouse.down();
  await page.mouse.move(leftHandle.x + 43, leftHandle.y + 80, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const leftAfter = (await leftPane.boundingBox()).width;
  assert.ok(leftAfter > leftBefore + 20, `left pane did not resize: ${leftBefore} -> ${leftAfter}`);
  assert.ok(Number(await page.evaluate(() => localStorage.getItem("rtl.leftWidth"))) > leftBefore);
  const rightPane = page.locator(".right-pane");
  const rightBefore = (await rightPane.boundingBox()).width;
  const rightHandle = await page.locator(".right-resize").boundingBox();
  await page.mouse.move(rightHandle.x + 3, rightHandle.y + 80);
  await page.mouse.down();
  await page.mouse.move(rightHandle.x - 27, rightHandle.y + 80, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.ok((await rightPane.boundingBox()).width > rightBefore + 15, "right pane did not resize");

  // --- tree, full source, hover, Up/Back --------------------------------
  const rootRow = page.locator(".tree-row").first();
  await rootRow.locator(".tree-toggle").click();
  await page.waitForTimeout(500);
  const u8Row = page.locator(".tree-row").filter({ hasText: "u8" }).first();
  await u8Row.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/);
  assert.equal(toolbarRange(await page.locator(".source-range").innerText()).end, 6);
  const declLine = page.locator(".src-line").filter({ hasText: "input logic [W-1:0] a" }).first();
  const aSpan = declLine.locator(".sem").filter({ hasText: /^a$/ }).first();
  await aSpan.hover();
  await page.waitForSelector(".hover-card");
  const hoverText = await page.locator(".hover-card").innerText();
  assert.match(hoverText, /^port/);
  assert.match(hoverText, /input logic \[W-1:0\] a/);
  assert.match(hoverText, /logic\[7:0\]/);
  const hoverBox = await page.locator(".hover-card").boundingBox();
  await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height - 3);
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".hover-card").count(), 1, "hover card must remain while pointer is inside");
  const downButton = page.getByRole("button", { name: "Down" });
  assert.equal(await downButton.isDisabled(), true, "Down is unavailable before any Up");
  await page.getByRole("button", { name: "Up" }).click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top \(top\.sv\)$/);
  const upRange = toolbarRange(await page.locator(".source-range").innerText());
  assert.equal(upRange.start, 1);
  assert.equal(upRange.end, upRange.total);
  const wTopSpan = page.locator(".src-line").filter({ hasText: "parameter int W_TOP = 8" }).first()
    .locator(".sem").filter({ hasText: /^W_TOP$/ }).first();
  await wTopSpan.hover();
  await page.waitForTimeout(400);
  const wTopHover = await page.locator(".hover-card").innerText();
  assert.match(wTopHover, /parameter/);
  assert.match(wTopHover, /默认值\s*8/);
  assert.match(wTopHover, /实际值\s*8\s*（与默认相同）/,
    "parameter actual value is shown even when it equals the default");
  await page.mouse.move(8, 360);
  await page.waitForTimeout(300);
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isDisabled(), true,
    "Up/Down are page operations and do not add token-navigation history");
  assert.equal(await downButton.isEnabled(), true, "Down is available after Up");
  await downButton.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/,
    "Down restores the child module saved by Up");
  assert.equal(await downButton.isDisabled(), true, "Down has no target after restoring the child");
  assert.equal(await page.getByRole("button", { name: "Up" }).isEnabled(), true);

  // --- parameter override jumps to the parent override expression -------
  const wLine = page.locator(".src-line").filter({ hasText: "parameter int W = 8" }).first();
  const wSpan = wLine.locator(".sem").filter({ hasText: /^W$/ }).first();
  await wSpan.click({ button: "right" });
  assert.equal(await page.getByRole("button", { name: "转到定义位置" }).count(), 0,
    "a parameter declaration does not offer goto-definition");
  await page.keyboard.press("Escape");
  const wUse = page.locator(".src-line").filter({ hasText: "input logic [W-1:0] a" }).first()
    .locator(".sem").filter({ hasText: /^W$/ }).first();
  await wUse.click({ button: "right" });
  assert.equal(await page.getByRole("button", { name: "转到定义位置" }).count(), 1,
    "a parameter use offers goto-definition");
  await page.getByRole("button", { name: "转到定义位置" }).click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /leaf\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "1");
  const wSpanAgain = page.locator(".src-line").filter({ hasText: "parameter int W = 8" }).first().locator(".sem").filter({ hasText: /^W$/ }).first();
  await wSpanAgain.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top \(top\.sv\)$/);
  assert.ok(await page.locator(".token-hl").count() > 0);
  const topRange = toolbarRange(await page.locator(".source-range").innerText());
  assert.equal(topRange.start, 1);
  assert.equal(topRange.end, topRange.total);

  // --- port actual is clickable and traceable ---------------------------
  const actualLine = page.locator(".src-line").filter({ hasText: "leaf #(.W(W_TOP)) u8" }).first();
  const actualA8 = actualLine.locator(".sem").filter({ hasText: /^a8$/ }).first();
  await actualA8.hover();
  await page.waitForTimeout(400);
  const actualHover = await page.locator(".hover-card").innerText();
  assert.match(actualHover, /^(variable|net|port)/);
  assert.match(actualHover, /logic \[7:0\] a8/);
  await actualA8.click({ button: "right" });
  await page.getByRole("button", { name: /Load/ }).click();
  await page.waitForTimeout(900);
  const loadText = await page.locator(".trace-panel").innerText();
  assert.match(loadText, /mirror8/);
  assert.match(loadText, /port/);
  const traceSearch = page.locator(".trace-panel .search-input");
  await traceSearch.fill("mirror");
  await page.waitForTimeout(300);
  assert.match(await page.locator(".trace-panel .search-count").innerText(), /^1\/\d+$/);
  assert.equal(await page.locator(".trace-row.search-current").count(), 1);
  await traceSearch.fill("");
  const actualAgain = page.locator(".src-line").filter({ hasText: "leaf #(.W(W_TOP)) u8" }).first().locator(".sem").filter({ hasText: /^a8$/ }).first();
  await actualAgain.click({ button: "right" });
  await page.getByRole("button", { name: "转到定义位置" }).click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top \(top\.sv\)$/);
  assert.equal(await page.locator('.src-line.src-line-hl').getAttribute("data-line"), "2");

  // --- signal click jumps to first driver, keeps the trace list ---------
  const a8Decl = page.locator(".src-line").filter({ hasText: "logic [7:0] a8" }).first().locator(".sem").filter({ hasText: /^a8$/ }).first();
  await a8Decl.click();
  await page.waitForTimeout(900);
  assert.match(await page.locator(".source-title").innerText(), /top \(top\.sv\)$/);
  assert.match(await page.locator(".trace-panel").innerText(), /continuous|driver/);

  // Output port actual: the first driver row can be the clicked token itself;
  // the UI must jump to the first distinct row (the child output port).
  const y8Actual = page.locator(".src-line").filter({ hasText: "leaf #(.W(W_TOP)) u8" }).first().locator(".sem").filter({ hasText: /^y8$/ }).first();
  await y8Actual.click();
  await page.waitForTimeout(900);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/,
    "driver jump skips the same-token record and reaches the child port");
  assert.ok(await page.locator(".src-line.src-line-hl").count() > 0);

  // --- context menu copies the clicked object's hierarchy path ---------
  const paramWSpan = page.locator(".src-line").filter({ hasText: "parameter int W = 8" }).first()
    .locator(".sem").filter({ hasText: /^W$/ }).first();
  await paramWSpan.click({ button: "right" });
  await page.getByRole("button", { name: "复制当前层次" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "top.u8.W",
    "parameter hierarchy path includes the current instance");
  const portASpan = page.locator(".src-line").filter({ hasText: "input logic [W-1:0] a" }).first()
    .locator(".sem").filter({ hasText: /^a$/ }).first();
  await portASpan.click({ button: "right" });
  await page.getByRole("button", { name: "复制当前层次" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "top.u8.a");

  // --- Top resets navigation, collapses the tree, disables nav ----------
  await page.getByRole("button", { name: "Top" }).click();
  await page.waitForTimeout(900);
  assert.match(await page.locator(".source-title").innerText(), /top \(top\.sv\)$/);
  assert.equal(await page.locator(".tree-row").count(), 1);
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isDisabled(), true);
  assert.equal(await page.getByTitle("前进 (Alt+Right)").isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Up" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Down" }).isDisabled(), true);
  const instanceU8 = page.locator(".src-line").filter({ hasText: "leaf #(.W(W_TOP)) u8" }).first()
    .locator(".sem").filter({ hasText: /^u8$/ }).first();
  await instanceU8.click({ button: "right" });
  await page.getByRole("button", { name: "复制当前层次" }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "top.u8",
    "instance hierarchy path is the instance path itself");

  // --- only source-token jumps own Back/Forward; hierarchy and trace-row
  //     switches replace the current entry instead of adding one ----------
  await page.locator(".tree-row").first().locator(".tree-toggle").click();
  await page.waitForTimeout(500);
  await page.locator(".tree-row").filter({ hasText: "u8" }).first().click();
  await page.waitForTimeout(700);
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isDisabled(), true,
    "hierarchy selection does not create token-navigation history");
  const portADecl = page.locator(".src-line").filter({ hasText: "input logic [W-1:0] a" }).first()
    .locator(".sem").filter({ hasText: /^a$/ }).first();
  await portADecl.click({ button: "right" });
  await page.getByRole("button", { name: /Load/ }).click();
  await page.waitForTimeout(900);
  await page.locator(".trace-row").first().click();
  await page.waitForTimeout(900);
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isDisabled(), true,
    "switching among Load rows does not create history");
  assert.equal(await page.getByTitle("前进 (Alt+Right)").isDisabled(), true);

  await page.locator(".tree-row").filter({ hasText: "u8" }).first().click();
  await page.waitForTimeout(700);
  const wSpanToken = page.locator(".src-line").filter({ hasText: "parameter int W = 8" }).first()
    .locator(".sem").filter({ hasText: /^W$/ }).first();
  await wSpanToken.click();
  await page.waitForTimeout(700);
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isEnabled(), true,
    "clicking a jumpable token adds a history entry");
  assert.equal(await page.getByTitle("前进 (Alt+Right)").isDisabled(), true);
  await page.locator(".trace-row").first().click();
  await page.waitForTimeout(900);
  const afterTraceRowUrl = page.url();
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isEnabled(), true);
  assert.equal(await page.getByTitle("前进 (Alt+Right)").isDisabled(), true,
    "trace-row switch must not add a forward entry");
  await page.getByTitle("后退 (Alt+Left)").click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /leaf\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "1");
  assert.match(await page.locator('.src-line[data-line="1"] .token-hl').first().innerText(), /^W$/,
    "Back returns to the exact clicked token once, not through trace rows");
  await page.getByTitle("前进 (Alt+Right)").click();
  await page.waitForTimeout(700);
  assert.equal(page.url(), afterTraceRowUrl,
    "Forward returns to the replaced token entry");

  await page.locator(".tree-row").filter({ hasText: "u8" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Up" }).click();
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole("button", { name: "Down" }).isEnabled(), true);
  await page.locator(".tree-row").filter({ hasText: "u16" }).first().click();
  await page.waitForTimeout(700);
  assert.equal(await page.getByRole("button", { name: "Down" }).isDisabled(), true,
    "Down is invalidated by unrelated navigation");
  await page.getByRole("button", { name: "Top" }).click();
  await page.waitForTimeout(900);

  // --- built-in search in hierarchy, source, and inspector --------------
  const searchLeftPane = page.locator(".left-pane");
  const searchBoxSize = await searchLeftPane.locator(".search-box").boundingBox();
  assert.ok(searchBoxSize.height >= 30, `search box is too short: ${searchBoxSize.height}`);
  const searchFontSize = await searchLeftPane.locator(".search-input").evaluate((el) => getComputedStyle(el).fontSize);
  assert.ok(parseFloat(searchFontSize) >= 14, `search font is too small: ${searchFontSize}`);
  await searchLeftPane.locator(".search-input").fill("u");
  await page.waitForTimeout(1100);
  const hierarchyCount = await searchLeftPane.locator(".search-count").innerText();
  assert.match(hierarchyCount, /^1\/\d+$/);
  assert.ok(Number(hierarchyCount.split("/")[1]) >= 2, "hierarchy search reports all matches");
  assert.match(await page.locator(".source-title").innerText(), /top\.u(8|16) \(leaf\.sv\)$/,
    "hierarchy search auto-jumps to the first match");
  await searchLeftPane.getByRole("button", { name: "下一个匹配" }).click();
  await page.waitForTimeout(900);
  assert.match(await searchLeftPane.locator(".search-count").innerText(), /^2\//);
  await searchLeftPane.locator(".search-input").fill("");
  await page.getByRole("button", { name: "Top" }).click();
  await page.waitForTimeout(900);

  const sourceSearch = page.locator(".source-toolbar .search-input");
  await sourceSearch.fill("assign");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".source-toolbar .search-count").innerText(), "1/3");
  assert.equal(await page.locator(".src-line.src-line-search-current").getAttribute("data-line"), "8");
  await page.locator(".source-toolbar").getByRole("button", { name: "下一个匹配" }).click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator(".source-toolbar .search-count").innerText(), "2/3");
  assert.equal(await page.locator(".src-line.src-line-search-current").getAttribute("data-line"), "9");
  await sourceSearch.fill("SSI");
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".source-toolbar .search-count").innerText(), "1/3");
  assert.equal(await page.locator('.src-line[data-line="8"] .src-search-text').innerText(), "ssi",
    "search highlights the matched substring inside the line (case-insensitive)");
  await sourceSearch.fill("");

  await page.locator(".tree-row").first().locator(".tree-toggle").click();
  await page.waitForTimeout(500);
  await page.locator(".tree-row").filter({ hasText: "u8" }).first().click();
  await page.waitForTimeout(800);
  const searchRightPane = page.locator(".right-pane");
  const portRow = searchRightPane.locator(".inspector-row").filter({
    has: page.locator("span.mono", { hasText: /^a$/ }),
  });
  await portRow.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "2",
    "clicking an Inspector port jumps to its declaration line");
  await searchRightPane.locator(".search-input").fill("a");
  await page.waitForTimeout(300);
  assert.match(await searchRightPane.locator(".search-count").innerText(), /^1\/1$/);
  assert.equal(await searchRightPane.locator(".inspector-row.search-current").count(), 1);
  await searchRightPane.getByRole("button", { name: "参数" }).click();
  const paramRow = searchRightPane.locator(".inspector-row").filter({
    has: page.locator("span.mono", { hasText: /^W$/ }),
  });
  assert.equal(await paramRow.locator(".param-kind").innerText(), "parameter");
  assert.equal(await paramRow.locator(".param-label").count(), 2,
    "parameter rows show separate default/actual labels");
  const paramOverlap = await paramRow.evaluate((el) => {
    const boxes = [...el.children].map((c) => c.getBoundingClientRect());
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) return true;
      }
    }
    return false;
  });
  assert.equal(paramOverlap, false, "parameter fields must not overlap");
  await paramRow.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "1",
    "clicking an Inspector parameter jumps to its declaration line");
  await searchRightPane.locator(".search-input").fill("W");
  await page.waitForTimeout(300);
  assert.match(await searchRightPane.locator(".search-count").innerText(), /^1\/1$/);
  assert.match(await searchRightPane.locator(".inspector-row.search-current").innerText(), /W/);
  await searchRightPane.locator(".search-input").fill("");

  // --- Back/Forward restore the Trace list along with the source view ----
  const portATraceToken = page.locator(".src-line").filter({ hasText: "input logic [W-1:0] a" }).first()
    .locator(".sem").filter({ hasText: /^a$/ }).first();
  await portATraceToken.click({ button: "right" });
  await page.getByRole("button", { name: /Load/ }).click();
  await page.waitForTimeout(700);
  const traceA = await page.locator(".trace-panel .trace-head .mono").innerText();
  const traceAList = await page.locator(".trace-panel .trace-list").innerText();
  await page.locator(".trace-row").first().click();
  await page.waitForTimeout(700);
  const yTraceToken = page.locator(".src-line").filter({ hasText: "output logic [W-1:0] y" }).first()
    .locator(".sem").filter({ hasText: /^y$/ }).first();
  await yTraceToken.click();
  await page.waitForTimeout(800);
  const traceB = await page.locator(".trace-panel .trace-head .mono").innerText();
  assert.notEqual(traceB, traceA, "clicking another signal opens a different Trace");
  assert.equal(await page.getByTitle("后退 (Alt+Left)").isEnabled(), true);
  await page.getByTitle("后退 (Alt+Left)").click();
  await page.waitForFunction(
    (id) => document.querySelector(".trace-panel .trace-head .mono")?.textContent === id,
    traceA, { timeout: 5000 },
  );
  assert.equal(await page.locator(".trace-panel .trace-list").innerText(), traceAList,
    "Back restores the previous driver/load list");
  await page.getByTitle("前进 (Alt+Right)").click();
  await page.waitForFunction(
    (id) => document.querySelector(".trace-panel .trace-head .mono")?.textContent === id,
    traceB, { timeout: 5000 },
  );

  // --- Back returns to the exact clicked token, not the module start -----
  await page.getByRole("button", { name: "Top" }).click();
  await page.waitForTimeout(900);
  await page.locator(".tree-row").first().locator(".tree-toggle").click();
  await page.waitForTimeout(500);
  await page.locator(".tree-row").filter({ hasText: "u8" }).first().click();
  await page.waitForTimeout(700);
  const yDeclToken = page.locator(".src-line").filter({ hasText: "output logic [W-1:0] y" }).first()
    .locator(".sem").filter({ hasText: /^y$/ }).first();
  await yDeclToken.click();
  await page.waitForTimeout(900);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "5",
    "clicking y jumps to its assign driver");
  await page.getByTitle("后退 (Alt+Left)").click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.u8 \(leaf\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "3",
    "Back restores the exact clicked token line, not the module start");
  assert.match(await page.locator('.src-line[data-line="3"] .token-hl').first().innerText(), /^y$/);
  await page.getByRole("button", { name: "Top" }).click();
  await page.waitForTimeout(900);

  // --- config change is saved by Build, invalidates the old snapshot and
  //     recompiles from source
  const simpleProjectId = new URL(page.url()).searchParams.get("project");
  const oldSnapshotId = (await api("GET", `/api/projects/${simpleProjectId}/snapshots`))[0].snapshotId;
  await page.getByRole("button", { name: "工程设置" }).click();
  assert.equal(await page.getByRole("button", { name: "保存配置" }).count(), 0,
    "configuration is saved by the build action");
  await page.locator(".settings-modal").getByRole("button", { name: "高级选项" }).click();
  await page.locator(".settings-modal label").filter({ hasText: "宏定义" }).locator("textarea").fill("E2E_CHANGE=1");
  await page.locator(".settings-modal").getByRole("button", { name: "编译并建立索引" }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".settings-modal").count(), 0);
  let rebuildJob = null;
  for (let i = 0; i < 150; i++) {
    const jobs = await api("GET", `/api/projects/${simpleProjectId}/jobs`);
    rebuildJob = jobs[0];
    if (rebuildJob && ["COMPLETE", "FAILED", "CANCELLED"].includes(rebuildJob.state)) break;
    await sleep(100);
  }
  assert.equal(rebuildJob?.state, "COMPLETE");
  const simpleProject = await api("GET", `/api/projects/${simpleProjectId}`);
  assert.equal(simpleProject.config.configRevision, 2);
  assert.ok(simpleProject.config.defines.some((d) => d.name === "E2E_CHANGE" && d.value === "1"));
  const rebuiltSnapshots = await api("GET", `/api/projects/${simpleProjectId}/snapshots`);
  assert.equal(rebuiltSnapshots.length, 1);
  assert.notEqual(rebuiltSnapshots[0].snapshotId, oldSnapshotId,
    "build from source publishes a new snapshot after the config change");

  // --- generate if/for hierarchy, selection, and Up ----------------------
  await seed(genDir, "top");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  await page.locator(".tree-row").first().locator(".tree-toggle").click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".tree-row.tree-generate_array").count(), 0, "for-generate array level is flattened");
  assert.equal(await page.locator(".tree-row.tree-generate").count(), 1);
  assert.equal(await page.locator(".tree-row").filter({ hasText: "inactive_branch" }).count(), 0);
  const iterRows = page.locator(".tree-row.tree-generate_iter");
  assert.equal(await iterRows.count(), 3, "one visible row per for-generate iteration");
  assert.equal(await iterRows.first().locator(".tree-name").innerText(), "g[0]");
  await iterRows.first().locator(".tree-toggle").click();
  await page.waitForTimeout(400);
  const uGRow = page.locator(".tree-row.tree-instance").filter({ hasText: "u_g" }).first();
  await uGRow.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.g\[0\]\.u_g \(leaf\.sv\)$/);
  await page.getByRole("button", { name: "Up" }).click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.g\[0\] \(top\.sv\)$/);
  assert.equal(await page.locator(".tree-row.selected.tree-generate_iter").count(), 1);
  await page.getByRole("button", { name: "Up" }).click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top \(top\.sv\)$/);
  assert.equal(await page.locator(".tree-row.selected.tree-instance").count(), 1);
  const a4Gen = page.locator(".src-line").filter({ hasText: "logic [3:0] a4" }).first().locator(".sem").filter({ hasText: /^a4$/ }).first();
  await a4Gen.click({ button: "right" });
  await page.getByRole("button", { name: /Load/ }).click();
  await page.waitForTimeout(900);
  assert.match(await page.locator(".trace-panel").innerText(), /local_sig/);
  await page.locator(".trace-row").filter({ hasText: "local_sig" }).first().click();
  await page.waitForTimeout(900);
  assert.match(await page.locator(".source-title").innerText(), /top\.g\[\d+\] \(top\.sv\)$/);
  assert.equal(await page.locator(".tree-row.selected.tree-generate_iter").count(), 1, "trace jump selects the generate iteration node");
  assert.equal(await page.locator('.src-line[data-line="9"]').evaluate((el) => el.classList.contains("src-line-inactive")), true,
    "the untaken generate branch is grayed out");
  assert.ok(await page.locator('.src-line[data-line="9"] .src-inactive').count() > 0);
  assert.equal(await page.locator('.src-line[data-line="9"] .sem').count(), 0,
    "inactive generate code has no semantic links");
  assert.ok(await page.locator('.src-line[data-line="11"] .sem').count() > 0,
    "the active generate branch keeps semantic links");

  // --- preprocessor-skipped branches are grayed out, including nested ones -
  await seed(ifdefDir, "top", { defines: [{ name: "ENABLE_A", value: "1" }] });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  assert.equal(await page.locator('.src-line[data-line="8"]').evaluate((el) => el.classList.contains("src-line-inactive")), true,
    "the unselected nested ifdef branch is grayed out");
  assert.ok(await page.locator('.src-line[data-line="8"] .src-inactive').count() > 0);
  assert.equal(await page.locator('.src-line[data-line="8"] .sem').count(), 0);
  assert.equal(await page.locator('.src-line[data-line="10"]').evaluate((el) => el.classList.contains("src-line-inactive")), false,
    "the selected nested else branch stays active");
  assert.ok(await page.locator('.src-line[data-line="10"] .sem').count() > 0);
  assert.equal(await page.locator('.src-line[data-line="21"]').evaluate((el) => el.classList.contains("src-line-inactive")), true,
    "the unselected outer else branch is grayed out");
  assert.equal(await page.locator('.src-line[data-line="21"] .sem').count(), 0);
  assert.equal(await page.locator('.src-line[data-line="26"]').evaluate((el) => el.classList.contains("src-line-inactive")), false,
    "code after the conditional group remains active");

  // --- only the current module definition is interactive in a shared file -
  await seed(dupDir, "top");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  assert.equal(await page.locator('.src-line[data-line="2"]').evaluate((el) => el.classList.contains("src-line-inactive")), true,
    "the leaf module is inactive while viewing top");
  assert.equal(await page.locator('.src-line[data-line="2"] .sem').count(), 0);
  assert.equal(await page.locator('.src-line[data-line="9"]').evaluate((el) => el.classList.contains("src-line-inactive")), false);
  assert.ok(await page.locator('.src-line[data-line="9"] .sem').count() > 0);
  await page.locator(".tree-row").first().locator(".tree-toggle").click();
  await page.waitForTimeout(400);
  await page.locator(".tree-row").filter({ hasText: "u1" }).first().click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /top\.u1 \(top\.sv\)$/);
  assert.equal(await page.locator('.src-line[data-line="2"]').evaluate((el) => el.classList.contains("src-line-inactive")), false,
    "the leaf definition becomes active for a leaf instance");
  assert.ok(await page.locator('.src-line[data-line="2"] .sem').count() > 0);
  assert.equal(await page.locator('.src-line[data-line="9"]').evaluate((el) => el.classList.contains("src-line-inactive")), true,
    "the top definition is inactive while viewing leaf");
  assert.equal(await page.locator('.src-line[data-line="9"] .sem').count(), 0);

  // --- package struct fields jump to other typedefs -----------------------
  await seed(pkgTypesDir, "top");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  const elementUse = page.locator(".src-line").filter({ hasText: "element_t elem" }).first()
    .locator(".sem").filter({ hasText: /^element_t$/ }).first();
  await elementUse.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /\(pkg\.sv\)$/);
  const nibbleFieldSpan = page.locator(".src-line").filter({ hasText: "nibble_t nibble" }).first()
    .locator(".sem").filter({ hasText: /^nibble_t$/ }).first();
  assert.ok(await nibbleFieldSpan.count() > 0,
    "a package struct field keeps its typedef link");
  await page.mouse.move(10, 430);
  await page.waitForTimeout(500);
  await nibbleFieldSpan.evaluate((el) => el.click());
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /\(pkg\.sv\)$/);
  assert.equal(await page.locator(".src-line.src-line-hl").getAttribute("data-line"), "2",
    "the package struct field jumps to its typedef declaration");

  // --- preprocess links ---------------------------------------------------
  await seed(preDir, "top");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  await page.locator(".tree-row").first().locator(".tree-toggle").click();
  await page.waitForTimeout(400);
  await page.locator(".tree-row").filter({ hasText: "u_leaf" }).first().click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /u_leaf \(leaf\.sv\)$/);
  assert.equal(await page.locator(".sem").filter({ hasText: "include" }).count(), 0, "include keyword must not be a link");
  const macroSpan = page.locator(".sem").filter({ hasText: /WIDTH/ }).first();
  await macroSpan.hover();
  await page.waitForTimeout(400);
  const macroHover = await page.locator(".hover-card").innerText();
  assert.match(macroHover, /^macro/);
  assert.match(macroHover, /`define WIDTH 8/);
  const macroBox = await page.locator(".hover-card").boundingBox();
  await page.mouse.move(macroBox.x + macroBox.width / 2, macroBox.y + macroBox.height - 3);
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".hover-card").count(), 1, "macro hover card must remain interactive");
  await macroSpan.click({ button: "right" });
  assert.equal(await page.getByRole("button", { name: "复制当前层次" }).count(), 0,
    "macros have no hierarchy path to copy");
  await page.keyboard.press("Escape");
  await page.locator(".sem").filter({ hasText: "defs.svh" }).first().click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /\(defs\.svh\)$/);
  await page.getByTitle("后退 (Alt+Left)").click();
  await page.waitForTimeout(700);
  const byteSpan = page.locator(".sem").filter({ hasText: /^byte_t$/ }).first();
  await byteSpan.click({ button: "right" });
  assert.equal(await page.getByRole("button", { name: "复制当前层次" }).count(), 0,
    "types have no hierarchy path to copy");
  await page.keyboard.press("Escape");
  await page.mouse.move(10, 420);
  await byteSpan.hover();
  await page.waitForTimeout(400);
  assert.match(await page.locator(".hover-card").innerText(), /^type/);
  assert.match(await page.locator(".hover-card").innerText(), /typedef logic \[7:0\] byte_t/);
  await byteSpan.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /\(pkg\.sv\)$/);
  await page.getByTitle("后退 (Alt+Left)").click();
  await page.waitForTimeout(700);
  const importLine = page.locator(".src-line").filter({ hasText: "import p::*;" }).first();
  const pkgSpan = importLine.locator(".sem").filter({ hasText: /^p$/ }).first();
  await pkgSpan.click({ button: "right" });
  assert.equal(await page.getByRole("button", { name: "复制当前层次" }).count(), 0,
    "packages have no hierarchy path to copy");
  await page.keyboard.press("Escape");
  await page.mouse.move(10, 420);
  await pkgSpan.hover();
  await page.waitForTimeout(400);
  assert.match(await page.locator(".hover-card").innerText(), /^package/);
  assert.match(await page.locator(".hover-card").innerText(), /package p;/);
  await pkgSpan.click();
  await page.waitForTimeout(700);
  assert.match(await page.locator(".source-title").innerText(), /^p \(pkg\.sv\)$/,
    "package navigation drops the previous module hierarchy");
  assert.match(page.url(), /[?&]ctx=p(?:&|$)/);
  const copyHierarchy = page.getByRole("button", { name: "复制层次" });
  assert.equal(await copyHierarchy.isEnabled(), true, "copy hierarchy stays enabled for packages");
  await copyHierarchy.click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "p",
    "copy hierarchy returns the package name");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  assert.match(await page.locator(".source-title").innerText(), /^p \(pkg\.sv\)$/,
    "package context survives a deep-link reload");

  // --- import a shared .rtlbsnap into a fresh directory without compiling
  await page.getByRole("button", { name: "打开目录" }).click();
  await page.locator(".home-card input").fill(importDir);
  await page.getByRole("button", { name: "打开工程" }).click();
  await page.waitForSelector(".empty-workspace .snapshot-import-card");
  assert.equal(await page.locator(".workspace").count(), 0);
  const importChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择快照文件…" }).click();
  await (await importChooser).setFiles(exportedBundle);
  await page.waitForSelector(".workspace", { timeout: 15000 });
  await page.waitForFunction(() => /top \(top\.sv\)$/.test(document.querySelector(".source-title")?.textContent ?? ""), undefined, { timeout: 15000 });
  assert.match(await page.locator(".project-chip").innerText(), /top/);
  const noticeBox = await page.locator(".banner.notice").boundingBox();
  const workspaceBox = await page.locator(".workspace").boundingBox();
  assert.ok(noticeBox, "snapshot import shows a status banner");
  assert.ok(noticeBox.y + noticeBox.height <= workspaceBox.y + 1,
    `workspace must lay out below the status banner (banner bottom ${noticeBox.y + noticeBox.height}, workspace top ${workspaceBox.y})`);
  const importedWorkspace = await api("GET", "/api/workspace");
  assert.ok(importedWorkspace.project);
  assert.equal(importedWorkspace.snapshot.snapshotId, importedWorkspace.project.currentSnapshotId);
  assert.equal((await api("GET", `/api/projects/${importedWorkspace.project.projectId}/jobs`)).length, 0,
    "opening from a snapshot must not create a build job");

  // A version-mismatched bundle is rejected and opens nothing.
  const rawLen = exportedBytes.readUInt32LE(12);
  const rawHeader = JSON.parse(exportedBytes.subarray(48, 48 + rawLen).toString("utf8"));
  rawHeader.extractorVersion = "0.0.1";
  const newHeader = Buffer.from(JSON.stringify(rawHeader), "utf8");
  const preamble = Buffer.from(exportedBytes.subarray(0, 16));
  preamble.writeUInt32LE(newHeader.length, 12);
  const mismatchFile = path.join(STATE, "mismatch.rtlbsnap");
  fs.writeFileSync(mismatchFile, Buffer.concat([
    preamble,
    crypto.createHash("sha256").update(newHeader).digest(),
    newHeader,
    exportedBytes.subarray(48 + rawLen),
  ]));
  await page.getByRole("button", { name: "打开目录" }).click();
  await page.locator(".home-card input").fill(mismatchDir);
  await page.getByRole("button", { name: "打开工程" }).click();
  await page.waitForSelector(".empty-workspace .snapshot-import-card");
  const badChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "选择快照文件…" }).click();
  await (await badChooser).setFiles(mismatchFile);
  await page.waitForSelector(".error-modal", { timeout: 15000 });
  assert.match(await page.locator(".error-modal").innerText(), /版本.*不匹配|不匹配/);
  assert.equal(await page.locator(".workspace").count(), 0);
  assert.equal((await api("GET", "/api/workspace")).project, null);
  await page.locator(".error-modal").getByRole("button", { name: "关闭" }).click();
  // Expected negative responses: blank input check (400) and version mismatch (409).
  consoleLog.length = 0;

  // --- XSS source is text, not executable --------------------------------
  await seed(xssDir, "xss");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  assert.ok((await page.locator(".source-viewport").innerText()).includes("<script>"));
  assert.equal(await page.evaluate(() => window.__xss ?? null), null);

  // --- warning is retained; broken has no workspace ----------------------
  await seed(warnDir, "warning", { warningOptions: ["width-trunc"] });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".workspace");
  await page.locator(".panel-tabs button", { hasText: "Compile" }).click();
  await page.waitForSelector(".compile-panel .diag", { timeout: 10000 });
  await page.waitForTimeout(300);
  assert.match(await page.locator(".bottom-panel").innerText(), /WARNING|warning|警告/i);
  const compileSearch = page.locator(".compile-panel .search-input");
  await compileSearch.fill("warning");
  await page.waitForTimeout(300);
  assert.match(await page.locator(".compile-panel .search-count").innerText(), /^1\/\d+$/,
    "compile search counts matching diagnostics");
  assert.equal(await page.locator(".compile-panel .diag.search-current").count(), 1,
    "compile search jumps to the first matching diagnostic row");
  await compileSearch.fill("");

  await seed(brokenDir, "broken");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".empty-workspace");
  assert.equal(await page.locator(".workspace").count(), 0);
  assert.match(await page.locator(".empty-workspace").innerText(), /错误|FAILED|error/i);

  // --- appearance ---------------------------------------------------------
  await page.getByRole("button", { name: "外观" }).click();
  await page.locator(".appearance-popover select").selectOption("dark");
  await page.locator(".appearance-popover input[type=range]").first().fill("125");
  const appearance = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    root: getComputedStyle(document.documentElement).fontSize,
    stored: localStorage.getItem("rtl.globalScale"),
  }));
  assert.equal(appearance.theme, "dark");
  assert.equal(appearance.root, "20px");
  assert.equal(appearance.stored, "1.25");

  // --- a second tab on the same server is blocked by Web Locks ------------
  const second = await context.newPage();
  await second.goto(urlLine, { waitUntil: "networkidle" });
  await second.waitForSelector(".workspace-lock-card", { timeout: 10000 });
  assert.match(await second.locator(".workspace-lock-card").innerText(), /另一个标签页/);
  assert.equal(await second.locator(".workspace").count(), 0);
  assert.equal(await second.locator(".empty-workspace").count(), 0);
  await page.close();
  await second.getByRole("button", { name: "重试" }).click();
  await second.waitForSelector(".empty-workspace, .workspace", { timeout: 15000 });
  page = second;

  assert.deepEqual(consoleLog, [], `browser errors:\n${consoleLog.join("\n")}\nserver:\n${serverStderr.slice(-4000)}`);
  console.log("ui-core: PASS");
} catch (err) {
  console.error("ui-core: FAIL");
  if (page) {
    try { await page.screenshot({ path: path.join(STATE, "failure.png"), fullPage: true }); } catch { /* ignore */ }
    try { console.error("url:", page.url()); } catch { /* ignore */ }
  }
  console.error(consoleLog.join("\n"));
  console.error("server stderr:", serverStderr.slice(-8000));
  throw err;
} finally {
  await browser?.close().catch(() => {});
  await stopServer(server);
  fs.rmSync(STATE, { recursive: true, force: true });
}
