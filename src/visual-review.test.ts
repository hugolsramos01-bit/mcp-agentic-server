import { test } from "node:test";
import assert from "node:assert";
import {
  buildVisualReviewBrowserArgs,
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

test("visual review defaults to desktop and mobile", () => {
  assert.deepStrictEqual(resolveVisualReviewViewports(), [
    VISUAL_REVIEW_VIEWPORTS.desktop,
    VISUAL_REVIEW_VIEWPORTS.mobile,
  ]);
});

test("visual review de-duplicates explicitly requested viewports", () => {
  assert.deepStrictEqual(resolveVisualReviewViewports(["mobile", "mobile"]), [
    VISUAL_REVIEW_VIEWPORTS.mobile,
  ]);
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
