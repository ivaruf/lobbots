/*
 * authority-worker.js — authority.js in a Web Worker, so a host whose tab is
 * in the background keeps the game going for everyone else (see the header
 * of authority.js for the measurement that made this a rule, hub §8).
 *
 * A thin shell: messages in become calls, emits become messages out. The
 * page side is session.js, which falls back to running authority.js in the
 * page if this worker cannot start.
 */

import { createAuthority } from './authority.js';

let authority = null;

self.onmessage = ({ data }) => {
  if (!data || typeof data !== 'object') return;
  switch (data.type) {
    case 'init':
      authority = createAuthority({
        settings: data.settings,
        specs: data.specs,
        owners: data.owners,
        emit: (msg, to) => self.postMessage({ msg, to }),
        now: () => performance.now(),
      });
      authority.start();
      break;
    case 'input': authority?.input(data.device, data.msg); break;
    case 'speed': authority?.setSpeed(data.v); break;
    case 'drop': authority?.drop(data.device); break;
    case 'stop':
      authority?.stop();
      authority = null;
      self.close();
      break;
    default:
  }
};
