import { describe, it, expect } from "vitest";
import {
  assertRawQueryHasNoWhitespaceAroundEquals,
  buildQueryString,
} from "../src/scim/query.js";

describe("buildQueryString", () => {
  it("returns empty string when params are undefined", () => {
    expect(buildQueryString(undefined)).toBe("");
  });

  it("returns empty string when all values are undefined or null", () => {
    expect(buildQueryString({ a: undefined, b: null })).toBe("");
  });

  it("encodes key and value with no whitespace around =", () => {
    expect(buildQueryString({ count: 50 })).toBe("?count=50");
  });

  it("URL-encodes special characters in values", () => {
    expect(
      buildQueryString({ filter: 'userName eq "x@y.com"' }),
    ).toBe("?filter=userName%20eq%20%22x%40y.com%22");
  });

  it("joins multiple params with &", () => {
    const q = buildQueryString({ count: 10, cursor: "abc" });
    expect(q).toBe("?count=10&cursor=abc");
  });

  it("throws if a key has leading whitespace", () => {
    expect(() => buildQueryString({ " filter": "x" })).toThrow(/whitespace/);
  });

  it("throws if a key has trailing whitespace", () => {
    expect(() => buildQueryString({ "filter ": "x" })).toThrow(/whitespace/);
  });

  it("throws if a value has surrounding whitespace", () => {
    expect(() => buildQueryString({ filter: " userName eq \"x\"" })).toThrow(
      /whitespace/,
    );
  });
});

describe("assertRawQueryHasNoWhitespaceAroundEquals", () => {
  it("accepts a clean encoded query", () => {
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals(
        "filter=userName%20eq%20%22x%40y.com%22&count=10",
      ),
    ).not.toThrow();
  });

  it("rejects literal whitespace around =", () => {
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals('filter =userName eq "x"'),
    ).toThrow(/whitespace/i);
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals('filter= userName eq "x"'),
    ).toThrow(/whitespace/i);
  });

  it("rejects percent-encoded whitespace around =", () => {
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals("filter%20=x"),
    ).toThrow(/whitespace/i);
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals("filter=%20x"),
    ).toThrow(/whitespace/i);
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals("count=%0910"),
    ).toThrow(/whitespace/i);
  });

  it("allows encoded spaces away from =", () => {
    expect(() =>
      assertRawQueryHasNoWhitespaceAroundEquals("filter=a%20and%20b"),
    ).not.toThrow();
  });
});
