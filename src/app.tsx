import { useCallback, useEffect, useRef, useState } from "react";
import { SimPool } from "./workers/pool";
import ReplayPage from "./pages/replay-page";
import TunePage from "./pages/tune-page";
import { hrefFor, ROUTE_LABELS, ROUTES, useRoute, type Route } from "./router";

/**
 * Routes that exist in the navigation but are not built yet.
 *
 * Listed rather than hidden: the product is four routes, and a nav that silently
 * omits two would misrepresent what is planned. What it must not do is render a
 * convincing empty page, which would read as a feature that works and returns
 * nothing.
 */
const PENDING: Partial<Record<Route, string>> = {
  "/scenarios": "Scenario and network profile authoring.",
  "/verify": "The Riot reproduction, the determinism check, and the failure demos.",
};

export default function App() {
  const poolRef = useRef<SimPool | null>(null);
  const [version, setVersion] = useState("");
  const route = useRoute();

  /**
   * Created on demand rather than during render.
   *
   * StrictMode mounts, unmounts and remounts in development, so a pool built during
   * render is disposed by the first cleanup and then reused dead by the second pass,
   * which surfaces as "Proxy has been released". Building it here means the remount
   * gets a live pool.
   */
  const poolFor = useCallback((): SimPool => {
    if (!poolRef.current) poolRef.current = new SimPool();
    return poolRef.current;
  }, []);

  useEffect(() => {
    return () => {
      poolRef.current?.dispose();
      poolRef.current = null;
    };
  }, []);

  useEffect(() => {
    let live = true;
    poolFor()
      .version()
      .then((v) => {
        if (live) setVersion(v);
      })
      // the fingerprint is chrome. a failure to read it must not take down the page
      // that is trying to show a result
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [poolFor]);

  const pending = PENDING[route];

  return (
    <>
      <nav className="top-bar" aria-label="Sections">
        <div className="top-bar-inner">
          <span className="wordmark">netcode</span>
          <ul>
            {ROUTES.map((r) => (
              <li key={r}>
                <a href={hrefFor(r)} aria-current={route === r ? "page" : undefined}>
                  {ROUTE_LABELS[r]}
                </a>
              </li>
            ))}
          </ul>
          {version ? (
            // the build flags travel with every result, because a number is only
            // meaningful next to the build that produced it
            <code data-testid="version">core {version}</code>
          ) : null}
        </div>
      </nav>

      <main>
        {route === "/" ? <ReplayPage pool={poolFor} /> : null}
        {route === "/tune" ? <TunePage pool={poolFor} coreVersion={version} /> : null}
        {pending ? (
          <>
            <header>
              <h1>{ROUTE_LABELS[route]}</h1>
              <p>{pending}</p>
            </header>
            <p className="state" data-testid="not-built">
              Not built yet. This route is part of the next phase.
            </p>
          </>
        ) : null}
      </main>
    </>
  );
}
