import assert from 'node:assert/strict';
import http2 from 'node:http2';
import type net from 'node:net';
import {promisify} from 'node:util';
import pem from 'pem';
import got from '../source/index.js';
import test from './helpers/test.js';
import type {CreateCertificate} from './types/pem.js';

const createCertificate = promisify(pem.createCertificate as CreateCertificate);

for (const hostname of ['localhost', '127.0.0.1', '::1']) {
	for (const virtualHost of [undefined, 'virtual.example:8443']) {
		test(`HTTP/2 request.host matches the connection host ${hostname} with Host header ${virtualHost ?? 'default'}`, async t => {
			const certificate = await createCertificate({days: 1, selfSigned: true});
			const server = http2.createSecureServer({
				// eslint-disable-next-line @typescript-eslint/naming-convention
				allowHTTP1: true,
				key: certificate.serviceKey,
				cert: certificate.certificate,
			});
			const sessions = new Set<http2.ServerHttp2Session>();
			server.on('session', session => {
				sessions.add(session);
				session.once('close', () => {
					sessions.delete(session);
				});
			});
			server.on('request', (request, response) => {
				response.end(JSON.stringify({authority: request.headers[':authority'] ?? request.headers.host}));
			});
			t.after(async () => {
				for (const session of sessions) {
					session.destroy();
				}

				if (server.listening) {
					await new Promise<void>((resolve, reject) => {
						server.close(error => {
							if (error) {
								reject(error);
								return;
							}

							resolve();
						});
					});
				}
			});
			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject);
					server.listen(0, hostname, resolve);
				});
			} catch (error) {
				if (hostname === '::1' && ['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
					t.skip('IPv6 loopback is unavailable');
					return;
				}

				throw error;
			}

			const {port} = server.address() as net.AddressInfo;
			const url = `https://${hostname === '::1' ? '[::1]' : hostname}:${port}/`;
			for (const useHttp2 of [false, true]) {
				let requestHost: string | undefined;
				// Both protocols use the same physical endpoint; Host only selects the server's virtual authority.
				// eslint-disable-next-line no-await-in-loop
				const response = await got(url, {
					http2: useHttp2,
					agent: {https: false, http2: false},
					https: {rejectUnauthorized: false},
					retry: {limit: 0},
					headers: virtualHost === undefined ? {} : {host: virtualHost},
				}).on('request', request => {
					requestHost = request.host;
				});
				assert.strictEqual(requestHost, hostname);
				assert.deepStrictEqual(JSON.parse(response.body), {authority: virtualHost ?? new URL(url).host});
			}
		});
	}
}
