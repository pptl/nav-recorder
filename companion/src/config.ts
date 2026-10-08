import { existsSync } from "node:fs";
import type { ApiBaseSpec, LaunchConfig, NavConfig } from "./types.js";
import { CliError } from "./errors.js";
import { p, projectDirOf } from "./paths.js";
import { readJson } from "./util/fs.js";
import { resolveApiBases } from "./derive.js";

/** config.json as written: apiBases may contain derivation objects. */
export type RawConfig = Omit<Partial<NavConfig>, "apiBases"> & { apiBases?: ApiBaseSpec[] };

export const DEFAULT_CONFIG: NavConfig = {
  name: "my-app",
  appOrigins: ["http://localhost:3000"],
  apiBases: ["http://localhost:3000/api/"],
  readOnlyPatterns: [],
  auth: { kind: "cookie" },
  login: {
    kind: "ui",
    url: "/login",
    fields: { username: "input[name=username]", password: "input[name=password]" },
    submit: "button[type=submit]",
    successCheck: { urlNot: "/login" },
  },
  storageReset: { indexedDB: [], localStorage: [], sessionStorage: [] },
  schemaSources: [],
  dataSourceRules: [
    { pattern: "useQuery\\(", verdict: "api", note: "TanStack Query fetches on mount" },
    { pattern: "useSelector\\(", requiresAlso: "dispatch\\(", verdictIfMissing: "ui", note: "Redux without mount-time dispatch → enter through real UI" },
  ],
  // Never assume deep links work: an unproven guess would silently send the Agent to a blank screen.
  navigation: { entry: "unknown" },
  // Empty for the same reason: a guessed start command can bring the app up with the wrong
  // environment, which looks like a working server and fails much later.
  launch: {},
  recording: { maxBodyKB: 64, bufferHours: 2, sessionGapMinutes: 20, unclaimedKeepDays: 7, unroutedKeepHours: 12 },
  execute: { maxConsecutiveFailures: 3 },
};

export function configPath(dataDir: string): string {
  return p(dataDir, "config.json");
}

/** Merge a partial config over the defaults (one level deep for object sections). */
export function withDefaults(partial: Partial<NavConfig>): NavConfig {
  const d = DEFAULT_CONFIG;
  return {
    name: partial.name ?? d.name,
    appOrigins: partial.appOrigins ?? d.appOrigins,
    apiBases: partial.apiBases ?? d.apiBases,
    readOnlyPatterns: partial.readOnlyPatterns ?? d.readOnlyPatterns,
    auth: { ...d.auth, ...(partial.auth ?? {}) },
    login: partial.login ?? d.login,
    storageReset: { ...d.storageReset, ...(partial.storageReset ?? {}) },
    schemaSources: partial.schemaSources ?? d.schemaSources,
    dataSourceRules: partial.dataSourceRules ?? d.dataSourceRules,
    navigation: { ...d.navigation, ...(partial.navigation ?? {}) },
    launch: { ...d.launch, ...(partial.launch ?? {}) },
    recording: { ...d.recording, ...(partial.recording ?? {}) },
    execute: { ...d.execute, ...(partial.execute ?? {}) },
  };
}

const LAUNCH_KEYS = ["command", "cwd", "requiredEnv", "readyWhen", "readyTimeoutSec", "avoid", "evidence"] as const;
/** Valid POSIX/Windows environment variable name. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `launch` is entirely optional, so every rule here is about a value that is present being usable.
 * The unknown-key check doubles as a shape check: withDefaults spreads whatever it is given, so a
 * bare string arrives as an object of numeric keys rather than failing outright.
 */
