import http from 'node:http';

export interface StubRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface StubServer {
  port: number;
  url: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

export type StubHandler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

/** A localhost HTTP stub. Never reachable from outside 127.0.0.1. */
export function startStub(handler?: StubHandler): Promise<StubServer> {
  const requests: StubRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      });
      if (handler) handler(req, res, body);
      else {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('ok');
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        reject(new Error('stub server did not bind'));
        return;
      }
      resolve({
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
