import { watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getSkillSettingsPaths,
  loadSkillSettings,
  normalizeSkillIdentifier,
  normalizeSkillName,
  normalizeSkillSettingsLayer,
  saveSkillSettingsLayer,
  type SkillSettingsLayer,
  type SkillSettingsState
} from "./config.js";
import { loadBundledSkills } from "./bundled.js";
import {
  compareDiscoveredSkills,
  discoverSkillsFromRoot,
  findSkillByName,
  normalizeSkillName as normalizeDiscoveredSkillName
} from "./loader.js";
import {
  extractSkillMentions,
  formatPromptEntry,
  toPromptEntry
} from "./render.js";
import type {
  SkillActivationContext,
  SkillCatalog,
  SkillConfigMutationResult,
  SkillConfigTarget,
  SkillDescriptor,
  SkillDiscoveryRoots,
  SkillMentionResolution,
  SkillPromptContext,
  SkillReference,
  SkillServiceOptions
} from "./types.js";

const DEFAULT_PROMPT_CHAR_BUDGET = 8_000;
const SOURCE_PRIORITY: Record<SkillDescriptor["source"], number> = {
  project: 0,
  user: 1,
  bundled: 2
};

interface CachedSkillCatalog {
  skills: SkillDescriptor[];
  disabledSkills: SkillDescriptor[];
  duplicateWarnings: string[];
  disabledWarnings: string[];
  configWarnings: string[];
}

export class SkillManager {
  private readonly workspaceRoot: string;
  private readonly userHomeDirectory: string;
  private readonly promptCharBudget: number;
  private readonly watchEnabled: boolean;
  private readonly roots: SkillDiscoveryRoots;
  private readonly watcherPaths: string[];
  private readonly settingsPaths: ReturnType<typeof getSkillSettingsPaths>;
  private readonly watchers: FSWatcher[] = [];
  private watchersStarted = false;
  private cacheDirty = true;
  private refreshPromise?: Promise<CachedSkillCatalog>;
  private cachedCatalog?: CachedSkillCatalog;

  constructor(options: SkillServiceOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.userHomeDirectory = path.resolve(options.userHomeDirectory ?? os.homedir());
    this.promptCharBudget = options.promptCharBudget ?? DEFAULT_PROMPT_CHAR_BUDGET;
    this.watchEnabled = options.watch === true;
    this.roots = {
      projectRoot: path.join(this.workspaceRoot, ".alyce", "skills"),
      userRoot: path.join(this.userHomeDirectory, ".alyce", "skills")
    };
    this.settingsPaths = getSkillSettingsPaths(this.workspaceRoot, this.userHomeDirectory);
    this.watcherPaths = buildWatcherPaths(this.workspaceRoot, this.userHomeDirectory);
  }

  getRoots(): SkillDiscoveryRoots {
    return { ...this.roots };
  }

  async discoverSkills(options: {
    activationContext?: SkillActivationContext;
  } = {}): Promise<SkillCatalog> {
    const catalog = await this.getCachedCatalog();
    return {
      skills: sortSkillsForContext(catalog.skills, options.activationContext),
      disabledSkills: [...catalog.disabledSkills].sort(compareDiscoveredSkills),
      duplicateWarnings: [...catalog.duplicateWarnings],
      disabledWarnings: [...catalog.disabledWarnings],
      configWarnings: [...catalog.configWarnings]
    };
  }

  async findSkillByName(
    name: string,
    options: {
      includeDisabled?: boolean;
    } = {}
  ): Promise<{
    skill?: SkillDescriptor;
    catalog: SkillCatalog;
    disabled: boolean;
  }> {
    const catalog = await this.discoverSkills();
    const active = findSkillByName(catalog.skills, name);
    if (active) {
      return {
        skill: active,
        catalog,
        disabled: false
      };
    }

    if (!options.includeDisabled) {
      return {
        skill: undefined,
        catalog,
        disabled: false
      };
    }

    const disabled = findSkillByName(catalog.disabledSkills, name);
    return {
      skill: disabled,
      catalog,
      disabled: disabled !== undefined
    };
  }

