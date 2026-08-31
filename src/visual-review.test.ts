import { test } from "node:test";
import assert from "node:assert";
import { finalizeToolResponse } from "./server/tool-response-finalizer.js";
import {
  buildVisualReviewBrowserArgs,
  DEFAULT_VISUAL_REVIEW_VIEWPORTS,
  normalizeVisualReviewUrl,
  resolveVisualReviewViewports,
  VISUAL_REVIEW_VIEWPORTS,
} from "./visual-review.js";

test("visual review accepts local development URLs", () => {
  assert.strictEqual(
    normalizeVisualReviewUrl("http://localhost:3000/dashboard#section"),
    "http://localhost:3000/dashboard",
  );
  assert.strictEqual(
    normalizeVisualReviewUrl("http://127.0.0.1:5173/"),
    "http://127.0.0.1:5173/",
  );
});

test("visual review rejects non-local and non-http URLs", () => {
  assert.throws(
    () => normalizeVisualReviewUrl("https://example.com"),
    /limited to local development URLs/,
  );
  assert.throws(
    () => normalizeVisualReviewUrl("file:///tmp/index.html"),
    /only supports http:\/\/ and https:\/\//,
  );
});

test("visual review defaults to the core responsive UX suite", () => {
  assert.deepStrictEqual(DEFAULT_VISUAL_REVIEW_VIEWPORTS, [
    "desktop",
    "laptop",
    "tablet",
    "mobile",
  ]);
  assert.deepStrictEqual(resolveVisualReviewViewports(), [
    VISUAL_REVIEW_VIEWPORTS.desktop,
    VISUAL_REVIEW_VIEWPORTS.laptop,
    VISUAL_REVIEW_VIEWPORTS.tablet,
    VISUAL_REVIEW_VIEWPORTS.mobile,
  ]);
});

test("visual review exposes wider desktop and compact mobile presets", () => {
  assert.deepStrictEqual(resolveVisualReviewViewports(["wide-desktop", "compact-mobile"]), [
    VISUAL_REVIEW_VIEWPORTS["wide-desktop"],
    VISUAL_REVIEW_VIEWPORTS["compact-mobile"],
  ]);
});

test("visual review de-duplicates equal viewport dimensions", () => {
  assert.deepStrictEqual(
    resolveVisualReviewViewports(
      ["mobile", "mobile"],
      [{ name: "same-as-mobile", width: 390, height: 844 }],
    ),
    [{ preset: "same-as-mobile", width: 390, height: 844 }],
  );
});

test("visual review supports bounded custom viewport dimensions", () => {
  assert.deepStrictEqual(
    resolveVisualReviewViewports(["desktop"], [
      { name: "problem-breakpoint", width: 1024, height: 768 },
    ]),
    [
      VISUAL_REVIEW_VIEWPORTS.desktop,
      { preset: "problem-breakpoint", width: 1024, height: 768 },
    ],
  );
  assert.throws(
    () => resolveVisualReviewViewports(["desktop"], [
      { name: "too-small", width: 200, height: 768 },
    ]),
    /width must be an integer between/,
  );
});

test("browser arguments use the requested viewport and screenshot target", () => {
  const args = buildVisualReviewBrowserArgs(
    "http://localhost:3000/",
    VISUAL_REVIEW_VIEWPORTS.mobile,
    "C:/tmp/mobile.png",
    "C:/tmp/profile",
    500,
  );

  assert.ok(args.includes("--window-size=390,844"));
  assert.ok(args.includes("--screenshot=C:/tmp/mobile.png"));
  assert.ok(args.includes("--user-data-dir=C:/tmp/profile"));
  assert.ok(args.includes("--virtual-time-budget=500"));
  assert.strictEqual(args.at(-1), "http://localhost:3000/");
});

test("tool response finalizer preserves image content without duplicating base64 into structured data", () => {
  const image = {
    type: "image" as const,
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
    mimeType: "image/png",
  };

  const result = finalizeToolResponse(
    {
      content: [
        { type: "text", text: "captured desktop" },
        image,
      ],
      structuredContent: {
        captures: [{ preset: "desktop", width: 1440, height: 900 }],
      },
    },
    {
      toolName: "visual_review",
      startedAt: performance.now(),
      inlineOutputCharacters: 12_000,
      hasWidget: false,
    },
  );

  assert.strictEqual(result.content.length, 2);
  assert.strictEqual(result.content[1].type, "image");
  assert.strictEqual(result.content[1].data, image.data);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /iVBOR/);
});
