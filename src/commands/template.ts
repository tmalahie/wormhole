import { pathExists, readText } from "../utils/fs.js";
import { WormError } from "../utils/errors.js";
import { renderTemplate } from "../utils/template.js";

/**
 * `worm template render <file> KEY=VALUE …` — render a `{{var}}` template file
 * with the given variables to stdout. The reusable form of worm's templating
 * primitive, for user setups (e.g. a `setup.sh` that pipes a config template
 * through worm instead of hand-rolling sed). Shell `${VAR}` is left untouched.
 */
export async function runTemplateRender(filePath: string, varArgs: string[] = []): Promise<void> {
  if (!(await pathExists(filePath))) {
    throw new WormError(`Template not found: ${filePath}`, {
      hint: "Pass a path to a {{var}} template file.",
    });
  }
  const vars: Record<string, string> = {};
  for (const arg of varArgs) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw new WormError(`Bad variable "${arg}" — expected KEY=VALUE.`, {
        hint: "e.g. worm template render compose.tmpl NAME=app PORT=3000",
      });
    }
    vars[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  const tmpl = await readText(filePath);
  // The rendered file is DATA for piping (`worm template render x.tmpl … > x.yml`),
  // so it goes straight to stdout — not through logger — like `status --json`.
  process.stdout.write(renderTemplate(tmpl, vars));
}
