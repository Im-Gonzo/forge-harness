"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

/**
 * Switch — a small token-based, controlled toggle on top of Base UI's
 * `Switch.Root` + `Switch.Thumb`. Geometry mirrors the design-system prototype's
 * `.forge-switch`: a 1.75rem pill track that fills with `--primary` when checked
 * and slides a 0.75rem `--foreground` knob 0.75rem to the right. Keyboard-
 * operable (Base UI renders a hidden `<input>` + role="switch").
 *
 * Controlled API matches the prototype's GSwitch: `checked` + `onCheckedChange`.
 */
export interface SwitchProps
  extends Omit<SwitchPrimitive.Root.Props, "onCheckedChange" | "render"> {
  /** Called with the next checked state on toggle. */
  onCheckedChange?: (checked: boolean) => void;
}

function Switch({ className, onCheckedChange, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      onCheckedChange={
        onCheckedChange ? (checked) => onCheckedChange(checked) : undefined
      }
      className={cn(
        // Track — a 1.75rem pill, secondary when off / primary when on.
        "relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-pill border border-transparent p-0",
        "bg-secondary transition-colors duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
        "outline-none focus-visible:ring-3 focus-visible:ring-ring/45",
        "data-[checked]:bg-primary",
        "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          // Knob — a 0.75rem dot offset 1px, sliding 0.75rem when checked.
          "pointer-events-none block size-3 translate-x-px rounded-pill bg-foreground",
          "transition-transform duration-[var(--duration-fast)] ease-[var(--ease-standard)]",
          "data-[checked]:translate-x-[calc(0.75rem+1px)] data-[checked]:bg-primary-foreground",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
