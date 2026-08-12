/**
 * Hash routing over a fixed route list.
 *
 * The app is four static routes with no data loading, no guards and no nested
 * layouts, and it deploys as a static build. A routing library would bring loaders,
 * actions and a server rewrite requirement for what is a tab switcher, so the
 * twenty lines below are the whole thing.
 *
 * Hash rather than path so a deep link opens correctly from a file or a static host
 * without any rewrite rule.
 */

import { useCallback, useSyncExternalStore } from "react";

export const ROUTES = ["/", "/tune", "/scenarios", "/verify"] as const;
export type Route = (typeof ROUTES)[number];

export const ROUTE_LABELS: Record<Route, string> = {
  "/": "Replay",
  "/tune": "Tune",
  "/scenarios": "Scenarios",
  "/verify": "Verify",
};

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** Everything before a `?`, so a route can carry parameters without missing a match. */
function pathOf(hash: string): string {
  return hash.replace(/^#/, "").split("?")[0] ?? "";
}

function readRoute(): Route {
  const path = pathOf(window.location.hash);
  return (ROUTES.find((r) => r === path) ?? "/") as Route;
}

/** The server has no location, so rendering falls back to the landing route. */
function serverRoute(): Route {
  return "/";
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, readRoute, serverRoute);
}

/** Parameters after the `?` in the hash, for deep links into a route's state. */
export function useRouteParams(): URLSearchParams {
  const raw = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => "",
  );
  return new URLSearchParams(raw.split("?")[1] ?? "");
}

export function hrefFor(route: Route, params?: Record<string, string>): string {
  const query = params ? new URLSearchParams(params).toString() : "";
  return `#${route}${query ? `?${query}` : ""}`;
}

export function useNavigate(): (route: Route, params?: Record<string, string>) => void {
  return useCallback((route: Route, params?: Record<string, string>) => {
    window.location.hash = hrefFor(route, params).slice(1);
  }, []);
}
