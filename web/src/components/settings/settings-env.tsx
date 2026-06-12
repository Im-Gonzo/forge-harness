/**
 * SettingsEnv — the READ-ONLY install-wide environment panel.
 *
 * Surfaces the machine-level paths the harness web app resolves against, all
 * READ-ONLY (set via env vars at launch — there is no runtime write path, and
 * inventing one would be wrong):
 *
 *   - FORGE_ROOT          — the library / CLI root every machine read uses.
 *   - FORGE_HOME          — $FORGE_HOME or ~/.forge (global config + sources).
 *   - FORGE_WEB_SCAN_ROOT — the root the project scan crawls.
 *
 * Each path shows whether it came from an explicit env var or a default, so the
 * user knows what they can override. Presentational — the page reads the env.
 */
import { HardDrive, Home, ScanSearch } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { HarnessEnv } from "@/lib/forge-bridge/harness-config";

export interface SettingsEnvProps {
  env: HarnessEnv;
}

function PathRow({
  icon: Icon,
  envVar,
  value,
  fromEnv,
}: {
  icon: typeof Home;
  envVar: string;
  value: string;
  fromEnv: boolean;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border bg-muted/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-foreground">
          <Icon className="size-3 text-muted-foreground/60" />
          {envVar}
        </span>
        <Badge
          variant="outline"
          className="font-mono text-[10px] uppercase text-muted-foreground/70"
        >
          {fromEnv ? "from env" : "default"}
        </Badge>
      </div>
      <code className="break-all font-mono text-[10px] text-muted-foreground">
        {value}
      </code>
    </li>
  );
}

export function SettingsEnv({ env }: SettingsEnvProps) {
  return (
    <Card size="sm">
      <CardHeader className="pb-1">
        <CardTitle className="flex items-center gap-1.5 font-mono text-sm">
          <HardDrive className="size-3.5" />
          Environment
          <Badge
            variant="outline"
            className="font-mono text-[10px] uppercase text-muted-foreground/70"
          >
            read-only
          </Badge>
        </CardTitle>
        <CardDescription className="font-mono text-[11px]">
          The install-wide paths the harness resolves against. Set via env vars
          at launch — read-only here. Override <code>FORGE_HOME</code> /{" "}
          <code>FORGE_WEB_SCAN_ROOT</code> in the environment to point at a
          different layout.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <ul className="flex flex-col gap-1.5">
          <PathRow
            icon={HardDrive}
            envVar="FORGE_ROOT"
            value={env.forgeRoot}
            fromEnv={true}
          />
          <PathRow
            icon={Home}
            envVar="FORGE_HOME"
            value={env.forgeHome}
            fromEnv={env.forgeHomeFromEnv}
          />
          <PathRow
            icon={ScanSearch}
            envVar="FORGE_WEB_SCAN_ROOT"
            value={env.scanRoot}
            fromEnv={env.scanRootFromEnv}
          />
        </ul>
      </CardContent>
    </Card>
  );
}
