import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { ToolResponse } from "./pi-tools.js";

const execFileAsync = promisify(execFile);

export type VisualReviewViewport =
  | "wide-desktop"
  | "desktop"
  | "laptop"
  | "tablet"
  | "mobile"
  | "compact-mobile";

export interface CustomVisualReviewViewport {
  name: string;
  width: number;
  height: number;
}

export interface VisualReviewInput {
  url: string;
  viewports?: VisualReviewViewport[];
  customViewports?: CustomVisualReviewViewport[];
  waitMs?: number;
}

interface BrowserExecutable {
  path: string;
  name: string;
}

export interface ViewportSpec {
  preset: string;
  width: number;
  height: number;
}

export const VISUAL_REVIEW_VIEWPORTS: Record<VisualReviewViewport, ViewportSpec> = {
  "wide-desktop": { preset: "wide-desktop", width: 1600, height: 1000 },
  desktop: { preset: "desktop", width: 1440, height: 900 },
  laptop: { preset: "laptop", width: 1366, height: 768 },
  tablet: { preset: "tablet", width: 768, height: 1024 },
  mobile: { preset: "mobile", width: 390, height: 844 },
  "compact-mobile": { preset: "compact-mobile", width: 360, height: 800 },
};

export const DEFAULT_VISUAL_REVIEW_VIEWPORTS: VisualReviewViewport[] = [
  "desktop",
  "laptop",
  "tablet",
  "mobile",
];

const DEFAULT_WAIT_MS = 750;
const MAX_WAIT_MS = 10_000;
const MAX_CUSTOM_VIEWPORTS = 6;
const MIN_VIEWPORT_WIDTH = 320;
const MAX_VIEWPORT_WIDTH = 2560;
const MIN_VIEWPORT_HEIGHT = 480;
const MAX_VIEWPORT_HEIGHT = 1600;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const TRANSIENT_BROWSER_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ETXTBSY"]);
const MAX_CAPTURE_ATTEMPTS = 2;

export function normalizeVisualReviewUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("visual_review requires a valid absolute URL, for example http://localhost:3000/dashboard.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("visual_review only supports http:// and https:// URLs.");
  }

  const hostname = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(hostname) && !hostname.endsWith(".localhost")) {
    throw new Error(
      "visual_review is limited to local development URLs (localhost, 127.0.0.1, or ::1).",
    );
  }

  url.hash = "";
  return url.toString();
}

function normalizeCustomViewport(viewport: CustomVisualReviewViewport): ViewportSpec {
  const name = viewport.name.trim();
  if (!name) throw new Error("visual_review custom viewport names cannot be empty.");
  if (!Number.isInteger(viewport.width) || viewport.width < MIN_VIEWPORT_WIDTH || viewport.width > MAX_VIEWPORT_WIDTH) {
    throw new Error(
      `visual_review custom viewport width must be an integer between ${MIN_VIEWPORT_WIDTH} and ${MAX_VIEWPORT_WIDTH}.`,
    );
  }
  if (!Number.isInteger(viewport.height) || viewport.height < MIN_VIEWPORT_HEIGHT || viewport.height > MAX_VIEWPORT_HEIGHT) {
    throw new Error(
      `visual_review custom viewport height must be an integer between ${MIN_VIEWPORT_HEIGHT} and ${MAX_VIEWPORT_HEIGHT}.`,
    );
  }
  return { preset: name, width: viewport.width, height: viewport.height };
}

export function resolveVisualReviewViewports(
  requested?: VisualReviewViewport[],
  customViewports?: CustomVisualReviewViewport[],
): ViewportSpec[] {
  const presets = requested?.length ? requested : DEFAULT_VISUAL_REVIEW_VIEWPORTS;
  const resolved = [...new Set(presets)].map((preset) => VISUAL_REVIEW_VIEWPORTS[preset]);

  if ((customViewports?.length ?? 0) > MAX_CUSTOM_VIEWPORTS) {
    throw new Error(`visual_review accepts at most ${MAX_CUSTOM_VIEWPORTS} custom viewports.`);
  }

  for (const custom of customViewports ?? []) {
    resolved.push(normalizeCustomViewport(custom));
  }

  const unique = new Map<string, ViewportSpec>();
  for (const viewport of resolved) {
    unique.set(`${viewport.width}x${viewport.height}`, viewport);
  }
  return [...unique.values()];
}

function normalizeWaitMs(waitMs?: number): number {
  if (waitMs === undefined) return DEFAULT_WAIT_MS;
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new Error(`visual_review waitMs must be an integer between 0 and ${MAX_WAIT_MS}.`);
  }
  return waitMs;
}

