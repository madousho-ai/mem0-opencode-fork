import { describe, expect, test } from "bun:test";
import { scopeSearchFilters, scopeWriteParams, asScope, resolveDefaultScope } from "./scope";

describe("memory scope (self-hosted)", () => {
  test("project scope = current user_id", () => {
    expect(scopeSearchFilters("project", "u", "run")).toEqual({ user_id: "u" });
    expect(scopeWriteParams("project", "u", "run")).toEqual({ user_id: "u" });
  });

  test("session scope adds run_id", () => {
    expect(scopeSearchFilters("session", "u", "run")).toEqual({
      user_id: "u",
      run_id: "run",
    });
    expect(scopeWriteParams("session", "u", "run")).toEqual({
      user_id: "u",
      run_id: "run",
    });
  });

  test("global scope drops user_id (server-wide)", () => {
    expect(scopeSearchFilters("global", "u", "run")).toEqual({});
    expect(scopeWriteParams("global", "u", "run")).toEqual({});
  });

  test("default scope is project when settings are absent", () => {
    expect(resolveDefaultScope(null)).toBe("project");
    expect(resolveDefaultScope(undefined)).toBe("project");
    expect(resolveDefaultScope({})).toBe("project");
  });

  test("default scope reads default_scope from settings", () => {
    expect(resolveDefaultScope({ default_scope: "session" })).toBe("session");
    expect(resolveDefaultScope({ default_scope: "global" })).toBe("global");
    expect(resolveDefaultScope({ default_scope: "project" })).toBe("project");
  });

  test("default scope normalizes an invalid default_scope to project", () => {
    expect(resolveDefaultScope({ default_scope: "nonsense" })).toBe("project");
    expect(resolveDefaultScope({ default_scope: 42 })).toBe("project");
  });

  test("asScope normalizes unknown values to project", () => {
    expect(asScope("global")).toBe("global");
    expect(asScope("session")).toBe("session");
    expect(asScope("project")).toBe("project");
    expect(asScope("nonsense")).toBe("project");
    expect(asScope(undefined)).toBe("project");
  });
});
