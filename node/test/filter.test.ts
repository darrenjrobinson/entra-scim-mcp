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
    expect(() =>
      buildUserFilter({ attr: "displayName", op: "eq", value: "x" }),
    ).toThrow(FilterValidationError);
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
        attr:
          "urn:ietf:params:scim:schemas:extension:Microsoft:Entra:2.0:CustomSecurityAttributes:Project.ProjectName",
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
    expect(() =>
      buildGroupFilter({ attr: "id", op: "ew", value: "x" }),
    ).toThrow(FilterValidationError);
  });

  it("rejects userName on group filter", () => {
    expect(() =>
      buildGroupFilter({ attr: "userName", op: "eq", value: "x" }),
    ).toThrow(FilterValidationError);
  });
});
