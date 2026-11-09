"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

import { useT } from "./locale-provider";
import { useState } from "react";

interface UserMenuProps {
  readonly login: string;
}

/** Accessible account menu (Radix DropdownMenu) with keyboard and outside-click support. */
export function UserMenu({ login }: UserMenuProps) {
  const router = useRouter();
  const { t } = useT();
  const [signingOut, setSigningOut] = useState(false);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      // Radix swallows a nested form submit, so POST explicitly and then navigate.
      await fetch("/logout", { method: "POST", redirect: "manual", cache: "no-store" });
      router.push("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="topbar-avatar"
          aria-label={t("topbar.signedInAs", { login })}
          title={t("topbar.signedInAs", { login })}
        >
          {login.slice(0, 1).toUpperCase()}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="user-menu-panel" sideOffset={6} align="end" aria-label={t("topbar.accountMenu")}>
          <DropdownMenu.Label className="user-menu-label">{t("topbar.signedInAs", { login })}</DropdownMenu.Label>
          <DropdownMenu.Item className="user-menu-name" disabled>
            {login}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="user-menu-separator" />
          <DropdownMenu.Item
            className="button button-ghost user-menu-action"
            disabled={signingOut}
            onSelect={() => {
              void signOut();
            }}
          >
            <LogOut size={14} aria-hidden="true" /> {signingOut ? t("topbar.signingOut") : t("topbar.signOut")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