export function validateLaunch(launch: LaunchConfig | undefined): string[] {
  const errors: string[] = [];
  if (launch === undefined) return errors;
  if (typeof launch !== "object" || launch === null || Array.isArray(launch)) return ["launch must be an object"];
  for (const k of Object.keys(launch)) {
    if (!(LAUNCH_KEYS as readonly string[]).includes(k)) errors.push(`launch has unknown key "${k}" (allowed: ${LAUNCH_KEYS.join(", ")})`);
  }
  const str = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;
  if (launch.command !== undefined && !str(launch.command)) errors.push("launch.command must be a non-empty string");
  if (launch.cwd !== undefined) {
    if (!str(launch.cwd)) errors.push("launch.cwd must be a non-empty string");
    // An absolute cwd would pin the config to one machine; everything else here is portable.
    else if (/^([A-Za-z]:[\\/]|[\\/])/.test(launch.cwd)) errors.push(`launch.cwd must be relative to the project root: ${launch.cwd}`);
  }
  if (launch.requiredEnv !== undefined) {
    if (typeof launch.requiredEnv !== "object" || launch.requiredEnv === null || Array.isArray(launch.requiredEnv)) errors.push("launch.requiredEnv must be an object of NAME → value");
    else for (const [k, v] of Object.entries(launch.requiredEnv)) {
      if (!ENV_NAME.test(k)) errors.push(`launch.requiredEnv key is not a valid variable name: ${k}`);
      if (typeof v !== "string") errors.push(`launch.requiredEnv.${k} must be a string`);
    }
  }
  if (launch.readyWhen !== undefined && !str(launch.readyWhen)) errors.push("launch.readyWhen must be a non-empty string");
  if (launch.readyTimeoutSec !== undefined && !(typeof launch.readyTimeoutSec === "number" && launch.readyTimeoutSec > 0)) errors.push("launch.readyTimeoutSec must be > 0");
  if (launch.avoid !== undefined) {
    if (!Array.isArray(launch.avoid)) errors.push("launch.avoid must be an array of {command, reason}");
    else for (const [i, t] of launch.avoid.entries()) {
      if (!t || typeof t !== "object") { errors.push(`launch.avoid[${i}] must be {command, reason}`); continue; }
      if (!str(t.command)) errors.push(`launch.avoid[${i}].command is required`);
      // Without a reason the entry is folklore: the next person deletes it or works around it.
      if (!str(t.reason)) errors.push(`launch.avoid[${i}].reason is required — say what the command gets wrong`);
      if (str(t.command) && str(launch.command) && t.command.trim() === launch.command!.trim()) errors.push(`launch.avoid[${i}].command is also launch.command: ${t.command}`);
    }
  }
  if (launch.evidence !== undefined && typeof launch.evidence !== "string") errors.push("launch.evidence must be a string");
  return errors;
}

export function validateConfig(cfg: NavConfig): string[] {
  const errors: string[] = [];
  if (!cfg.name || typeof cfg.name !== "string") errors.push("name must be a non-empty string");
  if (!Array.isArray(cfg.appOrigins) || cfg.appOrigins.length === 0) errors.push("appOrigins must be a non-empty array");
  else for (const o of cfg.appOrigins) {
    try {
      if (new URL(o).origin !== o.replace(/\/+$/, "")) errors.push(`appOrigins entry is not a bare origin: ${o}`);
    } catch { errors.push(`appOrigins entry is not a valid URL: ${o}`); }
  }
  if (!Array.isArray(cfg.apiBases) || cfg.apiBases.length === 0) errors.push("apiBases must be a non-empty array");
  else for (const b of cfg.apiBases) {
    try { new URL(b); } catch { errors.push(`apiBases entry is not a valid URL: ${b}`); }
    if (!b.endsWith("/")) errors.push(`apiBases entry must end with "/": ${b}`);
  }
  for (const pat of cfg.readOnlyPatterns ?? []) {
    try { new RegExp(pat); } catch { errors.push(`readOnlyPatterns entry is not a valid regex: ${pat}`); }
  }
  if (!["bearer", "cookie", "none"].includes(cfg.auth?.kind)) errors.push("auth.kind must be bearer | cookie | none");
  if (cfg.auth?.kind === "bearer") {
    if (!cfg.auth.tokenSource?.key) errors.push("auth.tokenSource.key is required for bearer auth");
    if (cfg.auth.tokenSource && !["localStorage", "sessionStorage"].includes(cfg.auth.tokenSource.area)) errors.push("auth.tokenSource.area must be localStorage | sessionStorage");
  }
  const login = cfg.login as unknown as Record<string, unknown> | undefined;
  if (!login || !["ui", "api"].includes(String(login.kind))) errors.push("login.kind must be ui | api");
  else if (login.kind === "ui") {
    const f = login.fields as Record<string, unknown> | undefined;
    if (!login.url) errors.push("login.url is required for ui login");
    if (!f?.username || !f?.password) errors.push("login.fields.username/password selectors are required for ui login");
    if (!login.submit) errors.push("login.submit selector is required for ui login");
  } else {
    const call = login.call as Record<string, unknown> | undefined;
    if (!call?.method || !call?.url) errors.push("login.call.method/url are required for api login");
    if (typeof login.bodyTemplate !== "object" || login.bodyTemplate === null) errors.push("login.bodyTemplate must be an object for api login");
  }
  for (const r of cfg.dataSourceRules ?? []) {
    try { new RegExp(r.pattern); } catch { errors.push(`dataSourceRules pattern is not a valid regex: ${r.pattern}`); }
    if (r.requiresAlso) { try { new RegExp(r.requiresAlso); } catch { errors.push(`dataSourceRules requiresAlso is not a valid regex: ${r.requiresAlso}`); } }
    if (!r.verdict && !r.verdictIfMissing) errors.push(`dataSourceRules entry needs verdict or verdictIfMissing: ${r.pattern}`);
  }
  for (const s of cfg.schemaSources ?? []) {
    if (!["openapi", "efcore"].includes(s.kind)) errors.push(`schemaSources.kind must be openapi | efcore (got ${String(s.kind)})`);
    if (!s.glob) errors.push("schemaSources entry needs a glob");
  }
  if (!["deeplink", "menu", "unknown"].includes(cfg.navigation?.entry)) errors.push(`navigation.entry must be deeplink | menu | unknown (got ${String(cfg.navigation?.entry)})`);
  if (cfg.navigation?.evidence !== undefined && typeof cfg.navigation.evidence !== "string") errors.push("navigation.evidence must be a string");
  errors.push(...validateLaunch(cfg.launch));
  if (!(cfg.recording?.maxBodyKB > 0)) errors.push("recording.maxBodyKB must be > 0");
  if (!(cfg.recording?.bufferHours > 0)) errors.push("recording.bufferHours must be > 0");
  if (!(cfg.recording?.sessionGapMinutes > 0)) errors.push("recording.sessionGapMinutes must be > 0");
  if (!(cfg.recording?.unclaimedKeepDays > 0)) errors.push("recording.unclaimedKeepDays must be > 0");
  if (!(cfg.recording?.unroutedKeepHours > 0)) errors.push("recording.unroutedKeepHours must be > 0");
  if (!(cfg.execute?.maxConsecutiveFailures > 0)) errors.push("execute.maxConsecutiveFailures must be > 0");
  return errors;
}

