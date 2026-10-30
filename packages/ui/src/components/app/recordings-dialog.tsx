import { FileDownIcon, Trash2Icon } from 'lucide-react';
import { downloads } from '@/api/http';
import { useDeleteRecording, useRecordings } from '@/api/server-mode';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Saved session recordings and the traces of scenario runs, as Open OCPP Trace files. */
export function RecordingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const recordings = useRecordings(open);
  const del = useDeleteRecording();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Recordings</DialogTitle>
          <DialogDescription>
            Session recordings you saved and the frames of every scenario run, as Open OCPP Trace (.oot.jsonl). Replay
            one with <span className="font-mono">wattsim replay</span>.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60dvh] overflow-y-auto rounded-md border">
          {recordings.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : !recordings.data?.length ? (
            <p className="p-3 text-muted-foreground text-sm">No recordings yet.</p>
          ) : (
            <ul>
              {recordings.data.map((r) => (
                <li key={r.id} className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-[13px]">{r.name}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {r.kind === 'run' ? 'scenario run' : 'session'} · {r.entries} messages
                      {r.skipped > 0 && ` (${r.skipped} not representable)`} · {size(r.bytes)}
                    </span>
                  </span>
                  <Button asChild variant="outline" size="icon-sm" className="ml-auto">
                    <a href={downloads.recording(r.id)} download aria-label={`Download ${r.name}`}>
                      <FileDownIcon />
                    </a>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => del.mutate(r.id)}
                    disabled={del.isPending}
                  >
                    <Trash2Icon />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
