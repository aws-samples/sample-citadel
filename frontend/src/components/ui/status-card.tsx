import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";

const statusCardVariants = cva("border-2", {
  variants: {
    status: {
      completed: "border-chart-2",
      in_progress: "border-chart-1",
      blocked: "border-destructive",
      pending: "border-border",
    },
  },
  defaultVariants: {
    status: "pending",
  },
});

export type PhaseStatus = "completed" | "in_progress" | "blocked" | "pending";

interface StatusCardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof statusCardVariants> {}

export function StatusCard({ status, className, ...props }: StatusCardProps) {
  return (
    <div
      className={cn(statusCardVariants({ status }), className)}
      {...props}
    />
  );
}
