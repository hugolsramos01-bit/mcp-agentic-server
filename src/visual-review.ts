import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { ToolResponse } from "./pi-tools.js";

const execFileAsync = promisify(execFile);

export type VisualReviewViewport = "desktop" | "mobile";

export interface VisualReviewInput {
  url: string;
  viewports?: VisualReviewViewport[];
  waitMs?: number;
}

interface BrowserExecutable {
  path: string;
  name: string;
}

interface ViewportSpec {
  preset: VisualReviewViewport;
  width: number;
  height: number;
}

export const VISUAL_REVIEW_VIEWPORTS: Record<VisualReviewViewport, ViewportSpec> = {
  desktop: { preset: "desktop", width: 1440, height: 900 },
  mobile: { preset: "mobile", width: 390, height: 844 },
};

const DEFAULT_WAIT_MS = 750;
const MAX_WAIT_MS = 10_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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

export function resolveVisualReviewViewports(
  requested?: VisualReviewViewport[],
): ViewportSpec[] {
  const presets = requested?.length ? requested : ["desktop", "mobile"];
  const unique = [...new Set(presets)];
  return unique.map((preset) => VISUAL_REVIEW_VIEWPORTS[preset]);
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
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--force-device-scale-factor=1",
    `--window-size=${viewport.width},${viewport.height}`,
    `--user-data-dir=${profilePath}`,
    `--virtual-time-budget=${Math.max(waitMs, 1)}`,
    `--screenshot=${screenshotPath}`,
    url,
  ];
}

async function captureViewport(
  browser: BrowserExecutable,
  url: string,
  viewport: ViewportSpec,
  waitMs: number,
): Promise<{ data: string; bytes: number }> {
  const tempDir = await mkdtemp(join(tmpdir(), "agentic-visual-review-"));
  const screenshotPath = join(tempDir, `${viewport.preset}.png`);
  const profilePath = join(tempDir, "profile");

  try {
    const args = buildVisualReviewBrowserArgs(
      url,
      viewport,
      screenshotPath,
      profilePath,
      waitMs,
    );

    await execFileAsync(browser.path, args, {
      timeout: Math.max(15_000, waitMs + 15_000),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    if (!existsSync(screenshotPath)) {
      throw new Error(`${browser.name} finished without producing a screenshot.`);
    }

    const image = readFileSync(screenshotPath);
    if (image.length === 0) {
      throw new Error(`${browser.name} produced an empty screenshot.`);
    }

    return { data: image.toString("base64"), bytes: image.length };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function visualReviewTool(input: VisualReviewInput): Promise<ToolResponse> {
  const url = normalizeVisualReviewUrl(input.url);
  const waitMs = normalizeWaitMs(input.waitMs);
  const viewports = resolveVisualReviewViewports(input.viewports);
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
    preset: VisualReviewViewport;
    width: number;
    height: number;
    mimeType: "image/png";
    bytes: number;
  }> = [];
  const imageContent: Array<{ type: "image"; data: string; mimeType: string }> = [];

  try {
    for (const viewport of viewports) {
      const capture = await captureViewport(browser, url, viewport, waitMs);
      captures.push({
        preset: viewport.preset,
        width: viewport.width,
        height: viewport.height,
        mimeType: "image/png",
        bytes: capture.bytes,
      });
      imageContent.push({ type: "image", data: capture.data, mimeType: "image/png" });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
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
      },
    };
  }

  const order = captures
    .map((capture, index) => `${index + 1}. ${capture.preset} ${capture.width}x${capture.height}`)
    .join(", ");

  return {
    content: [
      {
        type: "text",
        text: `Captured ${captures.length} visual review screenshot(s) with ${browser.name}. Image order: ${order}. Review the images directly for layout, hierarchy, spacing, responsiveness, and visible regressions.`,
      },
      ...imageContent,
    ],
    structuredContent: {
      url,
      browser: browser.name,
      waitMs,
      captures,
    },
  };
}
