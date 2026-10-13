import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import { CLAUDE_SETTINGS_MODEL_ENV_KEYS } from "./models.js";

const SETTINGS_FILE_NAME = "settings.json";
// Coalesces the burst of rename+write events an atomic settings replacement emits.
const DEBOUNCE_MS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The model an external switcher (e.g. CC Switch) just selected, as written into
 * Claude's settings.json. `env.ANTHROPIC_MODEL` is the canonical primary key and
 * wins; the remaining env keys follow in the same precedence the model list uses;
 * the top-level `model` field is the last resort. Null means "no model expressed",
 * never "clear the model" — callers keep the current selection on null.
 */
export function resolveClaudeSettingsModelId(settings: unknown): string | null {
  if (!isRecord(settings)) {
    return null;
  }
  const env = settings.env;
  if (isRecord(env)) {
    for (const key of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
      const value = env[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  if (typeof settings.model === "string" && settings.model.trim().length > 0) {
    return settings.model.trim();
  }
  return null;
}

export interface ClaudeSettingsModelSyncOptions {
  /** Claude config dir (claudeConfigDir); settings.json lives directly inside. */
  configDir: string;
  onChange: (modelId: string) => void;
  logger: Logger;
}

/**
 * Watches Claude's settings.json for external model switches and reports the new
 * model id. The directory is watched, not the file: switchers replace
 * settings.json atomically (write temp + rename), which silently detaches a
 * file-level watcher. Startup reads a baseline without firing onChange, so a
 * daemon restart never rewrites models the user picked inside Paseo.
 */
export class ClaudeSettingsModelSync {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastModelId: string | null = null;
  private disposed = false;

  constructor(private readonly options: ClaudeSettingsModelSyncOptions) {}

  start(): void {
    if (this.watcher || this.disposed) {
      return;
    }
    const settingsPath = path.join(this.options.configDir, SETTINGS_FILE_NAME);
    try {
      this.watcher = watch(this.options.configDir, (_event, filename) => {
        // filename is best-effort (null on some platforms); null means "something changed".
        if (filename !== null && filename !== SETTINGS_FILE_NAME) {
          return;
        }
        this.scheduleRead(settingsPath);
      });
      this.watcher.on("error", (error) => {
        this.options.logger.warn({ err: error }, "claude-settings-model-sync.watcher-error");
      });
    } catch (error) {
      // No config dir means Claude Code was never used on this machine; nothing to sync.
      this.options.logger.debug(
        { err: error, configDir: this.options.configDir },
        "claude-settings-model-sync.watch-unavailable",
      );
      return;
    }
    void this.primeBaseline(settingsPath);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  private async primeBaseline(settingsPath: string): Promise<void> {
    this.lastModelId = await this.readModelId(settingsPath);
  }

  private scheduleRead(settingsPath: string): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.readAndNotify(settingsPath);
    }, DEBOUNCE_MS);
  }

  private async readAndNotify(settingsPath: string): Promise<void> {
    const modelId = await this.readModelId(settingsPath);
    if (this.disposed || modelId === null || modelId === this.lastModelId) {
      return;
    }
    this.lastModelId = modelId;
    this.options.logger.info({ modelId }, "claude-settings-model-sync.model-changed");
    this.options.onChange(modelId);
  }

  private async readModelId(settingsPath: string): Promise<string | null> {
    try {
      return resolveClaudeSettingsModelId(JSON.parse(await readFile(settingsPath, "utf8")));
    } catch {
      // Unreadable or mid-write file: the next event (or the next switch) retries.
      return null;
    }
  }
}
