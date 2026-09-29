"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Reads/writes the `data-theme` attribute set by the inline script in layout.tsx. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "dark" || current === "light") setTheme(current);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("pc-theme", next);
      } catch {
        /* private mode */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}
