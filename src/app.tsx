import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Cpu } from "lucide-react";
import { SimPool } from "./workers/pool";
import TooNarrow from "./components/too-narrow";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
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
   * Created on demand rather than during render, and kept for the life of the page.
   *
   * It is deliberately not disposed on unmount. React runs child effects before the
   * parent's cleanup, so a StrictMode remount has the panels starting work against
   * the pool *before* this component tears the same pool down underneath them. The
   * calls then reject with "Proxy has been released" and `/verify` renders two red
   * errors next to results that arrived fine, which is a teardown artifact reported
   * as a failed check.
   *
   * `App` unmounts only when the page goes away, and the browser reclaims the workers
   * then regardless, so there is nothing left for a cleanup to buy.
   */
  const poolFor = useCallback((): SimPool => {
    if (!poolRef.current) poolRef.current = new SimPool();
    return poolRef.current;
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
    <TooltipProvider>
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-[110rem] items-center gap-6 px-6">
          <span className="font-heading text-[0.95rem] font-semibold tracking-tight">
            netcode
          </span>

          <nav aria-label="Sections">
            <ul className="flex items-center gap-1">
              {ROUTES.map((r) => {
                const current = route === r;
                return (
                  <li key={r}>
                    <a
                      href={hrefFor(r)}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "relative flex h-8 items-center rounded-md px-3 text-[0.8125rem] font-medium",
                        "transition-colors outline-none",
                        "focus-visible:ring-3 focus-visible:ring-ring/50",
                        current
                          ? "text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      {ROUTE_LABELS[r]}
                      {/* the active mark is its own element rather than a background,
                          so the label does not shift weight between states */}
                      {current ? (
                        <span className="absolute inset-x-2 -bottom-[13px] h-0.5 rounded-full bg-primary" />
                      ) : null}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          {version ? (
            // the build flags travel with every result, because a number is only
            // meaningful next to the build that produced it
            <CoreFingerprint version={version} />
          ) : null}
        </div>
      </header>

      <main className="mx-auto w-full max-w-[110rem] flex-1 px-6 py-8">
        {route === "/" ? <ReplayPage pool={poolFor} /> : null}
        {route === "/tune" ? <TunePage pool={poolFor} coreVersion={version} /> : null}
        {route === "/scenarios" ? <ScenariosPage /> : null}
        {route === "/verify" ? <VerifyPage pool={poolFor} coreVersion={version} /> : null}
      </main>
    </div>
    </TooltipProvider>
  );
}

/**
 * The core build the numbers on screen came out of.
 *
 * Split into the version and its flags because they answer different questions: the
 * version says which build, the flags say whether that build can be trusted to
 * reproduce, and `relaxed_simd` in particular would invalidate every guarantee the
 * verify page makes.
 */
function CoreFingerprint({ version }: { version: string }) {
  const [name, ...flags] = version.split(" ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          /**
           * The flags stay in the DOM rather than living only in the tooltip.
           *
           * `relaxed_simd` in particular would invalidate every guarantee the verify
           * page makes, so it has to be readable without hovering. It is dimmed and
           * hidden on a narrow bar, never removed.
           */
          <div
            className="ml-auto flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1"
            data-testid="version"
          >
            <Cpu className="size-3.5 text-muted-foreground" aria-hidden />
            <span className="font-mono text-xs text-muted-foreground">
              core <span className="text-foreground">{name}</span>
            </span>
            <span className="hidden font-mono text-xs text-muted-foreground/70 xl:inline">
              {flags.join(" ")}
            </span>
          </div>
        }
      />
      <TooltipContent>
        <p className="font-mono text-xs">{flags.join(" ") || "no build flags"}</p>
        <p className="mt-1 max-w-56 text-xs text-muted-foreground">
          Every result on this page came out of this build.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