  async buildPromptContext(options: {
    charBudget?: number;
    activationContext?: SkillActivationContext;
  } = {}): Promise<SkillPromptContext> {
    const catalog = await this.discoverSkills({
      activationContext: options.activationContext
    });
    const charBudget = options.charBudget ?? this.promptCharBudget;
    const selected = [];
    let usedChars = 0;

    for (const skill of catalog.skills) {
      const entry = toPromptEntry(skill);
      const serialized = formatPromptEntry(entry);
      const additionalChars = selected.length === 0
        ? serialized.length
        : serialized.length + 1;

      if (selected.length > 0 && usedChars + additionalChars > charBudget) {
        break;
      }

      selected.push(entry);
      usedChars += additionalChars;
    }

    return {
      skills: selected,
      totalCount: catalog.skills.length,
      truncatedCount: Math.max(0, catalog.skills.length - selected.length),
      duplicateWarnings: catalog.duplicateWarnings,
      charBudget
    };
  }

  async resolveMentionedSkills(input: string): Promise<SkillMentionResolution> {
    const mentions = extractSkillMentions(input);
    if (mentions.length === 0) {
      return {
        mentions: [],
        resolvedSkills: [],
        unresolvedMentions: [],
        disabledMentions: [],
        duplicateWarnings: [],
        disabledWarnings: []
      };
    }

    const catalog = await this.discoverSkills();
    const resolvedSkills: SkillDescriptor[] = [];
    const unresolvedMentions: string[] = [];
    const disabledMentions: string[] = [];

    for (const mention of mentions) {
      const active = findSkillByName(catalog.skills, mention);
      if (active) {
        resolvedSkills.push(active);
        continue;
      }

      const disabled = findSkillByName(catalog.disabledSkills, mention);
      if (disabled) {
        disabledMentions.push(mention);
        continue;
      }

      unresolvedMentions.push(mention);
    }

    return {
      mentions,
      resolvedSkills,
      unresolvedMentions,
      disabledMentions,
      duplicateWarnings: catalog.duplicateWarnings,
      disabledWarnings: catalog.disabledWarnings
    };
  }

  async refresh(): Promise<SkillCatalog> {
    this.cacheDirty = true;
    return this.discoverSkills();
  }

