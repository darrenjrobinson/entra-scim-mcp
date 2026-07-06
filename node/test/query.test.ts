import { describe, it, expect } from "vitest";
import { buildQueryString } from "../src/scim/query.js";

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
