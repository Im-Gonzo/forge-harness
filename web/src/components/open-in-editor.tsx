/**
 * OpenInEditor — the shared "open in editor" navigation primitive.
 *
 * Every surface (tables, cards, detail panels) links an artifact to its editor
 * through this one component so the route shape lives in a single place.
 *
 * No hooks, no "use client": a plain component returning a <Link> renders in
 * BOTH server and client components. The Button composes with the link via Base
 * UI's `render` prop (this repo's shadcn is Base-UI-backed — see ui/button.tsx).
 */
import Link from "next/link";
import { SquarePen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ResourceKind } from "@/lib/types";

type ButtonProps = React.ComponentProps<typeof Button>;

/**
 * The canonical edit-route href for a resource. The id is URL-encoded because
 * rule ids can contain "/" (and other path-significant characters).
 */
export function editorHref(kind: ResourceKind, id: string): string {
  return `/resources/${kind}/${encodeURIComponent(id)}`;
}

export interface OpenInEditorProps {
  kind: ResourceKind;
  id: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  label?: string;
  iconOnly?: boolean;
  className?: string;
}

export function OpenInEditor({
  kind,
  id,
  variant = "outline",
  size = "sm",
  label = "Edit",
  iconOnly = false,
  className,
}: OpenInEditorProps) {
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(className)}
      render={
        <Link
          href={editorHref(kind, id)}
          aria-label={iconOnly ? `Edit ${kind} ${id}` : undefined}
        />
      }
    >
      <SquarePen />
      {!iconOnly && label}
    </Button>
  );
}
