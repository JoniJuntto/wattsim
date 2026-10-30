import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { createStreamHandler, StreamClient, type StreamStatus, streamUrl } from '@/api/stream';
import { createStore, type State, type Store } from './store';

type Live = { store: Store; client: StreamClient; status: StreamStatus };

const LiveContext = createContext<Live | null>(null);

/** Owns the one `/api/stream` WebSocket and the station store it feeds. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<StreamStatus>({ state: 'connecting', attempt: 1 });
  const { store, client } = useMemo(() => {
    const store = createStore();
    const handler = createStreamHandler({
      dispatch: (actions) => store.dispatch(actions),
      onError: (stationId, message) =>
        toast.error(stationId, { id: `stream-error:${stationId}:${message}`, description: message }),
    });
    const client = new StreamClient({ url: streamUrl(), onMessage: handler.receive, onStatus: setStatus });
    return { store, client };
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) Object.assign(window, { wattsimStore: store });
    client.start();
    return () => client.stop();
  }, [client, store]);

  const value = useMemo(() => ({ store, client, status }), [store, client, status]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

function useLiveContext(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error('useLive must be used inside <LiveProvider>');
  return live;
}

/** Subscribe to a slice of the live store. The selector must return a stable reference for unchanged data. */
export function useLive<T>(selector: (s: State) => T): T {
  const { store } = useLiveContext();
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()));
}

export const useStore = () => useLiveContext().store;
export const useStreamStatus = () => {
  const { status, client } = useLiveContext();
  return { status, retryNow: () => client.retryNow() };
};