function browserCandidates(): BrowserExecutable[] {
  const configured = process.env.AGENTIC_BROWSER_EXECUTABLE?.trim();
  const candidates: BrowserExecutable[] = [];

  if (configured) {
    candidates.push({ path: configured, name: basename(configured) });
  }

  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES;
    const programFilesX86 = process.env["PROGRAMFILES(X86)"];
    const localAppData = process.env.LOCALAPPDATA;

    for (const root of [programFiles, programFilesX86, localAppData]) {
      if (!root) continue;
      candidates.push(
        { path: join(root, "Google", "Chrome", "Application", "chrome.exe"), name: "Chrome" },
        { path: join(root, "Microsoft", "Edge", "Application", "msedge.exe"), name: "Edge" },
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      { path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", name: "Chrome" },
      { path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", name: "Edge" },
      { path: "/Applications/Chromium.app/Contents/MacOS/Chromium", name: "Chromium" },
    );
  } else {
    candidates.push(
      { path: "/usr/bin/google-chrome", name: "Chrome" },
      { path: "/usr/bin/google-chrome-stable", name: "Chrome" },
      { path: "/usr/bin/chromium", name: "Chromium" },
      { path: "/usr/bin/chromium-browser", name: "Chromium" },
      { path: "/usr/bin/microsoft-edge", name: "Edge" },
      { path: "/usr/bin/microsoft-edge-stable", name: "Edge" },
    );
  }

  const executableNames = process.platform === "win32"
    ? ["chrome.exe", "msedge.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];

  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const executable of executableNames) {
      candidates.push({
        path: join(dir, executable),
        name: executable.toLowerCase().includes("edge")
          ? "Edge"
          : executable.toLowerCase().includes("chromium")
            ? "Chromium"
            : "Chrome",
      });
    }
  }

  return candidates;
}

export function findVisualReviewBrowser(): BrowserExecutable | null {
  const seen = new Set<string>();
  for (const candidate of browserCandidates()) {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

export function buildVisualReviewBrowserArgs(
  url: string,
  viewport: ViewportSpec,
  screenshotPath: string,
  profilePath: string,
  waitMs: number,
): string[] {
  return [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--run-all-compositor-stages-before-draw",
    "--ignore-certificate-errors",
    "--force-device-scale-factor=1",
    `--window-size=${viewport.width},${viewport.height}`,
    `--user-data-dir=${profilePath}`,
    `--virtual-time-budget=${Math.max(waitMs, 1)}`,
    `--screenshot=${screenshotPath}`,
    url,
  ];
}

function safeScreenshotName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "viewport";
}

function processErrorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

function summarizeProcessError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const candidate = error as { code?: unknown; signal?: unknown; stderr?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" || typeof candidate.code === "number" ? String(candidate.code) : "";
  const signal = typeof candidate.signal === "string" ? candidate.signal : "";
  const stderr = typeof candidate.stderr === "string" ? candidate.stderr.trim() : "";
  const message = typeof candidate.message === "string" ? candidate.message.trim() : String(error);
  const detail = (stderr || message).replace(/\s+/g, " ").slice(0, 360);
  return [code && `code=${code}`, signal && `signal=${signal}`, detail].filter(Boolean).join("; ");
}

function isValidPng(image: Buffer): boolean {
  return image.length > PNG_SIGNATURE.length + PNG_IEND.length
    && image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && image.subarray(-PNG_IEND.length).equals(PNG_IEND);
}

async function cleanupVisualReviewTempDir(tempDir: string): Promise<string | null> {
  try {
    await rm(tempDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 2,
      retryDelay: 125,
    });
    return null;
  } catch (error) {
    const code = processErrorCode(error);
    const timer = setTimeout(() => {
      void rm(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }).catch(() => undefined);
    }, 1_000);
    timer.unref();
    return `Temporary browser profile cleanup was deferred${code ? ` (${code})` : ""}.`;
  }
}

interface CaptureResult {
  data: string;
  bytes: number;
  warnings: string[];
}