  async setSkillEnabled(
    reference: SkillReference,
    enabled: boolean,
    target: SkillConfigTarget
  ): Promise<SkillConfigMutationResult> {
    const settingsState = await this.loadSettingsState();
    const layer = cloneSettingsLayer(target === "project" ? settingsState.project : settingsState.user);
    const filePath = target === "project" ? settingsState.projectPath : settingsState.userPath;

    if (reference.kind === "bundled") {
      const before = layer.disableBundledSkills;
      layer.disableBundledSkills = enabled ? false : true;
      await saveSkillSettingsLayer(this.settingsPaths, target, normalizeSkillSettingsLayer(layer));
      this.cacheDirty = true;
      const catalog = await this.discoverSkills();
      return {
        changed: before !== layer.disableBundledSkills,
        target,
        configPath: filePath,
        catalog,
        message: enabled
          ? `Bundled skills are enabled in ${target} config.`
          : `Bundled skills are disabled in ${target} config.`
      };
    }

    const lookup = await this.resolveReference(reference);
    if (reference.kind === "name" && !lookup.skill) {
      throw new Error(`Unknown skill: ${reference.value}`);
    }

    const identifier = lookup.identifier ??
      (reference.kind === "id" || reference.kind === "path" ? reference.value : undefined);
    if (!identifier) {
      throw new Error("Skill reference did not resolve to a stable identifier.");
    }

    const normalizedIdentifier = normalizeSkillIdentifier(identifier);
    if (enabled) {
      removeValue(layer.disabledSkillIds, normalizedIdentifier);
      removeValue(layer.disabledSkillPaths, normalizedIdentifier);
      if (lookup.skill) {
        removeValue(layer.disabledSkillIds, normalizeSkillIdentifier(lookup.skill.id));
        removeValue(layer.disabledSkillPaths, normalizeSkillIdentifier(lookup.skill.skillFilePath));
        removeValue(layer.disabledSkillNames, normalizeSkillName(lookup.skill.name));
      }
    } else if (reference.kind === "path") {
      pushUnique(layer.disabledSkillPaths, normalizedIdentifier);
    } else if (reference.kind === "id") {
      pushUnique(layer.disabledSkillIds, normalizedIdentifier);
    } else if (lookup.skill) {
      pushUnique(layer.disabledSkillIds, normalizeSkillIdentifier(lookup.skill.id));
    }

    await saveSkillSettingsLayer(this.settingsPaths, target, normalizeSkillSettingsLayer(layer));
    this.cacheDirty = true;
    const catalog = await this.discoverSkills();
    const requestedLabel = lookup.skill?.name ?? reference.value;
    const activeAfter = lookup.skill
      ? findSkillByName(catalog.skills, lookup.skill.name)
      : undefined;
    const disabledAfter = lookup.skill
      ? findSkillByName(catalog.disabledSkills, lookup.skill.name)
      : undefined;

    return {
      changed: true,
      target,
      configPath: filePath,
      catalog,
      message: enabled
        ? (activeAfter
          ? `Enabled skill '${requestedLabel}' in ${target} config.`
          : `Updated ${target} config for '${requestedLabel}', but another scope still disables it.`)
        : (disabledAfter || !lookup.skill
          ? `Disabled skill '${requestedLabel}' in ${target} config.`
          : `Updated ${target} config for '${requestedLabel}'.`)
    };
  }

  close() {
    for (const watcher of this.watchers) {
      watcher.close();
    }

    this.watchers.length = 0;
    this.watchersStarted = false;
  }

