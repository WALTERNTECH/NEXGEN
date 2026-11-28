"use client";

import { useEffect, useState } from "react";
import { IDownload, IX } from "./icons";

/**
 * "Install app" — puts NEXGEN on the phone's home screen (or the desktop) as its own app.
 * Android / Chrome / Edge: the browser's install prompt. iPhone / iPad Safari has no prompt, so it shows the two taps.
 * Hidden once NEXGEN is running as an installed app.
 */
type BipEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: BipEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  // The browser can offer install before any component has mounted: keep the offer.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BipEvent;
    listeners.forEach((f) => f());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((f) => f());
  });
}

function standalone() {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone))
  );
}

export function InstallButton({ compact = false }: { compact?: boolean }) {
  const [, tick] = useState(0);
  const [installed, setInstalled] = useState(true); // assume installed until checked, so it never flashes inside the app
  const [help, setHelp] = useState(false);

  useEffect(() => {
    setInstalled(standalone());
    const f = () => {
      setInstalled(standalone());
      tick((n) => n + 1);
    };
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);

  if (installed) return null;
  const ios = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

  const install = async () => {
    if (deferred) {
      await deferred.prompt();
      const r = await deferred.userChoice.catch(() => null);
      if (r?.outcome === "accepted") {
        deferred = null;
        setInstalled(true);
      }
      return;
    }
    setHelp(true);
  };

  return (
    <>
      <button className={`btn install ${compact ? "sm" : ""}`} onClick={install} title="Install NEXGEN on this device">
        <IDownload />
        <span>Install app</span>
      </button>
      {help && (
        <>
          <div className="scrim" onClick={() => setHelp(false)} />
          <div className="review install-help" role="dialog" aria-label="Install NEXGEN">
            <div className="review-h">
              <b>Install NEXGEN on this {ios ? "iPhone" : "device"}</b>
              <button className="iconbtn" onClick={() => setHelp(false)} aria-label="Close">
                <IX />
              </button>
            </div>
            {ios ? (
              <ol className="steps">
                <li>
                  Open this page in <b>Safari</b>.
                </li>
                <li>
                  Tap the <b>Share</b> button (the square with an arrow, at the bottom of the screen).
                </li>
                <li>
                  Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.
                </li>
              </ol>
            ) : (
              <ol className="steps">
                <li>
                  Open this page in <b>Chrome</b> or <b>Edge</b>.
                </li>
                <li>
                  Open the browser menu (<b>⋮</b>) and tap <b>Install app</b> or <b>Add to Home screen</b>.
                </li>
              </ol>
            )}
            <p className="small">NEXGEN then opens from your home screen like any other app, full screen, with phone alerts.</p>
          </div>
        </>
      )}
    </>
  );
}
