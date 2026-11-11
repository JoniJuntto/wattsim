import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useLive, useStore } from '@/state/live';
import { api, errorText } from './http';
import type {
  ChaosRuleBody,
  CreateStationBody,
  CreateStationsBulkBody,
  OcppVersion,
  StationAction,
  StationView,
} from './types';

export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: api.meta, staleTime: Number.POSITIVE_INFINITY });

/** Loads the station's frame history into the live store; reruns after every stream snapshot (reconnect). */
export function useFrameHistory(stationId: string) {
  const store = useStore();
  const snapshots = useLive((s) => s.snapshots);
  const q = useQuery({
    queryKey: ['frames', stationId, snapshots],
    queryFn: () => api.frames(stationId, 2000),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: 1,
  });
  useEffect(() => {
    if (q.data) store.dispatch([{ type: 'frames-loaded', stationId, frames: q.data }]);
  }, [q.data, stationId, store]);
  return q;
}

const ACTION_DONE: Partial<Record<StationAction['type'], string>> = {
  heartbeat: 'Heartbeat answered',
  boot: 'BootNotification answered',
  bootLoop: 'Boot loop finished',
  reset: 'Reset done: the station booted again',
  fault: 'EVSE faulted',
  meter: 'Meter register changed',
};

export function useStationAction(stationId: string) {
  return useMutation({
    mutationKey: ['action', stationId],
    mutationFn: (action: StationAction) => api.action(stationId, action),
    onSuccess: (res, action) => {
      if (res.pending) {
        toast.info(`${action.type}: still waiting for the station`, {
          description: `${stationId} has not finished after 5 s. If it fails, the error shows up here.`,
        });
        return;
      }
      if (action.type === 'authorize') {
        const accepted = (res.result as { accepted?: unknown } | undefined)?.accepted;
        if (accepted === false) toast.warning(`${action.idTag} was not accepted`, { description: stationId });
        else toast.success(`${action.idTag} authorized`, { description: stationId });
        return;
      }
      const done = ACTION_DONE[action.type];
      if (done) toast.success(done, { description: stationId });
    },
    onError: (e, action) => toast.error(`${action.type} failed`, { description: errorText(e) }),
  });
}

export function useCreateStations() {
  const store = useStore();
  return useMutation({
    mutationFn: (body: CreateStationBody | CreateStationsBulkBody): Promise<StationView[]> =>
      'template' in body ? api.createStations(body) : api.createStation(body).then((s) => [s]),
    onSuccess: (stations) => {
      store.dispatch(stations.map((station) => ({ type: 'station' as const, station })));
      toast.success(stations.length === 1 ? `Added ${stations[0]?.id}` : `Added ${stations.length} stations`);
    },
  });
}

export function useMoveStations() {
  const store = useStore();
  return useMutation({
    mutationFn: ({ ids, folder }: { ids: string[]; folder: string | null }) => api.moveStations(ids, folder),
    onSuccess: (stations, { folder }) => {
      store.dispatch(stations.map((station) => ({ type: 'station' as const, station })));
      const what = stations.length === 1 ? stations[0]?.id : `${stations.length} stations`;
      toast.success(folder === null ? `Took ${what} out of its folder` : `Moved ${what} to ${folder}`);
    },
    onError: (e) => toast.error('Move failed', { description: errorText(e) }),
  });
}

export function useDeleteStation() {
  const store = useStore();
  return useMutation({
    mutationFn: (id: string) => api.deleteStation(id),
    onSuccess: (_r, id) => {
      store.dispatch([{ type: 'removed', id }]);
      toast.success(`Removed ${id}`);
    },
    onError: (e) => toast.error('Remove failed', { description: errorText(e) }),
  });
}

export function useAddChaos(stationId: string) {
  return useMutation({
    mutationFn: (rule: ChaosRuleBody) => api.addChaos(stationId, rule),
    onError: (e) => toast.error('Chaos rule rejected', { description: errorText(e) }),
  });
}

export function useRemoveChaos(stationId: string) {
  return useMutation({
    mutationFn: (ruleId: string) => api.removeChaos(stationId, ruleId),
    onError: (e) => toast.error('Remove failed', { description: errorText(e) }),
  });
}

export type ValidateInput = { version: OcppVersion; action: string; payload: unknown };

/** Schema check of a request payload; `input` should already be debounced. */
export function useValidation(input: ValidateInput | null) {
  return useQuery({
    queryKey: ['validate', input],
    queryFn: () => api.validate({ ...(input as ValidateInput), direction: 'request' }),
    enabled: input !== null,
    placeholderData: keepPreviousData,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useExportSession() {
  return useMutation({
    mutationFn: api.session,
    onSuccess: (text) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'session.ws';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Downloaded session.ws');
    },
    onError: (e) => toast.error('Export failed', { description: errorText(e) }),
  });
}