async function captureViewportAttempt(
  browser: BrowserExecutable,
  url: string,
  viewport: ViewportSpec,
  waitMs: number,
): Promise<CaptureResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "agentic-visual-review-"));
  const screenshotPath = join(tempDir, `${safeScreenshotName(viewport.preset)}-${viewport.width}x${viewport.height}.png`);
  const profilePath = join(tempDir, "profile");
  const warnings: string[] = [];
  let capture: CaptureResult | null = null;
  let failure: Error | null = null;

  try {
    const args = buildVisualReviewBrowserArgs(
      url,
      viewport,
      screenshotPath,
      profilePath,
      waitMs,
    );

    let browserError: unknown = null;
    try {
      await execFileAsync(browser.path, args, {
        timeout: Math.max(15_000, waitMs + 15_000),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      browserError = error;
    }

    if (!existsSync(screenshotPath)) {
      const reason = browserError ? `: ${summarizeProcessError(browserError)}` : ".";
      const error = new Error(`${browser.name} finished without producing a screenshot${reason}`);
      Object.assign(error, { code: processErrorCode(browserError), cause: browserError });
      failure = error;
    } else {
      const image = readFileSync(screenshotPath);
      if (!isValidPng(image)) {
        const reason = browserError ? ` ${summarizeProcessError(browserError)}` : "";
        const error = new Error(`${browser.name} produced an invalid PNG screenshot.${reason}`.trim());
        Object.assign(error, { code: processErrorCode(browserError), cause: browserError });
        failure = error;
      } else {
        if (browserError) {
          warnings.push(
            `${browser.name} exited with an error after producing a valid PNG; the capture was kept (${summarizeProcessError(browserError)}).`,
          );
        }
        capture = { data: image.toString("base64"), bytes: image.length, warnings };
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const cleanupWarning = await cleanupVisualReviewTempDir(tempDir);
  if (cleanupWarning) warnings.push(cleanupWarning);
  if (failure) throw failure;
  if (!capture) throw new Error(`${browser.name} capture did not produce a result.`);
  return { ...capture, warnings };
}

async function captureViewport(
  browser: BrowserExecutable,
  url: string,
  viewport: ViewportSpec,
  waitMs: number,
): Promise<CaptureResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    try {
      return await captureViewportAttempt(browser, url, viewport, waitMs);
    } catch (error) {
      lastError = error;
      const code = processErrorCode(error);
      const isTransient = typeof code === "string" && TRANSIENT_BROWSER_ERROR_CODES.has(code);
      if (!isTransient || attempt === MAX_CAPTURE_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function visualReviewTool(input: VisualReviewInput): Promise<ToolResponse> {
  const url = normalizeVisualReviewUrl(input.url);
  const waitMs = normalizeWaitMs(input.waitMs);
  const viewports = resolveVisualReviewViewports(input.viewports, input.customViewports);
  const browser = findVisualReviewBrowser();

  if (!browser) {
    return {
      content: [{
        type: "text",
        text: "No supported local browser was found. Install Chrome, Edge, or Chromium, or set AGENTIC_BROWSER_EXECUTABLE to the browser executable path.",
      }],
      isError: true,
      structuredContent: {
        code: "visual_review_browser_not_found",
        supportedBrowsers: ["Chrome", "Edge", "Chromium"],
      },
    };
  }

  const captures: Array<{
    preset: string;
    width: number;
    height: number;
    mimeType: "image/png";
    bytes: number;
  }> = [];
  const imageContent: Array<{ type: "image"; data: string; mimeType: string }> = [];
  const warnings: string[] = [];
  const failures: Array<{
    preset: string;
    width: number;
    height: number;
    reason: string;
  }> = [];

  for (const viewport of viewports) {
    try {
      const capture = await captureViewport(browser, url, viewport, waitMs);
      captures.push({
        preset: viewport.preset,
        width: viewport.width,
        height: viewport.height,
        mimeType: "image/png",
        bytes: capture.bytes,
      });
      imageContent.push({ type: "image", data: capture.data, mimeType: "image/png" });
      warnings.push(...capture.warnings.map((warning) => `${viewport.preset}: ${warning}`));
    } catch (error) {
      failures.push({
        preset: viewport.preset,
        width: viewport.width,
        height: viewport.height,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (captures.length === 0) {
    const reason = failures.map((failure) => `${failure.preset}: ${failure.reason}`).join(" | ");
    return {
      content: [{
        type: "text",
        text: `Visual review capture failed: ${reason}`,
      }],
      isError: true,
      structuredContent: {
        code: "visual_review_capture_failed",
        url,
        browser: browser.name,
        reason,
        failures,
      },
    };
  }

  const order = captures
    .map((capture, index) => `${index + 1}. ${capture.preset} ${capture.width}x${capture.height}`)
    .join(", ");
  const status = failures.length
    ? `Captured ${captures.length} of ${viewports.length} requested screenshot(s); ${failures.length} viewport(s) failed.`
    : `Captured ${captures.length} visual review screenshot(s) with ${browser.name}.`;
  const warningSummary = warnings.length ? ` ${warnings.length} non-fatal browser lifecycle warning(s) were recorded.` : "";

  return {
    content: [
      {
        type: "text",
        text: `${status}${warningSummary} Image order: ${order}. Review the images directly for visual hierarchy, spacing, density, responsive behavior, touch ergonomics, clipping/overflow, and visible regressions. Compare breakpoints rather than judging each image in isolation.`,
      },
      ...imageContent,
    ],
    structuredContent: {
      url,
      browser: browser.name,
      waitMs,
      captures,
      failures,
      warnings,
    },
  };
}
