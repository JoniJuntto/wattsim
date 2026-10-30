/** Queries and mutations for the Scenarios and CSMS pages (server mode). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { useLive, useStore } from '@/state/live';
import { api } from './http';
import type { RunStatus, StartRunBody } from './types';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useScenarios = () => useQuery({ queryKey: ['scenarios'], queryFn: api.scenarios });

export function useScenario(id: string | undefined) {
  return useQuery({
    queryKey: ['scenario', id],
    queryFn: () => api.scenario(id as string),
    enabled: id !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useSaveScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, source }: { id?: string; name: string; source: string }) =>
      id === undefined ? api.createScenario({ name, source }) : api.updateScenario(id, { name, source }),
    onSuccess: (s) => {
      qc.setQueryData(['scenario', s.id], s);
      void qc.invalidateQueries({ queryKey: ['scenarios'] });
      toast.success(`Saved ${s.name}`);
    },
    onError: (e) => toast.error('Save failed', { description: errorText(e) }),
  });
}

export function useDeleteScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteScenario,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scenarios'] }),
    onError: (e) => toast.error('Delete failed', { description: errorText(e) }),
  });
}

/** Loads run history into the live store; again after every stream snapshot (reconnect). */
export function useRunHistory() {
  const store = useStore();
  const snapshots = useLive((s) => s.snapshots);
  const q = useQuery({ queryKey: ['runs', snapshots], queryFn: api.runs, gcTime: 0 });
  useEffect(() => {
    if (q.data) store.dispatch([{ type: 'runs-loaded', runs: q.data }]);
  }, [q.data, store]);
  return q;
}

/** A run's detail; refetched whenever its streamed status changes (and so once it ends). */
export function useRunDetail(id: string | undefined) {
  const status = useLive((s): RunStatus | undefined => (id ? s.runs[id]?.status : undefined));
  return useQuery({
    queryKey: ['run', id, status],
    queryFn: () => api.run(id as string),
    enabled: id !== undefined,
    retry: false,
    placeholderData: (prev) => (prev?.id === id ? prev : undefined),
  });
}

export function useStartRun() {
  const store = useStore();
  return useMutation({
    mutationFn: (body: StartRunBody) => api.startRun(body),
    onSuccess: (run) => store.dispatch([{ type: 'run', run }]),
  });
}

export function useCancelRun() {
  return useMutation({
    mutationFn: api.cancelRun,
    onError: (e) => toast.error('Cancel failed', { description: errorText(e) }),
  });
}

export function useDeleteRun() {
  const store = useStore();
  return useMutation({
    mutationFn: api.deleteRun,
    onSuccess: (_r, id) => store.dispatch([{ type: 'run-removed', id }]),
    onError: (e) => toast.error('Delete failed', { description: errorText(e) }),
  });
}

export const useRecordings = (enabled = true) =>
  useQuery({ queryKey: ['recordings'], queryFn: api.recordings, enabled });

export function useSaveRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.saveRecording,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['recordings'] });
      toast.success(`Saved recording ${r.name}`, { description: `${r.entries} messages` });
    },
    onError: (e) => toast.error('Recording failed', { description: errorText(e) }),
  });
}

export function useDeleteRecording() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteRecording,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['recordings'] }),
    onError: (e) => toast.error('Delete failed', { description: errorText(e) }),
  });
}

/**
 * Loads the test CSMS (sessions and findings) into the live store, after every stream snapshot, and every 1.5 s while
 * the streamed totals count more findings than the store holds: the stream sends at most 50 a second.
 */
export function useCsmsSync() {
  const store = useStore();
  const snapshots = useLive((s) => s.snapshots);
  const behind = useLive(
    (s) => (s.csms?.totals.total ?? 0) > s.csmsViolations.length && s.csmsViolations.length < 2000,
  );
  const q = useQuery({
    queryKey: ['csms', snapshots],
    queryFn: async () => {
      const [view, violations] = await Promise.all([api.csms(), api.csmsViolations(2000)]);
      return { view, violations };
    },
    refetchInterval: behind ? 1500 : false,
    gcTime: 0,
  });
  useEffect(() => {
    if (q.data) store.dispatch([{ type: 'csms-loaded', view: q.data.view, violations: q.data.violations }]);
  }, [q.data, store]);
  return q;
}

export function useStartTestCsms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.startLoopback,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['csms'] }),
    onError: (e) => toast.error('The test CSMS did not start', { description: errorText(e) }),
  });
}

export function useStopTestCsms() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.stopLoopback,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['csms'] });
      void qc.invalidateQueries({ queryKey: ['csms-reports'] });
    },
    onError: (e) => toast.error('Stop failed', { description: errorText(e) }),
  });
}

export const useCsmsReports = () => useQuery({ queryKey: ['csms-reports'], queryFn: api.csmsReports });

export function useSaveCsmsReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name?: string) => api.saveCsmsReport(name),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['csms-reports'] });
      toast.success(`Saved report ${r.name}`);
    },
    onError: (e) => toast.error('Save failed', { description: errorText(e) }),
  });
}

export function useDeleteCsmsReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.deleteCsmsReport,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['csms-reports'] }),
    onError: (e) => toast.error('Delete failed', { description: errorText(e) }),
  });
}

/** CSMS-side frames of one station, polled while shown (the stream does not carry them). */
export function useCsmsFrames(identity: string) {
  return useQuery({
    queryKey: ['csms-frames', identity],
    queryFn: () => api.csmsFrames(identity),
    refetchInterval: 2000,
    retry: false,
  });
}