  private async getCachedCatalog(): Promise<CachedSkillCatalog> {
    if (!this.cacheDirty && this.cachedCatalog) {
      return this.cachedCatalog;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    if (this.watchEnabled) {
      this.ensureWatchers();
    }

    this.refreshPromise = this.loadCatalog()
      .then((catalog) => {
        this.cachedCatalog = catalog;
        this.cacheDirty = false;
        this.refreshPromise = undefined;
        return catalog;
      })
      .catch((error) => {
        this.refreshPromise = undefined;
        throw error;
      });
    return this.refreshPromise;
  }

  private ensureWatchers() {
    if (this.watchersStarted) {
      return;
    }

    this.watchersStarted = true;
    for (const watchPath of this.watcherPaths) {
      try {
        const watcher = watch(watchPath, { persistent: false }, () => {
          this.cacheDirty = true;
        });
        this.watchers.push(watcher);
      } catch {
        // Best-effort only. The manager still supports explicit refresh and on-demand scans.
      }
    }
  }

  private async loadCatalog(): Promise<CachedSkillCatalog> {
    const [projectSkills, userSkills] = await Promise.all([
      discoverSkillsFromRoot(this.roots.projectRoot, "project"),
      discoverSkillsFromRoot(this.roots.userRoot, "user")
    ]);
    const bundledSkills = loadBundledSkills();

    let settingsState: SkillSettingsState;
    const configWarnings: string[] = [];
    try {
      settingsState = await loadSkillSettings(this.settingsPaths);
    } catch (error) {
      settingsState = {
        project: normalizeSkillSettingsLayer(),
        user: normalizeSkillSettingsLayer(),
        effective: normalizeSkillSettingsLayer(),
        projectPath: this.settingsPaths.projectPath,
        userPath: this.settingsPaths.userPath
      };
      configWarnings.push(
        `Failed to load skill config: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const rawSkills = [...bundledSkills, ...userSkills, ...projectSkills];
    const disabledWarnings: string[] = [];
    const disabledSkills: SkillDescriptor[] = [];
    const enabledSkills: SkillDescriptor[] = [];

    for (const skill of rawSkills) {
      const disabledReason = resolveDisabledReason(skill, settingsState);
      if (disabledReason) {
        disabledSkills.push({
          ...skill,
          disabledReason
        });
        disabledWarnings.push(`Skill '${skill.name}' is disabled: ${disabledReason}`);
        continue;
      }

      enabledSkills.push(skill);
    }

    const merged = mergeActiveSkills(enabledSkills);
    return {
      skills: merged.skills,
      disabledSkills,
      duplicateWarnings: merged.duplicateWarnings,
      disabledWarnings,
      configWarnings
    };
  }

  private async resolveReference(reference: Exclude<SkillReference, { kind: "bundled" }>) {
    const catalog = await this.discoverSkills();
    const allSkills = [...catalog.skills, ...catalog.disabledSkills];

    if (reference.kind === "name") {
      const skill = findSkillByName(allSkills, reference.value);
      return {
        skill,
        identifier: skill?.id
      };
    }

    if (reference.kind === "id") {
      const normalized = normalizeSkillIdentifier(reference.value);
      const skill = allSkills.find((entry) => normalizeSkillIdentifier(entry.id) === normalized);
      return {
        skill,
        identifier: normalized
      };
    }

    const normalized = normalizeSkillIdentifier(reference.value);
    const skill = allSkills.find((entry) => normalizeSkillIdentifier(entry.skillFilePath) === normalized);
    return {
      skill,
      identifier: normalized
    };
  }

  private async loadSettingsState() {
    return loadSkillSettings(this.settingsPaths);
  }
}

export function extractPathMentions(input: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /`([^`\r\n]+)`/g,
    /"([^"\r\n]+)"/g,
    /'([^'\r\n]+)'/g,
    /(?:^|[\s(])([A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._@-]+)+|[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)(?=$|[\s),:;])/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      const candidate = normalizePathCandidate(match[1] ?? "");
      if (candidate) {
        candidates.add(candidate);
      }
    }
  }

  return [...candidates];
}

