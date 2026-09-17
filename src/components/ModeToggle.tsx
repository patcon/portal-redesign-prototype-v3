import { useEffect, useState } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/shadcn/button";

/**
 * Light/dark switch, remembered per browser. It writes the same two things the
 * bootstrap script in `index.html` writes — the `dark` class and `colorScheme` —
 * so the two cannot disagree about which mode is showing.
 */
export function ModeToggle() {
  const [mode, setMode] = useState(() => localStorage.getItem("theme") ?? "light");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [mode]);

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setMode((value) => (value === "light" ? "dark" : "light"))}
    >
      {mode === "light" ? <MoonIcon className="size-4" /> : <SunIcon className="size-4" />}
    </Button>
  );
}
