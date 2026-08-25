import { describe, it, expect } from "vitest";
import { groupMatches, parseFilter, userMatches } from "../../src/mock/filter-parse.js";
import { parsePermissiveFilter } from "../../src/mock/handlers/users.js";
import { FilterValidationError } from "../../src/scim/errors.js";
import { MockStore } from "../../src/mock/store.js";
import {
  SCHEMA_ENTRA_USER,
  SCHEMA_GROUP_CORE,
  SCHEMA_USER_CORE,
} from "../../src/scim/types.js";

describe("parseFilter", () => {
  it("parses a single eq clause with canonical attr casing", () => {
    const clauses = parseFilter('userName eq "a@x.com"', "user");
    expect(clauses).toEqual([{ attr: "userName", op: "eq", value: "a@x.com" }]);
  });

  it("parses URN-qualified mailNickname", () => {
    const clauses = parseFilter(`${SCHEMA_ENTRA_USER}:mailNickname eq "nick"`, "user");
    expect(clauses[0]!.attr).toBe(`${SCHEMA_ENTRA_USER}:mailNickname`);
  });

  it("parses and-combined clauses", () => {
    const clauses = parseFilter('groups.value eq "g-1" and id eq "u-1"', "user");
    expect(clauses).toHaveLength(2);
  });

  it("rejects or", () => {
    expect(() => parseFilter('userName eq "a" or userName eq "b"', "user")).toThrow(
      FilterValidationError,
    );
  });

  it("rejects unsupported operators", () => {
    expect(() => parseFilter('userName co "a"', "user")).toThrow(FilterValidationError);
  });

  it("rejects attributes outside the allow-list", () => {
    expect(() => parseFilter('displayName eq "a"', "user")).toThrow(
      FilterValidationError,
    );
  });

  it("rejects externalId combined with other clauses", () => {
    expect(() => parseFilter('externalId eq "e-1" and userName eq "a"', "user")).toThrow(
      FilterValidationError,
    );
  });

  it("handles escaped quotes in values", () => {
    const clauses = parseFilter('userName eq "a\\"b"', "user");
    expect(clauses[0]!.value).toBe('a"b');
  });

  it("rejects garbage", () => {
    expect(() => parseFilter("this is not scim", "user")).toThrow(FilterValidationError);
  });
});

describe("userMatches / groupMatches", () => {
  const store = new MockStore();
  const u1 = store.createUser({
    schemas: [SCHEMA_USER_CORE],
    userName: "Adele.V@Contoso.com",
    displayName: "Adele",
    [SCHEMA_ENTRA_USER]: { mailNickname: "adelev" },
  });
  const u2 = store.createUser({
    schemas: [SCHEMA_USER_CORE],
    userName: "b@other.org",
    displayName: "B",
  });
  const g1 = store.createGroup({
    schemas: [SCHEMA_GROUP_CORE],
    displayName: "Engineering",
  });
  store.addGroupMembers(g1.id, [u1.id]);
  const ctx = { groupIdsOfUser: (id: string) => store.groupIdsOfUser(id) };

  it("matches userName eq case-insensitively", () => {
    const clauses = parseFilter('userName eq "adele.v@contoso.com"', "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
    expect(userMatches(u2, clauses, ctx)).toBe(false);
  });

  it("matches ew as endsWith", () => {
    const clauses = parseFilter('userName ew "@contoso.com"', "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
    expect(userMatches(u2, clauses, ctx)).toBe(false);
  });

  it("matches the Entra mailNickname extension attribute", () => {
    const clauses = parseFilter(`${SCHEMA_ENTRA_USER}:mailNickname eq "ADELEV"`, "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
  });

  it("matches groups.value through membership", () => {
    const clauses = parseFilter(`groups.value eq "${g1.id}"`, "user");
    expect(userMatches(u1, clauses, ctx)).toBe(true);
    expect(userMatches(u2, clauses, ctx)).toBe(false);
  });

  it("matches groups by displayName and members.value", () => {
    expect(groupMatches(g1, parseFilter('displayName eq "engineering"', "group"))).toBe(
      true,
    );
    expect(groupMatches(g1, parseFilter(`members.value eq "${u1.id}"`, "group"))).toBe(
      true,
    );
    expect(groupMatches(g1, parseFilter(`members.value eq "${u2.id}"`, "group"))).toBe(
      false,
    );
  });
});

describe("parsePermissiveFilter", () => {
  it("accepts attributes the Entra allow-list rejects", () => {
    // The entire point of compat mode: an RFC-standard client filtering on
    // something Entra does not permit on users.
    expect(() => parseFilter('displayName eq "Ada"', "user")).toThrow(
      FilterValidationError,
    );
    expect(parsePermissiveFilter('displayName eq "Ada"')).toEqual([
      { attr: "displayName", op: "eq", value: "Ada" },
    ]);
  });

  it("parses eq and ew, case-insensitively", () => {
    expect(parsePermissiveFilter('userName EQ "a@x"')).toEqual([
      { attr: "userName", op: "eq", value: "a@x" },
    ]);
    expect(parsePermissiveFilter('userName Ew "@x.com"')).toEqual([
      { attr: "userName", op: "ew", value: "@x.com" },
    ]);
  });

  it("parses clauses joined by and", () => {
    expect(
      parsePermissiveFilter('userName eq "a" and displayName eq "Ada"'),
    ).toHaveLength(2);
  });

  it("unescapes quotes and backslashes in the value", () => {
    expect(parsePermissiveFilter(String.raw`displayName eq "a\"b"`)).toEqual([
      { attr: "displayName", op: "eq", value: 'a"b' },
    ]);
    expect(parsePermissiveFilter(String.raw`displayName eq "a\\b"`)).toEqual([
      { attr: "displayName", op: "eq", value: String.raw`a\b` },
    ]);
  });

  // Regression: an empty filter returned zero clauses, and zero clauses match
  // everything — so `?filter=` listed the whole tenant instead of failing.
  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects a %s filter rather than matching everything", (_label, raw) => {
    expect(() => parsePermissiveFilter(raw)).toThrow(FilterValidationError);
    expect(() => parsePermissiveFilter(raw)).toThrow(/Filter is empty/);
  });

  // Regression: the joiner was an optional group on the clause pattern, so two
  // clauses side by side with nothing between them were read as an `and`.
  it("rejects clauses with no joiner between them", () => {
    expect(() => parsePermissiveFilter('userName eq "a" displayName eq "Ada"')).toThrow(
      /Expected 'and' between filter clauses/,
    );
  });

  it.each([["or"], ["not"]])("rejects '%s' by name", (op) => {
    expect(() => parsePermissiveFilter(`userName eq "a" ${op} userName eq "b"`)).toThrow(
      new RegExp(`Only the 'and' logical operator is supported.*got '${op}'`),
    );
  });

  it.each([
    ["an unterminated quote", 'userName eq "a'],
    ["an unquoted value", "userName eq a"],
    ["an unsupported operator", 'userName co "a"'],
    ["a dangling and", 'userName eq "a" and '],
  ])("rejects %s", (_label, raw) => {
    expect(() => parsePermissiveFilter(raw)).toThrow(FilterValidationError);
  });

  it("produces clauses the matcher can consume", () => {
    const store = new MockStore();
    const user = store.createUser({
      schemas: [SCHEMA_USER_CORE],
      userName: "ada@x.com",
      displayName: "Ada Lovelace",
    });
    const clauses = parsePermissiveFilter('displayName eq "Ada Lovelace"');
    expect(userMatches(user, clauses, { groupIdsOfUser: () => [] })).toBe(true);
  });
});
