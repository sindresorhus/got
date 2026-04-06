import http from 'node:http';
import type net from 'node:net';
import express, {type Express, type NextFunction} from 'express';
import bodyParser from 'body-parser';

export type HttpServerOptions = {
	bodyParser?: NextFunction | false;
};

export type ExtendedHttpTestServer = {
	http: http.Server;
	url: string;
	port: number;
	hostname: string;
	close: () => Promise<void>;
} & Express;

const createHttpTestServer = async (options: HttpServerOptions = {}): Promise<ExtendedHttpTestServer> => {
	const server = express() as ExtendedHttpTestServer;
	server.http = http.createServer(server as unknown as http.RequestListener);

	server.set('etag', false);

	if (options.bodyParser !== false) {
		server.use(bodyParser.json({limit: '1mb', type: 'application/json', ...options.bodyParser}));
		server.use(bodyParser.text({limit: '1mb', type: 'text/plain', ...options.bodyParser}));

		server.use(bodyParser.urlencoded({
			limit: '1mb',
			type: 'application/x-www-form-urlencoded',
			extended: true,
			...options.bodyParser,
		}));

		server.use(bodyParser.raw({limit: '1mb', type: 'application/octet-stream', ...options.bodyParser}));
	}

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			reject(error);
		};

		server.http.once('error', onError);
		server.http.listen(0, () => {
			server.http.off('error', onError);
			resolve();
		});
	});
	server.port = (server.http.address() as net.AddressInfo).port;
	server.url = `http://localhost:${server.port}`;
	server.hostname = 'localhost';

	server.close = async () => new Promise<void>((resolve, reject) => {
		server.http.closeAllConnections?.();
		server.http.close(error => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});

	return server;
};

export default createHttpTestServer;
