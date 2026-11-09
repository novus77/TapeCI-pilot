import { ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/** Native details preserves keyboard/find-in-page behavior; CSS progressively animates its content. */
export function Disclosure({ title, children, className = "", ...props }: Omit<ComponentProps<"details">, "title"> & {
  readonly title: ReactNode;
}) {
  return <details {...props} className={`disclosure ${className}`}>
    <summary><span>{title}</span><ChevronDown size={15} aria-hidden="true" /></summary>
    <div className="disclosure-content">{children}</div>
  </details>;
}
