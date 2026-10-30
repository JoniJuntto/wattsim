import type { QuirkPlugin } from '../../src/index';

/** Test plugin: logs each BootNotification the station sends and, on cleanup, how many it saw. */
const plugin: QuirkPlugin = (station, { clock, log }) => {
  let boots = 0;
  const off = station.on('frame', (direction, frame) => {
    if (direction === 'out' && frame.type === 2 && frame.action === 'BootNotification') {
      boots++;
      log(`plugin saw boot at ${clock.now()}`);
    }
  });
  log(`plugin installed on ${station.id}, connected=${station.connected}`);
  return () => {
    off();
    log(`plugin cleanup after ${boots} boot(s)`);
  };
};

export default plugin;
