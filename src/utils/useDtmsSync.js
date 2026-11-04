import { useEffect, useRef } from 'react';
import { DTMS_ENABLED, syncDtmsApprovals } from '../utils/dtmsApproval.js';

// Mount once in the layout that stays open (the dashboard shell), and pass the function that reloads
// your lists. It runs on load, every minute, and whenever the tab becomes visible again.
//
//   useDtmsSync(() => refreshRecords());
export default function useDtmsSync(onChange, intervalMs = 60_000) {
  const callback = useRef(onChange);
  callback.current = onChange;

  useEffect(() => {
    if (!DTMS_ENABLED) return undefined;
    let busy = false;

    const run = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        if (await syncDtmsApprovals()) callback.current?.();
      } finally {
        busy = false;
      }
    };

    run();
    const timer = setInterval(run, intervalMs);
    document.addEventListener('visibilitychange', run);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', run);
    };
  }, [intervalMs]);
}
