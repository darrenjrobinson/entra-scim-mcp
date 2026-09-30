import { describe, it, expect } from "vitest";
import { buildUserFilter, buildGroupFilter } from "../src/scim/filter.js";
import { FilterValidationError } from "../src/scim/errors.js";

describe("buildUserFilter", () => {
  it("returns undefined for undefined or empty input", () => {
    expect(buildUserFilter(undefined)).toBeUndefined();
    expect(buildUserFilter([])).toBeUndefined();
  });

  it("renders a single eq clause with canonical casing", () => {
    expect(buildUserFilter({ attr: "username", op: "eq", value: "x@y.com" })).toBe(
      'userName eq "x@y.com"',
    );
  });

  it("renders mailNickname with the Entra extension URN prefix", () => {
    const f = buildUserFilter({ attr: "mailNickname", op: "eq", value: "abc" });
    expect(f).toBe(
      'urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User:mailNickname eq "abc"',
    );
  });

  it("ANDs multiple clauses", () => {
    const f = buildUserFilter([
      { attr: "groups.value", op: "eq", value: "g-1" },
      { attr: "id", op: "eq", value: "u-1" },
    ]);
    expect(f).toBe('groups.value eq "g-1" and id eq "u-1"');
  });

  it("supports ew on userName", () => {
    expect(buildUserFilter({ attr: "userName", op: "ew", value: "@y.com" })).toBe(
      'userName ew "@y.com"',
    );
  });

  it("throws FilterValidationError (not TypeError) for a non-string attr", () => {
    expect(() =>
      buildUserFilter([{ attr: undefined as never, op: "eq", value: "x" }]),
    ).toThrow(FilterValidationError);
  });

  it("rejects unsupported attr for eq", () => {
    expect(() => buildUserFilter({ attr: "displayName", op: "eq", value: "x" })).toThrow(
      FilterValidationError,
    );
  });

  it("rejects ew on id (not in allow-list)", () => {
    expect(() => buildUserFilter({ attr: "id", op: "ew", value: "x" })).toThrow(
      FilterValidationError,
    );
  });

  it("rejects unsupported operator", () => {
    expect(() =>
      buildUserFilter({ attr: "userName", op: "co" as never, value: "x" }),
    ).toThrow(FilterValidationError);
  });

  it("rejects externalId combined with another clause", () => {
    expect(() =>
      buildUserFilter([
        { attr: "externalId", op: "eq", value: "12345" },
        { attr: "userName", op: "eq", value: "x@y" },
      ]),
    ).toThrow(FilterValidationError);
  });

  it("escapes embedded quotes in values", () => {
    const f = buildUserFilter({
      attr: "userName",
      op: "eq",
      value: 'has"quote',
    });
    expect(f).toBe('userName eq "has\\"quote"');
  });

  it("rejects Custom Security Attributes in filter", () => {
    expect(() =>
      buildUserFilter({
        attr: "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Project.ProjectName",
        op: "eq",
        value: "x",
      }),
    ).toThrow(FilterValidationError);
  });
});

describe("buildGroupFilter", () => {
  it("supports eq on displayName/id/members.value", () => {
    expect(buildGroupFilter({ attr: "displayName", op: "eq", value: "Sales" })).toBe(
      'displayName eq "Sales"',
    );
    expect(buildGroupFilter({ attr: "members.value", op: "eq", value: "u-1" })).toBe(
      'members.value eq "u-1"',
    );
  });

  it("supports ew on displayName only", () => {
    expect(buildGroupFilter({ attr: "displayName", op: "ew", value: "Team" })).toBe(
      'displayName ew "Team"',
    );
    expect(() => buildGroupFilter({ attr: "id", op: "ew", value: "x" })).toThrow(
      FilterValidationError,
    );
  });

  it("rejects userName on group filter", () => {
    expect(() => buildGroupFilter({ attr: "userName", op: "eq", value: "x" })).toThrow(
      FilterValidationError,
    );
  });
});

describe("Sep 2026 filter additions", () => {
  it("emits active unquoted and normalises its case", () => {
    expect(buildUserFilter({ attr: "active", op: "eq", value: "TRUE" })).toBe(
      "active eq true",
    );
  });

  it("rejects a non-boolean value for a boolean attribute", () => {
    expect(() => buildUserFilter({ attr: "active", op: "eq", value: "yes" })).toThrow(
      FilterValidationError,
    );
  });

  it("renders ownedGroups.value with the Entra user URN", () => {
    expect(buildUserFilter({ attr: "ownedGroups.value", op: "eq", value: "g-1" })).toBe(
      'urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User:ownedGroups.value eq "g-1"',
    );
  });

  it("wraps a negated ew clause in not(...)", () => {
    expect(
      buildUserFilter([
        { attr: "mailNickname", op: "ew", value: "-admin", not: true },
        { attr: "userName", op: "ew", value: "@contoso.com" },
      ]),
    ).toBe(
      'not(urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:User:mailNickname ew "-admin") and userName ew "@contoso.com"',
    );
  });

  it("rejects not on eq, and on group filters", () => {
    expect(() =>
      buildUserFilter({ attr: "userName", op: "eq", value: "x", not: true }),
    ).toThrow(FilterValidationError);
    expect(() =>
      buildGroupFilter({ attr: "displayName", op: "ew", value: "x", not: true }),
    ).toThrow(FilterValidationError);
  });

  it("accepts not: false as a plain clause", () => {
    expect(buildUserFilter({ attr: "userName", op: "eq", value: "x", not: false })).toBe(
      'userName eq "x"',
    );
  });

  it("supports the new group eq attributes", () => {
    expect(buildGroupFilter({ attr: "securityEnabled", op: "eq", value: "true" })).toBe(
      "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:Group:securityEnabled eq true",
    );
    expect(buildGroupFilter({ attr: "mailEnabled", op: "eq", value: "False" })).toBe(
      "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:Group:mailEnabled eq false",
    );
    expect(buildGroupFilter({ attr: "owners.value", op: "eq", value: "u-1" })).toBe(
      'urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:Group:owners.value eq "u-1"',
    );
  });
});
