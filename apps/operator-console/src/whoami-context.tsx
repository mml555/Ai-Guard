import { createContext, useContext } from "react";
import type { Whoami } from "./api/whoami";

/** The authenticated operator, or null until whoami resolves. */
export const WhoamiContext = createContext<Whoami | null>(null);

export function useWhoami(): Whoami | null {
  return useContext(WhoamiContext);
}

/** The operator's permissions (empty until whoami resolves). */
export function usePermissions(): string[] {
  return useContext(WhoamiContext)?.permissions ?? [];
}
