import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeSettingsModelSync, resolveClaudeSettingsModelId } from "./settings-model-sync.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeConfigDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-settings-sync-"));
  tempDirs.push(dir);
  return dir;
}

/** Replace settings.json the way external switchers do: write temp, rename over. */
async function writeSettingsAtomically(configDir: string, settings: unknown): Promise<void> {
  const target = path.join(configDir, "settings.json");
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(settings), "utf8");
  await fs.rename(temp, target);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition not met before timeout");
}

describe("resolveClaudeSettingsModelId", () => {
  it("prefers env.ANTHROPIC_MODEL over the other env keys and the top-level model", () => {
    expect(
      resolveClaudeSettingsModelId({
        model: "top-level",
        env: {
          ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-value",
          ANTHROPIC_MODEL: " primary-value ",
        },
      }),
    ).toBe("primary-value");
  });

  it("falls back through the env key order", () => {
    expect(
      resolveClaudeSettingsModelId({ env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-value" } }),
    ).toBe("opus-value");
    expect(resolveClaudeSettingsModelId({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "h" } })).toBe("h");
  });

  it("falls back to the top-level model field", () => {
    expect(resolveClaudeSettingsModelId({ model: "claude-opus-5", env: {} })).toBe("claude-opus-5");
    expect(resolveClaudeSettingsModelId({ model: "claude-opus-5" })).toBe("claude-opus-5");
  });

  it("returns null when no model is expressed", () => {
    expect(resolveClaudeSettingsModelId(null)).toBeNull();
    expect(resolveClaudeSettingsModelId("nope")).toBeNull();
    expect(resolveClaudeSettingsModelId({})).toBeNull();
    expect(resolveClaudeSettingsModelId({ env: {} })).toBeNull();
    expect(resolveClaudeSettingsModelId({ env: { ANTHROPIC_MODEL: "   " } })).toBeNull();
    expect(resolveClaudeSettingsModelId({ env: "not-an-object", model: 42 })).toBeNull();
  });
});

describe("ClaudeSettingsModelSync", () => {
  it("fires onChange when an external switcher replaces settings.json", async () => {
    const configDir = await makeConfigDir();
    await writeSettingsAtomically(configDir, { env: { ANTHROPIC_MODEL: "model-a" } });
    const onChange = vi.fn();
    const sync = new ClaudeSettingsModelSync({
      configDir,
      onChange,
      logger: createTestLogger(),
    });
    sync.start();
    try {
      // Baseline: the model that was already there must not fire on startup.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(onChange).not.toHaveBeenCalled();

      await writeSettingsAtomically(configDir, { env: { ANTHROPIC_MODEL: "model-b" } });
      await waitFor(() => onChange.mock.calls.length === 1);
      expect(onChange).toHaveBeenCalledWith("model-b");
    } finally {
      sync.dispose();
    }
  });

  it("ignores rewrites that keep the same model and non-settings files", async () => {
    const configDir = await makeConfigDir();
    await writeSettingsAtomically(configDir, { env: { ANTHROPIC_MODEL: "model-a" } });
    const onChange = vi.fn();
    const sync = new ClaudeSettingsModelSync({
      configDir,
      onChange,
      logger: createTestLogger(),
    });
    sync.start();
    try {
      await writeSettingsAtomically(configDir, { env: { ANTHROPIC_MODEL: "model-a" } });
      await fs.writeFile(path.join(configDir, "unrelated.txt"), "noise", "utf8");
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      sync.dispose();
    }
  });

  it("stops reporting after dispose", async () => {
    const configDir = await makeConfigDir();
    const onChange = vi.fn();
    const sync = new ClaudeSettingsModelSync({
      configDir,
      onChange,
      logger: createTestLogger(),
    });
    sync.start();
    sync.dispose();
    await writeSettingsAtomically(configDir, { env: { ANTHROPIC_MODEL: "model-late" } });
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing when the config dir does not exist", async () => {
    const missing = path.join(await makeConfigDir(), "not-created");
    const onChange = vi.fn();
    const sync = new ClaudeSettingsModelSync({
      configDir: missing,
      onChange,
      logger: createTestLogger(),
    });
    expect(() => sync.start()).not.toThrow();
    sync.dispose();
    expect(onChange).not.toHaveBeenCalled();
  });
});
