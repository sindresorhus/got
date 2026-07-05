import http2, {type ServerHttp2Stream} from 'node:http2';
import type net from 'node:net';
import pify from 'pify';
import pem from 'pem';
import type {CreateCertificate} from '../types/pem.js';

const createCertificate = pify(pem.createCertificate as CreateCertificate);

export type Http2TestServer = {
	server: http2.Http2SecureServer;
	sessions: Set<NonNullable<ServerHttp2Stream['session']>>;
	url: string;
	close: () => Promise<void>;
};

export default async function createHttp2TestServer(onStream: (stream: ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void): Promise<Http2TestServer> {
	const certificate = await createCertificate({days: 1, selfSigned: true});
	const server = http2.createSecureServer({
		key: certificate.serviceKey,
		cert: certificate.certificate,
	});
	const sessions = new Set<NonNullable<ServerHttp2Stream['session']>>();

	server.on('stream', onStream);
	server.on('session', session => {
		sessions.add(session);
		session.once('close', () => {
			sessions.delete(session);
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, 'localhost', resolve);
	});

	const {port} = server.address() as net.AddressInfo;

	return {
		server,
		sessions,
		url: `https://localhost:${port}`,
		async close() {
			for (const session of sessions) {
				session.destroy();
			}

			await new Promise<void>((resolve, reject) => {
				server.close(error => {
					if (error) {
						reject(error);
						return;
					}

					resolve();
				});
			});
		},
	};
}
