"use client";

import { FeedbackButton } from "./motion-feedback";

import { useT } from "./locale-provider";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import type { ReactNode } from "react";

interface ConfirmButtonProps {
  readonly label: string;
  readonly pendingLabel: string;
  readonly confirmLabel: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly onConfirm: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly className?: string;
  readonly testId?: string;
  readonly describedBy?: string;
}

/** Destructive/high-impact action behind a Radix confirmation dialog. */
export function ConfirmButton({
  label,
  pendingLabel,
  confirmLabel,
  title,
  children,
  onConfirm,
  disabled = false,
  busy = false,
  className = "button",
  testId,
  describedBy,
}: ConfirmButtonProps) {
  const { t } = useT();
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <FeedbackButton
          type="button"
          className={className}
          data-testid={testId}
          busy={busy}
          disabled={disabled || busy}
          aria-describedby={describedBy}
        >
          {busy ? pendingLabel : label}
        </FeedbackButton>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content" aria-describedby={undefined}>
          <div className="dialog-head">
            <Dialog.Title className="dialog-title">
              <AlertTriangle size={17} aria-hidden="true" /> {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <FeedbackButton type="button" className="copy-button" aria-label={t("confirm.close")}>
                <X size={15} aria-hidden="true" />
              </FeedbackButton>
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <div className="dialog-body">{children}</div>
          </Dialog.Description>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <FeedbackButton type="button" className="button button-ghost">
                Cancel
              </FeedbackButton>
            </Dialog.Close>
            <Dialog.Close asChild>
              <FeedbackButton
                type="button"
                className={className.includes("danger") ? "button button-danger" : "button button-primary"}
                onClick={onConfirm}
              >
                {confirmLabel}
              </FeedbackButton>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
