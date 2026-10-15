import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import {
  getClaudeCustomModelThinkingOptions,
  getClaudeManifestModels,
  normalizeClaudeManifestModelId,
  normalizeClaudeRuntimeModelId as normalizeClaudeManifestRuntimeModelId,
} from "./model-manifest.js";

export const CLAUDE_SETTINGS_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

export function getClaudeModels(claudeCodeVersion?: string): AgentModelDefinition[] {
  return getClaudeManifestModels(claudeCodeVersion);
}

export function resolveConfiguredClaudeModel(model: AgentModelDefinition): AgentModelDefinition {
  if (model.thinkingOptions !== undefined) return model;

  const manifestModelId = normalizeClaudeManifestModelId(model.id);
  const manifestModel = manifestModelId
    ? getClaudeModels().find((candidate) => candidate.id === manifestModelId)
    : undefined;
  if (manifestModel) {
    return manifestModel.thinkingOptions
      ? { ...model, thinkingOptions: manifestModel.thinkingOptions }
      : model;
  }
  return { ...model, thinkingOptions: getClaudeCustomModelThinkingOptions() };
}

export function findClaudeModel(
  modelId: string | null | undefined,
): AgentModelDefinition | undefined {
  const normalizedModelId = normalizeClaudeRuntimeModelId(modelId);
  if (!normalizedModelId) {
    return undefined;
  }
  return getClaudeModels().find((model) => model.id === normalizedModelId);
}

export async function getClaudeModelsWithSettings(
  logger: Logger,
  configDir: string,
  claudeCodeVersion?: string,
  discoveredModelIds: ReadonlySet<string> = new Set(),
): Promise<AgentModelDefinition[]> {
  const hardcodedModels = getClaudeManifestModels(claudeCodeVersion, discoveredModelIds);
  const { models: settingsModels, primaryModelId } = await readClaudeSettingsModels(
    logger,
    configDir,
  );
  if (settingsModels.length === 0) {
    return hardcodedModels;
  }

  const models = [...hardcodedModels];

  for (const model of settingsModels) {
    const existingIndex = models.findIndex((candidate) => candidate.id === model.id);
    if (existingIndex !== -1) {
      const existing = models[existingIndex];
      if (existing?.isSelectable === false) {
        models[existingIndex] = { ...existing, ...model, isSelectable: true };
      }
      continue;
    }
    const manifestModel = getClaudeModels(claudeCodeVersion).find(
      (candidate) => candidate.id === model.id,
    );
    models.push({ ...manifestModel, ...model });
  }

  // The settings file names the model an external switcher (e.g. CC Switch) just
  // selected; make it the catalog default so new agents follow the switch.
  if (primaryModelId && models.some((model) => model.id === primaryModelId)) {
    return models.map((model) => {
      if (model.id === primaryModelId) {
        return { ...model, isDefault: true };
      }
      return model.isDefault ? { ...model, isDefault: false } : model;
    });
  }

  return models;
}

/**
 * The model an external switcher (e.g. CC Switch) just selected, as written into Claude's
 * settings.json. `env.ANTHROPIC_MODEL` is the canonical primary key and wins; the remaining env
 * keys follow in the same precedence the model list uses; the top-level `model` field is the
 * last resort. Null means "no model expressed", never "clear the model" — callers keep the
 * current selection on null.
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

async function readClaudeSettingsModels(
  logger: Logger,
  configDir: string,
): Promise<{ models: AgentModelDefinition[]; primaryModelId: string | null }> {
  const settingsPath = path.join(configDir, "settings.json");

  let parsed: unknown;
  try {
    const rawSettings = await fs.readFile(settingsPath, "utf8");
    parsed = JSON.parse(rawSettings);
  } catch (error) {
    logger.debug({ err: error, settingsPath }, "Failed to read Claude settings models");
    return { models: [], primaryModelId: null };
  }

  if (!isRecord(parsed)) {
    logger.debug({ settingsPath }, "Claude settings.json is not an object");
    return { models: [], primaryModelId: null };
  }

  const primaryModelId = resolveClaudeSettingsModelId(parsed);
  const models: AgentModelDefinition[] = [];
  addSettingsModel(models, parsed.model, "model");

  const env = parsed.env;
  if (env === undefined) {
    return { models, primaryModelId };
  }
  if (!isRecord(env)) {
    logger.debug({ settingsPath }, "Claude settings.json env is not an object");
    return { models, primaryModelId };
  }

  for (const envKey of CLAUDE_SETTINGS_MODEL_ENV_KEYS) {
    addSettingsModel(models, env[envKey], `env.${envKey}`);
  }

  return { models, primaryModelId };
}

function addSettingsModel(
  models: AgentModelDefinition[],
  value: unknown,
  settingsKey: string,
): void {
  if (typeof value !== "string") {
    return;
  }

  const id = value.trim();
  if (id.length === 0 || models.some((model) => model.id === id)) {
    return;
  }

  models.push({
    provider: "claude",
    id,
    label: id,
    description: `From Claude settings.json ${settingsKey}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a runtime model string (from SDK init message) to a known model ID.
 * Handles the `[1m]` suffix that the SDK appends for 1M context sessions.
 */
export function normalizeClaudeRuntimeModelId(value: string | null | undefined): string | null {
  return normalizeClaudeManifestRuntimeModelId(value);
}

/**
 * Placeholder model values Claude Code writes on frames with no real inference behind them.
 * These are not models and must never be displayed.
 */
const CLAUDE_PLACEHOLDER_MODEL_IDS = new Set(["<synthetic>"]);

/**
 * Resolve a model id observed on a Claude assistant frame, for display.
 *
 * Prefers the manifest-normalized id so equivalent spellings collapse (a dated alias and a
 * gateway prefix are the same model), but falls back to the raw string when the manifest does
 * not know it. The fallback matters: Claude Code is an Anthropic-compatible client, so subagents
 * routinely report models that are not Anthropic's — Z.AI GLM ids via `ANTHROPIC_BASE_URL`
 * (docs/custom-providers.md) among them. Manifest-only resolution would blank the model for
 * exactly those users.
 *
 * A `[1m]` suffix is preserved where it names its own manifest entry. Models such as Fable 5
 * that only have a 1M entry normalize the retired suffixed spelling to the canonical ID.
 *
 * Returns null for placeholders and empty values, meaning "not observed".
 */
export function resolveObservedClaudeModelId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || CLAUDE_PLACEHOLDER_MODEL_IDS.has(trimmed)) {
    return null;
  }
  return normalizeClaudeManifestRuntimeModelId(trimmed) ?? trimmed;
}
