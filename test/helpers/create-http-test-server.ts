import http from 'http';
import net from 'net';
import express, {Express, NextFunction} from 'express';
import pify from 'pify';
import bodyParser from 'body-parser';

export type HttpServerOptions = {
	bodyParser?: NextFunction | false;
};

export interface ExtendedHttpTestServer extends Express {
	http: http.Server;
	url: string;
	port: number;
	hostname: string;
	close: () => Promise<any>;
}

const createHttpTestServer = async (options: HttpServerOptions = {}): Promise<ExtendedHttpTestServer> => {
	const server = express() as ExtendedHttpTestServer;
	server.http = http.createServer(server);

	server.set('etag', false);

	if (options.bodyParser !== false) {
		server.use(bodyParser.json({limit: '1mb', type: 'application/json', ...options.bodyParser}));
		server.use(bodyParser.text({limit: '1mb', type: 'text/plain', ...options.bodyParser}));
		server.use(bodyParser.urlencoded({limit: '1mb', type: 'application/x-www-form-urlencoded', extended: true, ...options.bodyParser}));
		server.use(bodyParser.raw({limit: '1mb', type: 'application/octet-stream', ...options.bodyParser}));
	}

	await pify(server.http.listen.bind(server.http))();

	server.port = (server.http.address() as net.AddressInfo).port;
	server.url = `http://localhost:${(server.port)}`;
	server.hostname = 'localhost';

	server.close = async () => pify(server.http.close.bind(server.http))();

	return server;
};

export default createHttpTestServer;