function buildWatcherPaths(workspaceRoot: string, userHomeDirectory: string) {
  return [
    workspaceRoot,
    path.join(workspaceRoot, ".alyce"),
    path.join(workspaceRoot, ".agents"),
    userHomeDirectory,
    path.join(userHomeDirectory, ".alyce")
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function mergeActiveSkills(skills: SkillDescriptor[]) {
  const selected = new Map<string, SkillDescriptor>();
  const duplicateWarnings: string[] = [];

  for (const skill of skills) {
    const existing = selected.get(skill.normalizedName);
    if (!existing) {
      selected.set(skill.normalizedName, skill);
      continue;
    }

    if (SOURCE_PRIORITY[skill.source] < SOURCE_PRIORITY[existing.source]) {
      selected.set(skill.normalizedName, {
        ...skill,
        duplicatePaths: [existing.skillFilePath, ...skill.duplicatePaths]
      });
      duplicateWarnings.push(
        `${capitalizeSource(skill.source)} skill '${skill.name}' overrides ${existing.source} skill at ${existing.skillFilePath}.`
      );
      continue;
    }

    existing.duplicatePaths.push(skill.skillFilePath);
    duplicateWarnings.push(
      `Duplicate skill '${skill.name}' ignored at ${skill.skillFilePath}; using ${existing.skillFilePath}.`
    );
  }

  return {
    skills: [...selected.values()].sort(compareDiscoveredSkills),
    duplicateWarnings
  };
}

function resolveDisabledReason(skill: SkillDescriptor, settingsState: SkillSettingsState) {
  const effective = settingsState.effective;
  if (skill.source === "bundled" && effective.disableBundledSkills) {
    return "bundled skills are disabled by config";
  }

  if (effective.disabledSkillIds.includes(normalizeSkillIdentifier(skill.id))) {
    return "disabled by skill id";
  }

  if (effective.disabledSkillPaths.includes(normalizeSkillIdentifier(skill.skillFilePath))) {
    return "disabled by skill path";
  }

  if (effective.disabledSkillNames.includes(normalizeDiscoveredSkillName(skill.name))) {
    return "disabled by skill name";
  }

  return undefined;
}

function sortSkillsForContext(skills: SkillDescriptor[], activationContext?: SkillActivationContext) {
  if (!activationContext) {
    return [...skills].sort(comparePromptOrder);
  }

  const referenced = (activationContext.referencedPaths ?? []).map(normalizePathCandidate).filter(Boolean);
  const opened = (activationContext.openedPaths ?? []).map(normalizePathCandidate).filter(Boolean);

  return [...skills].sort((left, right) => {
    const leftScore = computeActivationScore(left, referenced, opened);
    const rightScore = computeActivationScore(right, referenced, opened);
    return rightScore - leftScore ||
      comparePromptOrder(left, right);
  });
}

function computeActivationScore(
  skill: SkillDescriptor,
  referencedPaths: string[],
  openedPaths: string[]
) {
  if (skill.activationPaths.length === 0) {
    return 0;
  }

  let score = 0;
  for (const pattern of skill.activationPaths) {
    if (referencedPaths.some((candidate) => matchesActivationPattern(pattern, candidate))) {
      score += 10;
      continue;
    }

    if (openedPaths.some((candidate) => matchesActivationPattern(pattern, candidate))) {
      score += 4;
    }
  }

  return score;
}

function matchesActivationPattern(pattern: string, candidate: string) {
  const normalizedPattern = normalizePathCandidate(pattern);
  if (!normalizedPattern) {
    return false;
  }

  if (!normalizedPattern.includes("/") && !normalizedPattern.includes("*")) {
    return candidate === normalizedPattern || candidate.endsWith(`/${normalizedPattern}`);
  }

  return globPatternToRegExp(normalizedPattern).test(candidate);
}

function globPatternToRegExp(pattern: string) {
  let regexBody = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      regexBody += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      regexBody += "[^/]*";
      continue;
    }

    if (char === "?") {
      regexBody += "[^/]";
      continue;
    }

    regexBody += escapeRegexChar(char ?? "");
  }

  return new RegExp(`^${regexBody}$`, "i");
}

function normalizePathCandidate(value: string) {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^[A-Z]:/i, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");

  return normalized ? normalized.toLowerCase() : "";
}

function comparePromptOrder(left: SkillDescriptor, right: SkillDescriptor) {
  return SOURCE_PRIORITY[left.source] - SOURCE_PRIORITY[right.source] ||
    left.name.localeCompare(right.name) ||
    left.skillFilePath.localeCompare(right.skillFilePath);
}

function capitalizeSource(source: SkillDescriptor["source"]) {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

function cloneSettingsLayer(layer: SkillSettingsLayer): SkillSettingsLayer {
  return {
    disabledSkillIds: [...layer.disabledSkillIds],
    disabledSkillNames: [...layer.disabledSkillNames],
    disabledSkillPaths: [...layer.disabledSkillPaths],
    disableBundledSkills: layer.disableBundledSkills
  };
}

function removeValue(values: string[], value: string) {
  const normalized = normalizeSkillIdentifier(value);
  const index = values.findIndex((entry) => normalizeSkillIdentifier(entry) === normalized);
  if (index >= 0) {
    values.splice(index, 1);
  }
}

function pushUnique(values: string[], value: string) {
  const normalized = normalizeSkillIdentifier(value);
  if (!values.some((entry) => normalizeSkillIdentifier(entry) === normalized)) {
    values.push(normalized);
  }
}

function escapeRegexChar(value: string) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
