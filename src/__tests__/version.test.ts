import { expect, test } from "bun:test";
import { shortServerVersion } from "@/lib/utils/version";

test("keeps the product and the number, drops the build platform", () => {
  expect(
    shortServerVersion(
      "PostgreSQL 16.2 (Debian 16.2-1.pgdg120+1) on aarch64-unknown-linux-gnu, compiled by gcc (Debian 12.2.0-14) 12.2.0, 64-bit",
    ),
  ).toBe("PostgreSQL 16.2");
});

test("a version that is already short survives whole", () => {
  expect(shortServerVersion("PostgreSQL 14.11")).toBe("PostgreSQL 14.11");
});

test("a three-part version keeps every part", () => {
  expect(shortServerVersion("PostgreSQL 9.6.24 on x86_64")).toBe("PostgreSQL 9.6.24");
});

test("something that is not a version string is truncated, not dropped", () => {
  // A fork or a proxy may answer with anything at all. Showing the first words
  // of it beats showing nothing, which reads as "not connected".
  const odd = "some unrecognised server banner that runs on and on";
  expect(shortServerVersion(odd)).toBe("some unrecognised server");
  expect(shortServerVersion("")).toBe("");
});