/**
 * Turn a raw config (possibly with derived apiBases) into a fully resolved NavConfig.
 * Derivations are looked up against the project directory every time, so a dev host that moves
 * (e.g. a domain key in package.json) is picked up without editing config.json.
 */
export function resolveConfig(raw: RawConfig, projectDir: string): NavConfig {
  const specs = raw.apiBases;
  let apiBases: string[] | undefined;
  const deriveErrors: string[] = [];
  if (specs) {
    const r = resolveApiBases(specs, projectDir);
    apiBases = r.values;
    deriveErrors.push(...r.errors);
  }
  const cfg = withDefaults({ ...(raw as Partial<NavConfig>), apiBases: apiBases ?? DEFAULT_CONFIG.apiBases });
  if (specs && specs.some((s) => typeof s !== "string")) cfg.apiBasesSpec = specs;
  const errors = [...deriveErrors, ...validateConfig(cfg)];
  if (errors.length) throw new CliError("E_CONFIG_INVALID", `Invalid config: ${errors.join("; ")}`, errors);
  return cfg;
}

export function loadConfig(dataDir: string): NavConfig {
  const path = configPath(dataDir);
  if (!existsSync(path)) throw new CliError("E_NO_PROJECT", `Missing ${path}`);
  const raw = readJson<RawConfig & { $schema?: string }>(path);
  delete raw.$schema;
  try {
    return resolveConfig(raw, projectDirOf(dataDir));
  } catch (e) {
    if (e instanceof CliError && e.code === "E_CONFIG_INVALID") throw new CliError(e.code, `Invalid config at ${path}: ${(e.details as string[]).join("; ")}`, e.details);
    throw e;
  }
}

/** What to write back to disk / templates: the specs if any were derived, else the plain strings. */
export function configForDisk(cfg: NavConfig): Record<string, unknown> {
  const { apiBasesSpec, ...rest } = cfg;
  return { ...rest, apiBases: apiBasesSpec ?? cfg.apiBases };
}

/** Patterns are matched case-insensitively: most backends route case-insensitively and frontends are inconsistent. */
export function compileReadOnlyPatterns(cfg: NavConfig): RegExp[] {
  return cfg.readOnlyPatterns.map((s) => new RegExp(s, "i"));
}
