import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SimPool } from "./workers/pool";
import TooNarrow from "./components/too-narrow";
import ReplayPage from "./pages/replay-page";
import ScenariosPage from "./pages/scenarios-page";
import TunePage from "./pages/tune-page";
import VerifyPage from "./pages/verify-page";
import { hrefFor, ROUTE_LABELS, ROUTES, useRoute } from "./router";

/**
 * Below this the app shows a message instead of a layout. See `too-narrow.tsx` for
 * why that is the choice rather than a responsive squeeze.
 */
const MIN_WIDTH = 700;

function subscribeToWidth(onChange: () => void): () => void {
  const query = window.matchMedia(`(min-width: ${MIN_WIDTH}px)`);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Read through a media query rather than a resize listener, so it fires once per
 *  crossing rather than on every pixel of a drag. */
function useWideEnough(): boolean {
  return useSyncExternalStore(
    subscribeToWidth,
    () => window.matchMedia(`(min-width: ${MIN_WIDTH}px)`).matches,
    () => true,
  );
}

export default function App() {
  const poolRef = useRef<SimPool | null>(null);
  const [version, setVersion] = useState("");
  const route = useRoute();
  const wideEnough = useWideEnough();

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
    if (!wideEnough) return;
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
  }, [poolFor, wideEnough]);

  // returned before the routes mount, so a viewport that cannot show a result is not
  // also spending a worker pool producing one
  if (!wideEnough) return <TooNarrow />;

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
        {route === "/scenarios" ? <ScenariosPage /> : null}
        {route === "/verify" ? <VerifyPage pool={poolFor} coreVersion={version} /> : null}
      </main>
    </>
  );
}
