import { useEffect, useState } from "react";
import { parseRoute } from "../router";
import type { Route } from "../router";

/** The current route, re-parsed whenever the history entry changes. */
export function useRoute(): Route | null {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  return route;
}
