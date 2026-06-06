import { WormError } from "./errors.js";

/**
 * Minimal `{{var}}` templating — worm's one rendering primitive, shared by recipe
 * scaffolds and user setups (`worm render`). Replaces each `{{ name }}` with
 * `vars[name]`.
 *
 * Strict: an unknown variable is an error (catches typos). Anything that isn't a
 * `{{identifier}}` is left untouched — including shell `${VAR}` and `{{ ... }}`
 * with punctuation/spaces — so one file can freely mix worm vars with literal
 * `${...}` (e.g. a docker-compose template), no escaping needed.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, (_match, name: string) => {
    if (!(name in vars)) {
      throw new WormError(`Template references unknown variable {{${name}}}.`, {
        hint: `Provide it as KEY=VALUE. Known variables: ${Object.keys(vars).join(", ") || "(none)"}.`,
      });
    }
    return vars[name] as string;
  });
}
