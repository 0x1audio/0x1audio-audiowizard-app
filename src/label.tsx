import type { ComponentProps } from "react"
import { cn } from "@ox1audio/design-system"

/*
  A form field's label.
  From Mixel's design system (Apache-2.0), which doesn't export it from
  @ox1audio/design-system yet. When it does, this file goes.
*/
export function Label({ className, ...props }: ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-small leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}
