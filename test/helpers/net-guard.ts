import net from 'node:net';

const ALLOW = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

type AnyConnect = (...args: unknown[]) => net.Socket;
const original = net.Socket.prototype.connect as unknown as AnyConnect;

function patched(this: net.Socket, ...args: unknown[]): net.Socket {
  let first: unknown = args[0];
  if (Array.isArray(first)) first = first[0];

  let host: string | null;
  if (typeof first === 'object' && first !== null) {
    const options = first as { path?: unknown; host?: unknown };
    if (options.path !== undefined && options.path !== null) {
      host = null; // unix socket / named pipe: local by construction
    } else {
      host = typeof options.host === 'string' ? options.host : 'localhost';
    }
  } else if (typeof args[1] === 'string') {
    host = args[1];
  } else {
    host = 'localhost';
  }

  if (host !== null && !ALLOW.has(host)) {
    throw new Error(`NETWORK-POLICY: blocked connection to ${host}`);
  }
  return original.apply(this, args);
}

net.Socket.prototype.connect = patched as unknown as typeof net.Socket.prototype.connect;

// This module must stay side-effect-only: the preload installs the guard and exports nothing.
export {};
