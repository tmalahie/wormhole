import readline from "node:readline";

export function confirm(
  question: string,
  defaultYes: boolean = false
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const prompt = defaultYes ? `${question} [Y/n] ` : `${question} [y/N] `;
    rl.question(prompt, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "") return resolve(defaultYes);
      resolve(/^y(es)?$/.test(trimmed));
    });
  });
}
