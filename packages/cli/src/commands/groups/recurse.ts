/**
 * recurse.ts — delendai's self-recreating loop as a first-class feature.
 *
 * Reads the workspace `delendai.config.json` `featureFlags` (the agent-controls
 * capabilities the estate declared) and synthesises the NEXT SIX emergent,
 * disparate tasks to keep the recursive goal going. This is the "never yield;
 * a wall spawns a sub-goal" doctrine, commandified. No fragile bridge: reads
 * the config file directly with stdlib fs.
 *
 * Agent-file rules R-1xx / R-3xx: the command returns a structured result and
 * does not mutate state; it only prints the derived next-six plan.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type {
  ICliCommand,
  ICliCommandResult,
} from "../../contracts/interfaces/cli-command.interface";
import { EXIT_CODE } from "../../contracts/constants/exit-code.constant";
import { usage } from "./group-helpers";

interface IFeatureFlags {
  [key: string]: boolean;
}

const AGENT_CONTROLS_PREFIX = "agent-controls.";

const EMERGENT_ANCHORS: ReadonlyArray<[string, string]> = [
  [
    "agent-controls.desktop",
    "race a faster full-desktop snapshot; add a new window metadata field",
  ],
  [
    "agent-controls.browser",
    "add a browser fixture + navigation test; cover the new tab edge",
  ],
  [
    "agent-controls.stoplight",
    "wire the floaty lamp to a new agent-needs-human gate",
  ],
  [
    "agent-controls.swarm-10",
    "register the 10th swarm lane with its unique external model",
  ],
  [
    "agent-controls.computer-use-linux",
    "add a desktop read/screenshot recall for the current surface",
  ],
  [
    "agent-controls.ax-snapshot-imagefree",
    "extend the AX-snapshot to a second page + assert parity",
  ],
];

const recurseCommand: ICliCommand = {
  name: "recurse",
  summary:
    "Generate the next six emergent tasks from the declared agent-controls feature flags (the self-recreating loop).",
  async run(args, ctx): Promise<ICliCommandResult> {
    if (!existsSync(join(ctx.cwd, "delendai.config.json"))) {
      return usage("recurse");
    }
    let enabled: IFeatureFlags = {};
    try {
      const raw = readFileSync(join(ctx.cwd, "delendai.config.json"), "utf8");
      const cfg = JSON.parse(raw) as { featureFlags?: IFeatureFlags };
      enabled = cfg.featureFlags ?? {};
    } catch {
      enabled = {};
    }
    const active = Object.keys(enabled)
      .filter((k) => enabled[k])
      .filter((k) => k.startsWith(AGENT_CONTROLS_PREFIX));
    if (active.length === 0) {
      return {
        code: EXIT_CODE.OK,
        text: "No agent-controls.* feature flags enabled. Set them in delendai.config.json to seed the next six.",
      };
    }
    const six = new Array<{ flag: string; todo: string }>();
    let i = 0;
    while (six.length < 6 && i < EMERGENT_ANCHORS.length) {
      const [flag, todo] = EMERGENT_ANCHORS[i];
      if (enabled[flag]) six.push({ flag, todo });
      i++;
    }
    const lines = ["", "# Next six (self-recreating loop)"];
    for (const t of six) lines.push(`  - [${t.flag}] ${t.todo}`);
    if (six.length === 0)
      lines.push(
        "  - none of the agent-controls anchors are enabled; enable flags to seed emergent tasks",
      );
    return { code: EXIT_CODE.OK, text: lines.join("\n") };
  },
};

export default recurseCommand;
